// Rewrites watch-next-decisions.json's mytvSeriesId/reviewedNextEpisodeId
// fields to match the CURRENT database. Read-only against app tables —
// only writes a new decisions JSON file alongside the original. See
// remap-decisions.ts's header for why this exists (same class of problem
// as tmdb-enrichment/run-remap-apply-plan.ts, one full DB rebuild later).
//
// Refuses to write anything if any mark_caught_up decision's series or
// episode position can't be resolved in the current database — a partial
// remap would silently apply fewer decisions than intended.

import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { DecisionToRemap, remapDecisions, ReviewedEpisodePosition } from './remap-decisions';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');

interface CliOptions {
  decisionsPath: string;
  reviewPath: string;
  outPath?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    decisionsPath: path.join(DEFAULT_OUT_DIR, 'watch-next-decisions.json'),
    reviewPath: path.join(DEFAULT_OUT_DIR, 'watch-next-manual-review.json'),
  };
  for (const arg of argv) {
    if (arg.startsWith('--decisions=')) options.decisionsPath = path.resolve(arg.slice('--decisions='.length));
    else if (arg.startsWith('--review=')) options.reviewPath = path.resolve(arg.slice('--review='.length));
    else if (arg.startsWith('--out=')) options.outPath = path.resolve(arg.slice('--out='.length));
  }
  return options as CliOptions;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  for (const p of [options.decisionsPath, options.reviewPath]) {
    if (!existsSync(p)) {
      console.error(`File not found: ${p}`);
      process.exit(1);
    }
  }

  const decisionsFile = JSON.parse(readFileSync(options.decisionsPath, 'utf-8'));
  const reviewFile = JSON.parse(readFileSync(options.reviewPath, 'utf-8'));

  const decisions: DecisionToRemap[] = decisionsFile.decisions ?? [];
  const reviewedPositions: ReviewedEpisodePosition[] = (reviewFile.items ?? []).map((item: { seriesTitle: string; currentNextEpisode: { seasonNumber: number; episodeNumber: number } }) => ({
    seriesTitle: item.seriesTitle,
    seasonNumber: item.currentNextEpisode.seasonNumber,
    episodeNumber: item.currentNextEpisode.episodeNumber,
  }));

  console.log(`Loaded ${decisions.length} decisions from ${options.decisionsPath}`);
  console.log(`Loaded ${reviewedPositions.length} reviewed episode positions from ${options.reviewPath}`);

  const prisma = new PrismaClient();
  const [currentSeries, currentEpisodes] = await Promise.all([
    prisma.series.findMany({ select: { id: true, title: true } }),
    prisma.episode.findMany({
      select: { id: true, episodeNumber: true, season: { select: { seriesId: true, seasonNumber: true } } },
    }),
  ]);
  await prisma.$disconnect();

  const result = remapDecisions(
    decisions,
    currentSeries.map((s) => ({ title: s.title, seriesId: s.id })),
    currentEpisodes.map((e) => ({ seriesId: e.season.seriesId, seasonNumber: e.season.seasonNumber, episodeNumber: e.episodeNumber, episodeId: e.id })),
    reviewedPositions,
  );

  console.log(`\nSeries remapped: ${result.remappedSeriesIds.length}`);
  console.log(`Episode ids remapped: ${result.remappedEpisodeIds.length}`);
  console.log(`Unmatched series titles: ${result.unmatchedSeriesTitles.length}`);
  console.log(`Ambiguous series titles: ${result.ambiguousSeriesTitles.length}`);
  console.log(`mark_caught_up decisions with unresolved episode position: ${result.unmatchedEpisodesForMarkCaughtUp.length}`);

  if (result.unmatchedSeriesTitles.length > 0) console.log('\nUnmatched series:', result.unmatchedSeriesTitles);
  if (result.ambiguousSeriesTitles.length > 0) console.log('\nAmbiguous series:', result.ambiguousSeriesTitles);
  if (result.unmatchedEpisodesForMarkCaughtUp.length > 0) console.log('\nmark_caught_up with unresolved episode:', result.unmatchedEpisodesForMarkCaughtUp);

  // A series can legitimately be gone from the database (e.g. the demo/mock
  // series removed during recovery) without that blocking the remap — its
  // decision was never mark_caught_up in the first place, so nothing at
  // apply time will ever need its id. Only refuse when a mark_caught_up
  // decision specifically can't be fully resolved: that's the one case
  // where a partial remap would silently apply fewer decisions than intended.
  const markCaughtUpTitles = new Set(decisions.filter((d) => d.decision === 'mark_caught_up').map((d) => d.seriesTitle));
  const blockingUnmatched = result.unmatchedSeriesTitles.filter((t) => markCaughtUpTitles.has(t));
  const blockingAmbiguous = result.ambiguousSeriesTitles.filter((t) => markCaughtUpTitles.has(t));

  if (blockingUnmatched.length > 0 || blockingAmbiguous.length > 0 || result.unmatchedEpisodesForMarkCaughtUp.length > 0) {
    console.error('\nRefusing to write a remapped decisions file: a mark_caught_up decision did not resolve cleanly. Fix the mismatch and re-run.');
    if (blockingUnmatched.length > 0) console.error('  unmatched mark_caught_up series:', blockingUnmatched);
    if (blockingAmbiguous.length > 0) console.error('  ambiguous mark_caught_up series:', blockingAmbiguous);
    process.exit(1);
  }

  const outPath = options.outPath ?? path.join(path.dirname(options.decisionsPath), 'watch-next-decisions-remapped.json');
  writeFileSync(outPath, JSON.stringify({ ...decisionsFile, decisions: result.decisions }, null, 2));
  console.log(`\nAll decisions remapped cleanly. Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
