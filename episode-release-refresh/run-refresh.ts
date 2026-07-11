// Episode release refresh — dry run ONLY. See
// docs/episode-release-refresh-strategy.md for the design this implements
// and why apply mode does not exist yet.
//
// This script NEVER writes to the database. It fetches each eligible
// series' current TMDb catalog, compares it against what's already stored,
// and reports what an eventual apply step WOULD do — new episodes, field
// changes, nextEpisodeId/userStatus recomputation — without doing any of
// it. Safe to run manually at any time, as often as you like.

import 'dotenv/config';
import path from 'path';
import { PrismaClient, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { MAX_APPEND_TO_RESPONSE_ITEMS, TmdbClient, TmdbRequestError } from '../tmdb-enrichment/tmdb-client';
import { getAppendedSeason, TmdbSeason } from '../tmdb-enrichment/tmdb-types';
import { mapTmdbStatusToReleaseStatus } from '../tmdb-enrichment/release-status-mapping';
import { DEV_USER_ID } from '../src/common/constants';
import {
  checkSeriesEligibility,
  chunkArray,
  compareSeriesCatalog,
  LocalEpisodeInput,
  ProviderEpisodeInput,
} from './refresh-logic';
import { buildMarkdownReport, buildRefreshReport, RefreshedSeriesEntry, SkippedSeriesEntry, writeRefreshReports } from './reports';
import { classifyRefreshOperatingOutcome } from './refresh-operating-outcome';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');

interface CliOptions {
  userId: string;
  limit?: number;
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('--apply')) {
    console.error(
      'episode-release-refresh does not support --apply yet. This pipeline is dry-run-only by design ' +
        '(see docs/episode-release-refresh-strategy.md §4) — an apply mode is a deliberate future step, ' +
        'not implemented here. Re-run without --apply.',
    );
    process.exit(1);
  }

  const options: CliOptions = { userId: DEV_USER_ID, outDir: DEFAULT_OUT_DIR };
  for (const arg of argv) {
    if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice('--limit='.length));
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
  }
  return options;
}

interface SeriesRow {
  id: string;
  title: string;
  releaseStatus: ReleaseStatus;
  tmdbId: string | null;
  userStatus: UserSeriesStatus;
  nextEpisodeId: string | null;
  episodes: LocalEpisodeInput[];
}

async function loadCandidateSeries(prisma: PrismaClient, userId: string): Promise<SeriesRow[]> {
  const progresses = await prisma.userSeriesProgress.findMany({
    where: { userId },
    select: {
      userStatus: true,
      nextEpisodeId: true,
      series: {
        select: {
          id: true,
          title: true,
          releaseStatus: true,
          externalIds: { select: { tmdbId: true } },
          seasons: {
            select: {
              seasonNumber: true,
              episodes: { select: { id: true, episodeNumber: true, title: true, overview: true, airDate: true, imageUrl: true, runtimeMinutes: true } },
            },
          },
        },
      },
    },
  });

  const seriesIds = progresses.map((p) => p.series.id);
  const watches = await prisma.episodeWatch.findMany({
    where: { userId, episode: { season: { seriesId: { in: seriesIds } } } },
    select: { episodeId: true },
  });
  const watchedEpisodeIds = new Set(watches.map((w) => w.episodeId));

  return progresses.map((p) => ({
    id: p.series.id,
    title: p.series.title,
    releaseStatus: p.series.releaseStatus,
    tmdbId: p.series.externalIds?.tmdbId ?? null,
    userStatus: p.userStatus,
    nextEpisodeId: p.nextEpisodeId,
    episodes: p.series.seasons.flatMap((season) =>
      season.episodes.map((ep) => ({
        id: ep.id,
        seasonNumber: season.seasonNumber,
        episodeNumber: ep.episodeNumber,
        title: ep.title,
        overview: ep.overview,
        airDate: ep.airDate,
        imageUrl: ep.imageUrl,
        runtimeMinutes: ep.runtimeMinutes,
        watched: watchedEpisodeIds.has(ep.id),
      })),
    ),
  }));
}

function tmdbStillUrl(stillPath: string | null | undefined): string | null {
  return stillPath ? `https://image.tmdb.org/t/p/original${stillPath}` : null;
}

