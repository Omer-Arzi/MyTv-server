// One-off repair for MyTV's "Re: ZERO, Starting Life in Another World"
// duplicate-episode-row bug -- see rezero-duplicate-episode-merge-logic.ts's
// header comment for the full investigation and the hand-verified
// legacy-season -> absolute-episode-number offset this relies on. NOT a
// reusable tool (same posture as manual-progress-corrections/).
//
// Default mode is DRY RUN: loads live data, builds the merge plan, prints
// it in full (every affected episode/watch row, before and after), writes
// nothing. Apply mode requires the explicit --apply-rezero-merge flag.
//
// What apply mode does, inside a single transaction:
// 1. For each action needing it, delete the Season-1 survivor's own watch
//    row (the synthetic 2026-07-12 batch-reconciliation one).
// 2. Re-point each legacy watch row's episodeId to its survivor -- this
//    PRESERVES the watch's real id, watchedAt, rewatchCount,
//    watchDateApproximate, watchSource, importBatchId, and rawMetadata
//    exactly; nothing about the watch itself is recreated.
// 3. Delete every legacy Episode row (now watch-free either way).
// 4. Delete the now-empty legacy Season rows (2, 3, 4).
// Never touches Season 1's own episodes, EpisodeWatch rows outside this
// series, or UserSeriesProgress directly -- if nextEpisodeId ever pointed
// at a row being deleted, the schema's ON DELETE SET NULL handles it
// safely, but this script does not rely on or need that (verified
// beforehand that production's nextEpisodeId is already null/CAUGHT_UP,
// unaffected either way).

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { buildReZeroMergePlan, LegacyEpisodeInput, REZERO_SERIES_ID, SurvivorEpisodeInput, WatchInfo } from './rezero-duplicate-episode-merge-logic';

const APPLY_FLAG = '--apply-rezero-merge';

function parseArgs(argv: string[]): { apply: boolean } {
  if (argv.includes('--apply') && !argv.includes(APPLY_FLAG)) {
    console.log(`Note: bare --apply is not the trigger for this script. Re-run with ${APPLY_FLAG} to actually write. Continuing as dry-run.`);
  }
  return { apply: argv.includes(APPLY_FLAG) };
}

