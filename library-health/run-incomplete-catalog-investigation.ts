// Focused INCOMPLETE_CATALOG investigation — READ-ONLY. Takes every series
// the Library Health report (run-health-report.ts) currently classifies as
// INCOMPLETE_CATALOG and, where a tmdbId exists, runs ONE live read-only
// TMDb comparison (reusing episode-release-refresh's exact fetch + compare
// logic) to figure out *why* and propose exactly one safe next action.
//
// Same safety posture as episode-release-refresh and library-health: no DB
// writes, no provider writes, no apply mode, ever. A series with no tmdbId
// is never auto-matched — it's just reported as needing one.

import 'dotenv/config';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { MAX_APPEND_TO_RESPONSE_ITEMS, TmdbClient, TmdbRequestError } from '../tmdb-enrichment/tmdb-client';
import { getAppendedSeason, TmdbSeason } from '../tmdb-enrichment/tmdb-types';
import { mapTmdbStatusToReleaseStatus } from '../tmdb-enrichment/release-status-mapping';
import { chunkArray, compareSeriesCatalog, LocalEpisodeInput as RefreshLocalEpisodeInput, ProviderEpisodeInput } from '../episode-release-refresh/refresh-logic';
import { classifySeriesHealth } from './health-logic';
import { loadSeriesHealthInputs } from './load-series-health-inputs';
import { investigateIncompleteCatalog, ProviderComparisonOutcome } from './incomplete-catalog-investigation';
import { buildIncompleteCatalogMarkdownReport, buildIncompleteCatalogReport, IncompleteCatalogSeriesReport, writeIncompleteCatalogReports } from './incomplete-catalog-reports';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');

interface CliOptions {
  userId: string;
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('--apply')) {
    console.error(
      'This investigation is read-only by design and does not support --apply — no DB writes, no provider ' +
        'writes, no apply mode. Re-run without --apply.',
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

function tmdbStillUrl(stillPath: string | null | undefined): string | null {
  return stillPath ? `https://image.tmdb.org/t/p/original${stillPath}` : null;
}

// Same fetch shape as episode-release-refresh/run-refresh.ts's
// fetchProviderEpisodes (deliberately not imported from there — that file
// has a top-level main().catch() side effect on import, see
// load-series-health-inputs.ts's header for why that rules out importing
// script files directly).
async function fetchProviderEpisodes(tmdb: TmdbClient, tmdbId: string, localSeasonNumbers: number[]): Promise<{ episodes: ProviderEpisodeInput[]; releaseStatus: ReturnType<typeof mapTmdbStatusToReleaseStatus> }> {
  const details = await tmdb.getShowDetails(tmdbId);
  const releaseStatus = mapTmdbStatusToReleaseStatus(details.status);

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
          runtimeMinutes: null,
        });
      }
    }
  }

  return { episodes, releaseStatus };
}

async function loadFullLocalEpisodes(prisma: PrismaClient, userId: string, seriesId: string): Promise<RefreshLocalEpisodeInput[]> {
  const seasons = await prisma.season.findMany({
    where: { seriesId },
    select: {
      seasonNumber: true,
      episodes: {
        select: { id: true, episodeNumber: true, title: true, overview: true, airDate: true, imageUrl: true, runtimeMinutes: true, watches: { where: { userId }, select: { id: true } } },
      },
    },
  });

  return seasons.flatMap((season) =>
    season.episodes.map((ep) => ({
      id: ep.id,
      seasonNumber: season.seasonNumber,
      episodeNumber: ep.episodeNumber,
      title: ep.title,
      overview: ep.overview,
      airDate: ep.airDate,
      imageUrl: ep.imageUrl,
      runtimeMinutes: ep.runtimeMinutes,
      watched: ep.watches.length > 0,
    })),
  );
}