async function fetchProviderEpisodes(tmdb: TmdbClient, tmdbId: string, localSeasonNumbers: number[]): Promise<{ episodes: ProviderEpisodeInput[]; releaseStatus: ReleaseStatus }> {
  const details = await tmdb.getShowDetails(tmdbId);
  const releaseStatus = mapTmdbStatusToReleaseStatus(details.status);

  // Union of every season MyTv already knows about (so a shrink/disappear
  // can be detected) and every season TMDb currently reports (so new
  // seasons are discovered too).
  const providerSeasonNumbers = Array.from({ length: details.number_of_seasons ?? 0 }, (_, i) => i + 1);
  const seasonNumbers = [...new Set([...localSeasonNumbers, ...providerSeasonNumbers])].sort((a, b) => a - b);

  const episodes: ProviderEpisodeInput[] = [];
  for (const batch of chunkArray(seasonNumbers, MAX_APPEND_TO_RESPONSE_ITEMS)) {
    const response = await tmdb.getSeasonsBatch(tmdbId, batch);
    for (const seasonNumber of batch) {
      const season: TmdbSeason | undefined = getAppendedSeason(response, seasonNumber);
      if (!season?.episodes) continue;
      for (const ep of season.episodes) {
        episodes.push({
          seasonNumber: ep.season_number,
          episodeNumber: ep.episode_number,
          title: ep.name ?? null,
          overview: ep.overview ?? null,
          airDate: ep.air_date ? new Date(ep.air_date) : null,
          imageUrl: tmdbStillUrl(ep.still_path),
          runtimeMinutes: ep.runtime ?? null,
        });
      }
    }
  }

  return { episodes, releaseStatus };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const accessToken = process.env.TMDB_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('Missing TMDB_ACCESS_TOKEN — set it in .env (see .env.example). No request is made without it.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const tmdb = new TmdbClient({ accessToken });
  const generatedAt = new Date();

  console.log('Episode release refresh — DRY RUN (no writes to any table)');
  console.log(`  target user: ${options.userId}`);
  console.log(`  series limit: ${options.limit ?? 'unlimited'}`);

  const allSeries = await loadCandidateSeries(prisma, options.userId);

  const skippedSeries: SkippedSeriesEntry[] = [];
  const eligibleSeries: SeriesRow[] = [];
  for (const series of allSeries) {
    const eligibility = checkSeriesEligibility({
      userStatus: series.userStatus,
      tmdbId: series.tmdbId,
      title: series.title,
    });
    if (!eligibility.eligible) {
      skippedSeries.push({ seriesId: series.id, seriesTitle: series.title, userStatus: series.userStatus, reason: eligibility.reason! });
    } else {
      eligibleSeries.push(series);
    }
  }

  const toInspect = options.limit ? eligibleSeries.slice(0, options.limit) : eligibleSeries;
  console.log(`  eligible series: ${eligibleSeries.length}${options.limit ? ` (inspecting first ${toInspect.length})` : ''}`);
  console.log(`  skipped series: ${skippedSeries.length}`);

  const refreshedSeries: RefreshedSeriesEntry[] = [];

  for (const series of toInspect) {
    const localSeasonNumbers = [...new Set(series.episodes.map((e) => e.seasonNumber))];
    try {
      const { episodes: providerEpisodes, releaseStatus: providerReleaseStatus } = await fetchProviderEpisodes(tmdb, series.tmdbId!, localSeasonNumbers);

      const comparison = compareSeriesCatalog({
        localEpisodes: series.episodes,
        providerEpisodes,
        currentReleaseStatus: series.releaseStatus,
        providerReleaseStatus,
        currentUserStatus: series.userStatus,
        currentNextEpisodeId: series.nextEpisodeId,
      });

      const operatingOutcome = classifyRefreshOperatingOutcome(comparison.classification);

      refreshedSeries.push({
        seriesId: series.id,
        seriesTitle: series.title,
        userStatus: series.userStatus,
        currentNextEpisodeId: series.nextEpisodeId,
        tmdbId: series.tmdbId!,
        localEpisodeCount: series.episodes.length,
        providerEpisodeCount: providerEpisodes.length,
        newEpisodesFound: comparison.newEpisodes.length,
        releasedNewEpisodesFound: comparison.releasedNewEpisodeCount,
        futureNewEpisodesFound: comparison.futureNewEpisodeCount,
        fieldChangeCount: comparison.fieldChanges.length,
        releaseStatusChange: comparison.releaseStatusChange,
        proposedNextEpisodeId: comparison.proposedNextEpisodeId,
        proposedNextEpisodeLabel: comparison.proposedNextEpisodeLabel,
        proposedNextEpisodeIsNew: comparison.proposedNextEpisodeIsNew,
        nextEpisodeWouldChange: comparison.nextEpisodeWouldChange,
        proposedUserStatus: comparison.proposedUserStatus,
        userStatusWouldChangeToWatching: comparison.userStatusWouldChangeToWatching,
        classification: comparison.classification,
        bulkInsertReason: comparison.bulkInsertReason,
        seasonZeroReason: comparison.seasonZeroReason,
        operatingClassification: operatingOutcome.operatingClassification,
        routingNote: operatingOutcome.routingNote,
        warnings: comparison.warnings,
      });

      console.log(`  [${comparison.classification}] ${series.title}`);
    } catch (err) {
      const message = err instanceof TmdbRequestError ? err.message : (err as Error).message;
      const operatingOutcome = classifyRefreshOperatingOutcome('PROVIDER_ERROR');
      refreshedSeries.push({
        seriesId: series.id,
        seriesTitle: series.title,
        userStatus: series.userStatus,
        currentNextEpisodeId: series.nextEpisodeId,
        tmdbId: series.tmdbId!,
        localEpisodeCount: series.episodes.length,
        providerEpisodeCount: null,
        newEpisodesFound: 0,
        releasedNewEpisodesFound: 0,
        futureNewEpisodesFound: 0,
        fieldChangeCount: 0,
        releaseStatusChange: null,
        proposedNextEpisodeId: null,
        proposedNextEpisodeLabel: null,
        proposedNextEpisodeIsNew: false,
        nextEpisodeWouldChange: false,
        proposedUserStatus: null,
        userStatusWouldChangeToWatching: false,
        classification: 'PROVIDER_ERROR',
        bulkInsertReason: null,
        seasonZeroReason: null,
        operatingClassification: operatingOutcome.operatingClassification,
        routingNote: operatingOutcome.routingNote,
        warnings: [`TMDb fetch failed: ${message}`],
      });
      console.log(`  [PROVIDER_ERROR] ${series.title} — ${message}`);
    }
  }

  const report = buildRefreshReport({ generatedAt, targetUserId: options.userId, skippedSeries, refreshedSeries });
  const markdown = buildMarkdownReport(report);
  const written = writeRefreshReports(options.outDir, report, markdown);

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