function toWatchInfo(w: { id: string; watchedAt: Date; rewatchCount: number; watchDateApproximate: boolean; watchSource: string; importBatchId: string | null; rawMetadata: unknown } | null): WatchInfo | null {
  if (!w) return null;
  return { id: w.id, watchedAt: w.watchedAt.toISOString(), rewatchCount: w.rewatchCount, watchDateApproximate: w.watchDateApproximate, watchSource: w.watchSource, importBatchId: w.importBatchId, rawMetadata: w.rawMetadata };
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  console.log(`Re:Zero Duplicate-Episode Merge — mode: ${apply ? 'APPLY (writes will happen)' : 'DRY RUN (no writes)'}`);

  const series = await prisma.series.findUnique({ where: { id: REZERO_SERIES_ID }, select: { id: true, title: true } });
  if (!series) {
    console.error(`Series ${REZERO_SERIES_ID} not found in this database -- refusing to proceed.`);
    process.exit(1);
  }
  console.log(`  series: ${series.title} (${series.id})`);

  const seasons = await prisma.season.findMany({
    where: { seriesId: REZERO_SERIES_ID },
    select: {
      id: true,
      seasonNumber: true,
      episodes: { select: { id: true, episodeNumber: true, watches: { select: { id: true, watchedAt: true, rewatchCount: true, watchDateApproximate: true, watchSource: true, importBatchId: true, rawMetadata: true } } } },
    },
  });

  const season1 = seasons.find((s) => s.seasonNumber === 1);
  if (!season1) {
    console.error('Season 1 not found -- refusing to proceed (nothing to merge legacy episodes into).');
    process.exit(1);
  }

  const survivorEpisodesByNumber = new Map<number, SurvivorEpisodeInput>();
  for (const ep of season1.episodes) {
    if (ep.watches.length > 1) {
      console.error(`Season 1 episode ${ep.episodeNumber} (id ${ep.id}) has ${ep.watches.length} watch rows -- expected at most 1. Refusing to proceed (unexpected data, safeguard: stop rather than guess).`);
      process.exit(1);
    }
    survivorEpisodesByNumber.set(ep.episodeNumber, { id: ep.id, episodeNumber: ep.episodeNumber, watch: toWatchInfo(ep.watches[0] ?? null) });
  }

  const legacyEpisodes: LegacyEpisodeInput[] = [];
  for (const season of seasons) {
    if (season.seasonNumber === 1) continue;
    for (const ep of season.episodes) {
      if (ep.watches.length > 1) {
        console.error(`Legacy episode S${season.seasonNumber}E${ep.episodeNumber} (id ${ep.id}) has ${ep.watches.length} watch rows -- expected at most 1. Refusing to proceed.`);
        process.exit(1);
      }
      legacyEpisodes.push({ id: ep.id, seasonId: season.id, seasonNumber: season.seasonNumber, episodeNumber: ep.episodeNumber, watch: toWatchInfo(ep.watches[0] ?? null) });
    }
  }

  const plan = buildReZeroMergePlan({ legacyEpisodes, survivorEpisodesByNumber });

  console.log(`\n  legacy episodes found: ${legacyEpisodes.length}`);
  console.log(`  merge actions planned: ${plan.actions.length}`);
  console.log(`  seasons to remove: ${plan.seasonsToRemove.map((s) => `S${s.seasonNumber} (${s.legacyEpisodeIds.length} episodes)`).join(', ') || 'none'}`);
  if (plan.warnings.length > 0) {
    console.log(`\n  WARNINGS (these episodes are left untouched):`);
    for (const w of plan.warnings) console.log(`    - ${w}`);
  }

  console.log(`\n  Full plan:`);
  for (const a of plan.actions) {
    const watchDesc =
      a.kind === 'replace_survivor_watch_with_legacy'
        ? `DELETE survivor watch (id ${a.survivorWatchToDelete!.id}, watchedAt ${a.survivorWatchToDelete!.watchedAt}) then MOVE legacy watch (id ${a.legacyWatch!.id}, watchedAt ${a.legacyWatch!.watchedAt}) onto survivor`
        : a.kind === 'move_watch_no_conflict'
          ? `MOVE legacy watch (id ${a.legacyWatch!.id}, watchedAt ${a.legacyWatch!.watchedAt}) onto survivor (no existing survivor watch)`
          : `no watch on either side -- just remove legacy episode row`;
    console.log(`    [${a.kind}] ${a.legacyLabel} (id ${a.legacyEpisodeId}) -> ${a.survivorLabel} (id ${a.survivorEpisodeId}): ${watchDesc}`);
  }

  if (plan.actions.length === 0) {
    console.log('\nNothing to do.');
    await prisma.$disconnect();
    return;
  }

  if (!apply) {
    console.log(`\nDry run complete. Re-run with ${APPLY_FLAG} to actually apply this plan.`);
    await prisma.$disconnect();
    return;
  }

  console.log('\nApplying...');
  await prisma.$transaction(async (tx) => {
    for (const a of plan.actions) {
      if (a.kind === 'replace_survivor_watch_with_legacy') {
        await tx.episodeWatch.delete({ where: { id: a.survivorWatchToDelete!.id } });
      }
      if (a.kind === 'replace_survivor_watch_with_legacy' || a.kind === 'move_watch_no_conflict') {
        await tx.episodeWatch.update({ where: { id: a.legacyWatch!.id }, data: { episodeId: a.survivorEpisodeId } });
      }
    }

    const allLegacyEpisodeIds = plan.actions.map((a) => a.legacyEpisodeId);
    const deletedEpisodes = await tx.episode.deleteMany({ where: { id: { in: allLegacyEpisodeIds } } });
    console.log(`  deleted ${deletedEpisodes.count} legacy episode rows`);

    for (const removal of plan.seasonsToRemove) {
      const remaining = await tx.episode.count({ where: { seasonId: removal.seasonId } });
      if (remaining > 0) {
        throw new Error(`Season ${removal.seasonNumber} (id ${removal.seasonId}) still has ${remaining} episode(s) after deletion -- refusing to delete the season row. Transaction rolled back.`);
      }
      await tx.season.delete({ where: { id: removal.seasonId } });
      console.log(`  deleted season S${removal.seasonNumber} (id ${removal.seasonId})`);
    }
  });

  console.log('\nDone.');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