function episodeLabel(seasonNumber: number, episodeNumber: number): string {
  return `S${seasonNumber}E${episodeNumber}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const accessToken = process.env.TMDB_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('Missing TMDB_ACCESS_TOKEN — set it in .env (see .env.example). Series without a tmdbId are still reported; nothing is fetched without this token.');
  }

  const prisma = new PrismaClient();
  const tmdb = accessToken ? new TmdbClient({ accessToken }) : null;
  const generatedAt = new Date();

  console.log('Incomplete Catalog investigation — READ-ONLY (no DB writes, no provider writes)');
  console.log(`  target user: ${options.userId}`);

  const healthInputs = await loadSeriesHealthInputs(prisma, options.userId);
  const incomplete = healthInputs
    .map((input) => ({ input, health: classifySeriesHealth({ ...input, now: generatedAt }) }))
    .filter(({ health }) => health.classification === 'INCOMPLETE_CATALOG');

  console.log(`  INCOMPLETE_CATALOG series found: ${incomplete.length}`);

  const seriesReports: IncompleteCatalogSeriesReport[] = [];

  for (const { input, health } of incomplete) {
    const localSeasonNumbers = [...new Set(input.episodes.map((e) => e.seasonNumber))];
    const latestWatch = await prisma.episodeWatch.findFirst({
      where: { userId: options.userId, episode: { season: { seriesId: input.seriesId } } },
      orderBy: { watchedAt: 'desc' },
      select: { watchedAt: true, episode: { select: { episodeNumber: true, season: { select: { seasonNumber: true } } } } },
    });
    const latestWatchedEpisodeLabel = latestWatch ? episodeLabel(latestWatch.episode.season.seasonNumber, latestWatch.episode.episodeNumber) : null;

    let providerComparison: IncompleteCatalogSeriesReport['providerComparison'];
    let outcome: ProviderComparisonOutcome | null = null;

    if (!health.tmdbId || !tmdb) {
      providerComparison = {
        attempted: false,
        succeeded: false,
        error: null,
        providerSeasonCount: null,
        providerEpisodeCount: null,
        newEpisodesFound: null,
        releasedNewEpisodesFound: null,
        futureNewEpisodesFound: null,
        comparisonClassification: null,
        warnings: [],
      };
    } else {
      try {
        const fullLocalEpisodes = await loadFullLocalEpisodes(prisma, options.userId, input.seriesId);
        const { episodes: providerEpisodes, releaseStatus: providerReleaseStatus } = await fetchProviderEpisodes(tmdb, health.tmdbId, localSeasonNumbers);

        const comparison = compareSeriesCatalog({
          localEpisodes: fullLocalEpisodes,
          providerEpisodes,
          currentReleaseStatus: input.releaseStatus,
          providerReleaseStatus,
          currentUserStatus: health.userStatus!,
          currentNextEpisodeId: health.nextEpisodeId,
          now: generatedAt,
        });

        const providerSeasonCount = new Set(providerEpisodes.map((e) => e.seasonNumber)).size;
        outcome = { succeeded: true, comparison, providerSeasonCount };

        providerComparison = {
          attempted: true,
          succeeded: true,
          error: null,
          providerSeasonCount,
          providerEpisodeCount: providerEpisodes.length,
          newEpisodesFound: comparison.newEpisodes.length,
          releasedNewEpisodesFound: comparison.releasedNewEpisodeCount,
          futureNewEpisodesFound: comparison.futureNewEpisodeCount,
          comparisonClassification: comparison.classification,
          warnings: comparison.warnings,
        };
      } catch (err) {
        const message = err instanceof TmdbRequestError ? err.message : (err as Error).message;
        outcome = { succeeded: false, error: message };
        providerComparison = {
          attempted: true,
          succeeded: false,
          error: message,
          providerSeasonCount: null,
          providerEpisodeCount: null,
          newEpisodesFound: null,
          releasedNewEpisodesFound: null,
          futureNewEpisodesFound: null,
          comparisonClassification: null,
          warnings: [],
        };
      }
    }

    const investigation = investigateIncompleteCatalog({
      hasTmdbId: !!health.tmdbId,
      healthRiskFlags: health.riskFlags,
      localSeasonCount: localSeasonNumbers.length,
      providerComparison: outcome,
    });

    seriesReports.push({
      seriesId: health.seriesId,
      title: health.title,
      releaseStatus: health.releaseStatus,
      userStatus: health.userStatus,
      tmdbId: health.tmdbId,
      tvmazeId: health.tvmazeId,
      localSeasonCount: localSeasonNumbers.length,
      localEpisodeCount: health.localEpisodeCount,
      watchedEpisodeCount: health.watchedEpisodeCount,
      latestWatchedEpisodeLabel,
      latestWatchedAt: latestWatch ? latestWatch.watchedAt.toISOString() : null,
      nextEpisodeId: health.nextEpisodeId,
      hasPoster: health.hasPoster,
      hasBackdrop: health.hasBackdrop,
      healthRiskFlags: health.riskFlags,
      providerComparison,
      issueClassification: investigation.issueClassification,
      recommendedNextAction: investigation.recommendedNextAction,
      reason: investigation.reason,
    });

    console.log(`  [${investigation.issueClassification}] ${health.title} -> ${investigation.recommendedNextAction}`);
  }

  const report = buildIncompleteCatalogReport({ generatedAt, targetUserId: options.userId, series: seriesReports });
  const markdown = buildIncompleteCatalogMarkdownReport(report);
  const written = writeIncompleteCatalogReports(options.outDir, report, markdown);

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
