// Library Health report — READ-ONLY. See the task this was built for: an
// internal system that classifies every series into actionable data-health
// categories, without relying on ad hoc developer scripts or manual
// inspection to answer "which series are ready, which are risky, what
// needs to happen next."
//
// This script NEVER writes to the database and NEVER calls a provider API
// (unlike episode-release-refresh/run-refresh.ts) — every signal it uses is
// already in Postgres. Safe to run manually at any time, as often as you like.

import 'dotenv/config';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { classifySeriesHealth, LocalEpisodeHealthInput, SeriesHealthInput } from './health-logic';
import { buildLibraryHealthReport, buildMarkdownReport, writeLibraryHealthReports } from './reports';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');

interface CliOptions {
  userId: string;
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('--apply')) {
    console.error(
      'library-health does not support --apply and never will as currently scoped — this report is read-only ' +
        'by design (no DB writes, no provider writes). Re-run without --apply.',
    );
    process.exit(1);
  }

  const options: CliOptions = { userId: DEV_USER_ID, outDir: DEFAULT_OUT_DIR };
  for (const arg of argv) {
    if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
  }
  return options;
}

async function loadSeriesHealthInputs(prisma: PrismaClient, userId: string): Promise<SeriesHealthInput[]> {
  const [allSeries, watches] = await Promise.all([
    prisma.series.findMany({
      select: {
        id: true,
        title: true,
        releaseStatus: true,
        posterUrl: true,
        backdropUrl: true,
        externalIds: { select: { tmdbId: true, provider: true, providerId: true, matchConfidence: true, matchSource: true } },
        seasons: {
          select: {
            seasonNumber: true,
            episodes: { select: { id: true, episodeNumber: true, title: true, airDate: true } },
          },
        },
        progress: { where: { userId }, select: { userStatus: true, nextEpisodeId: true, lastWatchedAt: true } },
      },
    }),
    prisma.episodeWatch.findMany({ where: { userId }, select: { episodeId: true } }),
  ]);

  const watchedEpisodeIds = new Set(watches.map((w) => w.episodeId));

  return allSeries.map((series) => {
    const episodes: LocalEpisodeHealthInput[] = series.seasons.flatMap((season) =>
      season.episodes.map((ep) => ({
        id: ep.id,
        seasonNumber: season.seasonNumber,
        episodeNumber: ep.episodeNumber,
        title: ep.title,
        airDate: ep.airDate,
        watched: watchedEpisodeIds.has(ep.id),
      })),
    );

    return {
      seriesId: series.id,
      title: series.title,
      releaseStatus: series.releaseStatus,
      posterUrl: series.posterUrl,
      backdropUrl: series.backdropUrl,
      externalIds: series.externalIds
        ? {
            tmdbId: series.externalIds.tmdbId,
            provider: series.externalIds.provider,
            providerId: series.externalIds.providerId,
            matchConfidence: series.externalIds.matchConfidence,
            matchSource: series.externalIds.matchSource,
          }
        : null,
      episodes,
      progress: series.progress[0]
        ? { userStatus: series.progress[0].userStatus, nextEpisodeId: series.progress[0].nextEpisodeId, lastWatchedAt: series.progress[0].lastWatchedAt }
        : null,
    };
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  const generatedAt = new Date();

  console.log('Library Health report — READ-ONLY (no DB writes, no provider calls)');
  console.log(`  target user: ${options.userId}`);

  const inputs = await loadSeriesHealthInputs(prisma, options.userId);
  console.log(`  series inspected: ${inputs.length}`);

  const results = inputs.map((input) => classifySeriesHealth({ ...input, now: generatedAt }));

  const report = buildLibraryHealthReport({ generatedAt, targetUserId: options.userId, series: results });
  const markdown = buildMarkdownReport(report);
  const written = writeLibraryHealthReports(options.outDir, report, markdown);

  console.log(`\nDone. Reports written:`);
  console.log(`  ${written.latestJsonPath}`);
  console.log(`  ${written.latestMarkdownPath}`);
  console.log(`  ${written.archivedJsonPath}`);
  console.log(`  ${written.archivedMarkdownPath}`);
  console.log('\nSummary:');
  console.log(JSON.stringify(report.summary, null, 2));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
