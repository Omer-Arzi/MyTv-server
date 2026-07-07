// Targeted, single-series TMDb enrichment apply — for a specific series a
// reviewer has manually confirmed is the right match, deliberately outside
// the batch safeApplyCandidates flow (run-apply-plan.ts), because that
// flow's validation requires watchedEpisodeCount === tmdbTotalEpisodeCount
// (only fully-finished series). This tool is for the opposite, and equally
// common, case: an ongoing series whose catalog is missing everything past
// what the user happened to watch, because it was never enriched.
//
// Reuses planCandidateUpdate/writeCandidateUpdate from apply-plan.ts
// directly — same TMDb-fetch/cache logic, same Series/Season/Episode/
// ExternalIds write shape — only the safety gate differs
// (single-series-safety.ts instead of apply-plan-validation.ts).
//
// After the catalog write, additionally computes nextEpisodeId via the
// exact same deriveNextEpisodeUpdate the next-episode-backfill uses, since
// planCandidateUpdate/writeCandidateUpdate never touch nextEpisodeId at all
// (that's normally a separate backfill pass) — folded into one dry-run/
// apply report here because the task is "enrich this one series
// completely," not "enrich, then remember to backfill separately."
//
// Default mode is dry-run. Real writes require --apply.

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { PrismaClient, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { TmdbClient } from './tmdb-client';
import { planCandidateUpdate, writeCandidateUpdate } from './apply-plan';
import { ApplyPlanCandidate } from './apply-plan-types';
import { validateSingleSeriesCandidate } from './single-series-safety';
import { deriveNextEpisodeUpdate, OrderedEpisode } from '../next-episode-backfill/derive-next-episode';
import { DEV_USER_ID } from '../src/common/constants';

const APPLY_BATCH_SOURCE = 'tmdb-enrichment-single-series-apply';
const DEFAULT_OUT_DIR = path.join(__dirname, 'output', 'single-series');

interface CliOptions {
  seriesId: string;
  tmdbId: string;
  userId: string;
  apply: boolean;
  tier: 'AUTO_MATCH' | 'NEEDS_REVIEW';
  closeCompetitorDetected: boolean;
  animeNumberingRiskDetected: boolean;
  isDataQualityFlagged: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    userId: DEV_USER_ID,
    apply: false,
    tier: 'NEEDS_REVIEW',
    closeCompetitorDetected: false,
    animeNumberingRiskDetected: false,
    isDataQualityFlagged: false,
    force: false,
  };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--force') options.force = true;
    else if (arg.startsWith('--series-id=')) options.seriesId = arg.slice('--series-id='.length);
    else if (arg.startsWith('--tmdb-id=')) options.tmdbId = arg.slice('--tmdb-id='.length);
    else if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
  }
  if (!options.seriesId || !options.tmdbId) {
    console.error('Usage: run-single-series-apply.ts --series-id=<uuid> --tmdb-id=<id> [--apply] [--force]');
    process.exit(1);
  }
  return options as CliOptions;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const accessToken = process.env.TMDB_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('Missing TMDB_ACCESS_TOKEN — set it in .env. No request is made without it.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const tmdb = new TmdbClient({ accessToken });

  const series = await prisma.series.findUnique({
    where: { id: options.seriesId },
    include: { externalIds: true },
  });
  if (!series) {
    console.error(`Series ${options.seriesId} not found.`);
    await prisma.$disconnect();
    process.exit(1);
  }

  const watchedEpisodeCount = await prisma.episodeWatch.count({
    where: { userId: options.userId, episode: { season: { seriesId: options.seriesId } } },
  });

  // Read the REAL current status rather than assuming WATCHING — a series
  // can have zero watch history and no UserSeriesProgress row at all (e.g.
  // sitting unwatched with no tracking relationship yet), in which case
  // proposing WATCHING would incorrectly create tracking state for a show
  // the user never actually started. Only propose WATCHING when there's
  // real watch activity; otherwise the proposal is a no-op (same as
  // current), so decideUserStatusUpdate correctly makes no change.
  const existingProgress = await prisma.userSeriesProgress.findUnique({
    where: { userId_seriesId: { userId: options.userId, seriesId: options.seriesId } },
  });
  const currentUserStatus = existingProgress?.userStatus ?? UserSeriesStatus.UNKNOWN;
  const proposedUserStatusAfterEnrichment = watchedEpisodeCount > 0 ? UserSeriesStatus.WATCHING : currentUserStatus;

  console.log(`Targeted single-series apply — mode: ${options.apply ? 'REAL APPLY' : 'DRY RUN (default)'}`);
  console.log(`  series: "${series.title}" (${series.id})`);
  console.log(`  tmdbId: ${options.tmdbId}`);
  console.log(`  current watched episode count: ${watchedEpisodeCount}`);
  console.log(`  current userStatus: ${currentUserStatus}${existingProgress ? '' : ' (no UserSeriesProgress row exists)'}`);
  console.log(`  already enriched: ${series.externalIds?.tmdbId != null ? `yes (tmdbId ${series.externalIds.tmdbId})` : 'no'}`);
  if (!options.apply) console.log('  Default mode is dry-run: nothing will be written. Pass --apply to write for real.');

  const candidate: ApplyPlanCandidate = {
    mytvSeriesId: series.id,
    mytvSeriesTitle: series.title,
    realTier: options.tier,
    proposedTierAfterStructuralRule: null,
    tmdbId: options.tmdbId,
    tmdbTitle: series.title,
    tmdbYear: null,
    watchedEpisodeCount,
    tmdbTotalEpisodeCount: 0, // filled in after the TMDb fetch below
    animeNumberingRiskDetected: options.animeNumberingRiskDetected,
    closeCompetitorDetected: options.closeCompetitorDetected,
    closeCompetitorReason: null,
    currentUserStatus,
    proposedUserStatusAfterEnrichment,
    proposedReleaseStatus: ReleaseStatus.UNKNOWN,
  };

  // Cache writes (ImportRawRow) for a live TMDb fetch are handled by the
  // real apply's own transaction below (writeBatchId there), not here —
  // this planning call never persists a cache row itself, dry-run or not.
  const cacheOptions = { allowFetch: true, force: options.force };

  const planned = await planCandidateUpdate(prisma, tmdb, null, candidate, options.userId, cacheOptions);

  if (planned.status !== 'ready') {
    console.error(`\nCannot plan this candidate: ${planned.reason}`);
    await prisma.$disconnect();
    process.exit(1);
  }

  const tmdbTotalEpisodeCount = planned.episodes!.length;
  const safety = validateSingleSeriesCandidate({
    tier: options.tier,
    closeCompetitorDetected: options.closeCompetitorDetected,
    animeNumberingRiskDetected: options.animeNumberingRiskDetected,
    isDataQualityFlagged: options.isDataQualityFlagged,
    watchedEpisodeCount,
    providerTotalEpisodeCount: tmdbTotalEpisodeCount,
  });

  console.log(`\nSafety check: ${safety.safe ? 'PASSED' : 'FAILED'}`);
  for (const v of safety.violations) console.log(`  - ${v}`);
  if (!safety.safe) {
    console.error('\nRefusing to proceed: this candidate failed the single-series safety check.');
    await prisma.$disconnect();
    process.exit(1);
  }

  // Which planned episodes are new vs. already in the DB (existing ones
  // just get title/airDate/imageUrl filled in; nothing is ever deleted).
  const existingEpisodes = await prisma.episode.findMany({
    where: { season: { seriesId: series.id } },
    select: { id: true, episodeNumber: true, title: true, season: { select: { seasonNumber: true } } },
  });
  const existingKey = new Set(existingEpisodes.map((e) => `${e.season.seasonNumber}:${e.episodeNumber}`));
  const newEpisodePlans = planned.episodes!.filter((e) => !existingKey.has(`${e.seasonNumber}:${e.episodeNumber}`));
  const updatedEpisodePlans = planned.episodes!.filter((e) => existingKey.has(`${e.seasonNumber}:${e.episodeNumber}`));

  console.log('\n--- Series ---');
  console.log(`  title: ${planned.series!.newTitle ? `"${planned.series!.currentTitle}" -> "${planned.series!.newTitle}"` : `unchanged ("${planned.series!.currentTitle}")`}`);
  console.log(`  posterUrl -> ${planned.series!.posterUrl ?? 'unchanged'}`);
  console.log(`  backdropUrl -> ${planned.series!.backdropUrl ?? 'unchanged'}`);
  console.log(`  releaseStatus -> ${planned.series!.releaseStatus}`);
  console.log('\n--- ExternalIds ---');
  console.log(`  tmdbId -> ${planned.externalIds!.tmdbId} (matchSource: ${planned.externalIds!.matchSource})`);
  console.log('\n--- Seasons/Episodes ---');
  console.log(`  seasons: ${planned.seasons!.length}`);
  console.log(`  episodes total (from provider): ${planned.episodes!.length}`);
  console.log(`  episodes that ALREADY exist and would be updated (title/airDate/imageUrl filled in, never deleted): ${updatedEpisodePlans.length}`);
  for (const e of updatedEpisodePlans) console.log(`    S${e.seasonNumber}E${e.episodeNumber} — "${e.title}" (${e.airDate ?? 'no airDate'})`);
  console.log(`  episodes that would be newly created (previously unwatched, missing from our catalog entirely): ${newEpisodePlans.length}`);
  for (const e of newEpisodePlans) console.log(`    S${e.seasonNumber}E${e.episodeNumber} — "${e.title}" (${e.airDate ?? 'no airDate'})`);

  console.log('\n--- Existing watches ---');
  console.log(`  ${watchedEpisodeCount} EpisodeWatch rows for this series — none touched, none deleted by this tool.`);

  // Merge existing + planned-new episodes into one ordered list to preview
  // (dry-run) or compute-for-real (apply) what nextEpisodeId becomes —
  // exactly the same decision next-episode-backfill would make, just
  // computed here so this one series doesn't need a separate backfill run.
  const watchedRows = await prisma.episodeWatch.findMany({
    where: { userId: options.userId, episode: { season: { seriesId: series.id } } },
    select: { episodeId: true },
  });
  const watchedIds = new Set(watchedRows.map((w) => w.episodeId));

  const mergedForPreview: OrderedEpisode[] = [
    ...existingEpisodes.map((e) => ({ id: e.id, airDate: updatedEpisodePlans.find((p) => p.seasonNumber === e.season.seasonNumber && p.episodeNumber === e.episodeNumber)?.airDate ? new Date(updatedEpisodePlans.find((p) => p.seasonNumber === e.season.seasonNumber && p.episodeNumber === e.episodeNumber)!.airDate!) : null })),
    ...newEpisodePlans.map((e) => ({ id: `NEW:S${e.seasonNumber}E${e.episodeNumber}`, airDate: e.airDate ? new Date(e.airDate) : null })),
  ];
  // Sort by season/episode number (same ordering convention used everywhere
  // else in this codebase) — derive from the planned list's own ordering.
  const orderIndex = new Map(planned.episodes!.map((e, i) => [`${e.seasonNumber}:${e.episodeNumber}`, i]));
  const seasonEpisodeById = new Map<string, string>([
    ...existingEpisodes.map((e) => [e.id, `${e.season.seasonNumber}:${e.episodeNumber}`] as const),
    ...newEpisodePlans.map((e) => [`NEW:S${e.seasonNumber}E${e.episodeNumber}`, `${e.seasonNumber}:${e.episodeNumber}`] as const),
  ]);
  mergedForPreview.sort((a, b) => (orderIndex.get(seasonEpisodeById.get(a.id)!) ?? 0) - (orderIndex.get(seasonEpisodeById.get(b.id)!) ?? 0));

  const nextEpisodeDecision = deriveNextEpisodeUpdate({
    currentUserStatus,
    releaseStatus: planned.series!.releaseStatus,
    hasFullCatalog: true,
    orderedEpisodes: mergedForPreview,
    watchedEpisodeIds: watchedIds,
  });

  console.log('\n--- UserSeriesProgress.userStatus ---');
  console.log(`  ${planned.userStatus!.shouldUpdate ? `${planned.userStatus!.currentLiveStatus} -> ${planned.userStatus!.proposedUserStatus}` : `unchanged (${planned.userStatus!.reason})`}`);

  console.log('\n--- nextEpisodeId ---');
  console.log(`  action: ${nextEpisodeDecision.action}`);
  console.log(`  reason: ${nextEpisodeDecision.reason}`);
  if (nextEpisodeDecision.nextEpisodeId) {
    const label = nextEpisodeDecision.nextEpisodeId.startsWith('NEW:')
      ? `${nextEpisodeDecision.nextEpisodeId.slice(4)} (newly created by this apply)`
      : `existing episode id ${nextEpisodeDecision.nextEpisodeId}`;
    console.log(`  would become: ${label}`);
  } else {
    console.log('  would become: null (no released, unwatched episode found)');
  }
  console.log(`  userStatus: ${nextEpisodeDecision.newUserStatus ?? '(unchanged)'}`);

  const report = {
    generatedAt: new Date().toISOString(),
    mode: options.apply ? 'apply' : 'dry-run',
    writesToAppTables: options.apply,
    seriesId: series.id,
    seriesTitle: series.title,
    tmdbId: options.tmdbId,
    safety,
    planned: {
      series: planned.series,
      externalIds: planned.externalIds,
      seasons: planned.seasons,
      episodesUpdated: updatedEpisodePlans,
      episodesCreated: newEpisodePlans,
      userStatus: planned.userStatus,
    },
    watchedEpisodeCountPreserved: watchedEpisodeCount,
    nextEpisodeDecision,
  };

  mkdirSync(DEFAULT_OUT_DIR, { recursive: true });
  const reportPath = path.join(DEFAULT_OUT_DIR, options.apply ? `${series.id}-apply-report.json` : `${series.id}-dry-run-report.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${reportPath}`);

  if (!options.apply) {
    await prisma.$disconnect();
    return;
  }

  // Real apply: write the catalog, then re-derive nextEpisodeId against the
  // ACTUAL post-write database state (real episode ids, not the "NEW:..."
  // placeholders used for the dry-run preview above).
  await prisma.$transaction(
    async (tx) => {
      const batch = await tx.importBatch.create({ data: { source: APPLY_BATCH_SOURCE, status: 'RUNNING', startedAt: new Date() } });

      await writeCandidateUpdate(tx, batch.id, options.userId, planned);

      const finalEpisodes = await tx.episode.findMany({
        where: { season: { seriesId: series.id } },
        select: { id: true, airDate: true, episodeNumber: true, season: { select: { seasonNumber: true } } },
        orderBy: [{ season: { seasonNumber: 'asc' } }, { episodeNumber: 'asc' } as const],
      });
      const finalWatched = await tx.episodeWatch.findMany({ where: { userId: options.userId, episode: { season: { seriesId: series.id } } }, select: { episodeId: true } });
      const finalWatchedIds = new Set(finalWatched.map((w) => w.episodeId));

      const finalProgress = await tx.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId: options.userId, seriesId: series.id } } });
      const finalCurrentUserStatus = finalProgress?.userStatus ?? UserSeriesStatus.UNKNOWN;

      const finalDecision = deriveNextEpisodeUpdate({
        currentUserStatus: finalCurrentUserStatus,
        releaseStatus: planned.series!.releaseStatus,
        hasFullCatalog: true,
        orderedEpisodes: finalEpisodes.map((e) => ({ id: e.id, airDate: e.airDate })),
        watchedEpisodeIds: finalWatchedIds,
      });

      // Only touch UserSeriesProgress if there's an actual row to update
      // (a series with zero watch history and no prior tracking
      // relationship — e.g. sitting unenriched with nothing ever watched —
      // has none, and enrichment alone should never create one) and only
      // when something genuinely changed, to avoid a no-op write.
      if (finalProgress && (finalDecision.nextEpisodeId !== finalProgress.nextEpisodeId || (finalDecision.newUserStatus && finalDecision.newUserStatus !== finalProgress.userStatus))) {
        await tx.userSeriesProgress.update({
          where: { userId_seriesId: { userId: options.userId, seriesId: series.id } },
          data: {
            nextEpisodeId: finalDecision.nextEpisodeId,
            userStatus: finalDecision.newUserStatus ?? undefined,
          },
        });
      }

      await tx.importBatch.update({ where: { id: batch.id }, data: { status: 'COMPLETED', finishedAt: new Date() } });

      console.log(`\nApplied. Final nextEpisodeId: ${finalDecision.nextEpisodeId ?? 'null'}, userStatus: ${finalDecision.newUserStatus ?? '(unchanged)'}`);
    },
    { maxWait: 10_000, timeout: 60_000 },
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
