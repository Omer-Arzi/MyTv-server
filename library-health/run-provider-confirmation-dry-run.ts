// Provider Confirmation Decisions — DRY RUN ONLY. Takes a human-authored
// decision file (see provider-confirmation-decisions.example.json) and, for
// each "confirm" decision, fetches the selected provider's catalog and
// simulates exactly what an eventual apply step would do — new episodes,
// field changes, proposed ExternalIds/poster/backdrop, and
// UserSeriesProgress recomputation — without writing any of it.
//
// This NEVER writes anything: no ExternalIds row, no Episode/Season row, no
// UserSeriesProgress update, no apply mode, ever, in this script. A real
// apply step is deliberately a separate, not-yet-built piece of work — see
// the task this was built for.

import 'dotenv/config';
import path from 'path';
import { readFileSync } from 'fs';
import { PrismaClient, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { MAX_APPEND_TO_RESPONSE_ITEMS, TmdbClient, TmdbRequestError } from '../tmdb-enrichment/tmdb-client';
import { getAppendedSeason } from '../tmdb-enrichment/tmdb-types';
import { mapTmdbStatusToReleaseStatus } from '../tmdb-enrichment/release-status-mapping';
import { tmdbImageUrl } from '../tmdb-enrichment/apply-plan-writes';
import { TvMazeClient, TvMazeRequestError } from '../secondary-provider-audit/tvmaze-client';
import { chunkArray, compareSeriesCatalog, LocalEpisodeInput, ProviderEpisodeInput } from '../episode-release-refresh/refresh-logic';
import { buildSeasonShape, SeasonShape } from '../tmdb-enrichment/season-structure-tiebreak';
import { loadSeriesHealthInputs } from './load-series-health-inputs';
import { checkTitleYearSanity, classifyProviderConfirmationDryRun, ProviderConfirmationDecision } from './provider-confirmation-decisions-logic';
import {
  buildProviderConfirmationDryRunMarkdownReport,
  buildProviderConfirmationDryRunReport,
  DryRunSeriesEntry,
  writeProviderConfirmationDryRunReports,
} from './provider-confirmation-decisions-reports';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');
const DEFAULT_DECISIONS_PATH = path.join(__dirname, 'provider-confirmation-decisions.example.json');

// The "no comparison was attempted" shape shared by every early-return path
// below (excluded/skip/defer/not-found) — spread and overridden with real
// values only once a comparison actually runs.
const EMPTY_COMPARISON_FIELDS = {
  seriesId: null,
  localSeasonShape: null,
  providerSeasonShape: null,
  watchedEpisodeCount: null,
  watchedEpisodesOrphaned: null,
  newEpisodesCount: null,
  releasedNewEpisodesCount: null,
  futureNewEpisodesCount: null,
  fieldChangeCount: null,
  proposedExternalIdsUpdate: null,
  proposedPosterUpdate: null,
  proposedBackdropUpdate: null,
  proposedNextEpisodeChange: null,
  proposedUserStatusChange: null,
  warnings: [] as string[],
} as const;

// Never touched in this pass regardless of what the decision file says —
// see library-health/provider-confirmation-reports.ts's DEFER handling for
// why these two remain out of scope.
const EXCLUDED_TITLES = ['Naruto Shippuden', 'Doctor Who (2005)'];

interface CliOptions {
  userId: string;
  outDir: string;
  decisionsPath: string;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('--apply')) {
    console.error(
      'This is a dry run only and does not support --apply — no DB writes, no provider writes, no apply mode ' +
        'exists in this script. Re-run without --apply.',
    );
    process.exit(1);
  }

  const options: CliOptions = { userId: DEV_USER_ID, outDir: DEFAULT_OUT_DIR, decisionsPath: DEFAULT_DECISIONS_PATH };
  for (const arg of argv) {
    if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
    else if (arg.startsWith('--decisions=')) options.decisionsPath = path.resolve(arg.slice('--decisions='.length));
  }
  return options;
}

function loadDecisions(decisionsPath: string): ProviderConfirmationDecision[] {
  const raw = JSON.parse(readFileSync(decisionsPath, 'utf-8'));
  if (!Array.isArray(raw)) {
    throw new Error(`decisions file ${decisionsPath} must contain a JSON array`);
  }
  for (const entry of raw) {
    if (typeof entry.title !== 'string' || !entry.title) {
      throw new Error(`decisions file entry missing a string "title": ${JSON.stringify(entry)}`);
    }
    if (!['confirm', 'skip', 'defer'].includes(entry.decision)) {
      throw new Error(`decisions file entry for "${entry.title}" has an unsupported "decision": ${entry.decision}`);
    }
    if (entry.provider !== undefined && !['tmdb', 'tvmaze'].includes(entry.provider)) {
      throw new Error(`decisions file entry for "${entry.title}" has an unsupported "provider": ${entry.provider}`);
    }
  }
  return raw as ProviderConfirmationDecision[];
}

async function loadFullLocalEpisodes(prisma: PrismaClient, userId: string, seriesId: string): Promise<LocalEpisodeInput[]> {
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

function countOrphanedWatchedEpisodes(localEpisodes: LocalEpisodeInput[], providerEpisodes: ProviderEpisodeInput[]): number {
  const providerKeys = new Set(providerEpisodes.map((e) => `${e.seasonNumber}:${e.episodeNumber}`));
  return localEpisodes.filter((e) => e.watched && !providerKeys.has(`${e.seasonNumber}:${e.episodeNumber}`)).length;
}

interface ProviderFetchResult {
  candidateTitle: string;
  candidateYear: number | null;
  posterUrl: string | null;
  episodes: ProviderEpisodeInput[];
  releaseStatus: ReleaseStatus;
}

async function fetchTmdbCandidate(tmdb: TmdbClient, tmdbId: string, localSeasonNumbers: number[]): Promise<ProviderFetchResult> {
  const details = await tmdb.getShowDetails(tmdbId);
  const releaseStatus = mapTmdbStatusToReleaseStatus(details.status);
  const providerSeasonNumbers = Array.from({ length: details.number_of_seasons ?? 0 }, (_, i) => i + 1);
  const seasonNumbers = [...new Set([...localSeasonNumbers, ...providerSeasonNumbers])].sort((a, b) => a - b);

  const episodes: ProviderEpisodeInput[] = [];
  for (const batch of chunkArray(seasonNumbers, MAX_APPEND_TO_RESPONSE_ITEMS)) {
    const response = await tmdb.getSeasonsBatch(tmdbId, batch);
    for (const seasonNumber of batch) {
      const season = getAppendedSeason(response, seasonNumber);
      if (!season?.episodes) continue;
      for (const ep of season.episodes) {
        episodes.push({
          seasonNumber: ep.season_number,
          episodeNumber: ep.episode_number,
          title: ep.name ?? null,
          overview: ep.overview ?? null,
          airDate: ep.air_date ? new Date(ep.air_date) : null,
          imageUrl: tmdbImageUrl(ep.still_path),
          runtimeMinutes: null,
        });
      }
    }
  }

  return {
    candidateTitle: details.name,
    candidateYear: details.first_air_date ? Number(details.first_air_date.slice(0, 4)) : null,
    posterUrl: tmdbImageUrl(details.poster_path),
    episodes,
    releaseStatus,
  };
}

function mapTvmazeStatusToReleaseStatus(status: string | null): ReleaseStatus {
  if (!status) return ReleaseStatus.UNKNOWN;
  switch (status.toLowerCase()) {
    case 'running':
      return ReleaseStatus.RETURNING;
    case 'ended':
      return ReleaseStatus.ENDED;
    case 'to be determined':
    case 'in development':
      return ReleaseStatus.IN_PRODUCTION;
    default:
      return ReleaseStatus.UNKNOWN;
  }
}

async function fetchTvmazeCandidate(tvmaze: TvMazeClient, tvmazeId: string): Promise<ProviderFetchResult> {
  const show = await tvmaze.getShowWithEpisodes(tvmazeId);
  const rawEpisodes = show._embedded?.episodes ?? [];

  const episodes: ProviderEpisodeInput[] = rawEpisodes
    .filter((ep) => ep.number !== null)
    .map((ep) => ({
      seasonNumber: ep.season,
      episodeNumber: ep.number as number,
      title: ep.name ?? null,
      overview: ep.summary ?? null,
      airDate: ep.airdate ? new Date(ep.airdate) : null,
      imageUrl: null, // not fetched by the existing TVmaze episode type/client — see tvmaze-types.ts
      runtimeMinutes: ep.runtime ?? null,
    }));

  return {
    candidateTitle: show.name,
    candidateYear: show.premiered ? Number(show.premiered.slice(0, 4)) : null,
    posterUrl: show.image?.original ?? show.image?.medium ?? null,
    episodes,
    releaseStatus: mapTvmazeStatusToReleaseStatus(show.status),
  };
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
  const tvmaze = new TvMazeClient();
  const generatedAt = new Date();

  console.log('Provider Confirmation Decisions — DRY RUN (no DB writes, no provider writes, no apply mode)');
  console.log(`  target user: ${options.userId}`);
  console.log(`  decisions file: ${options.decisionsPath}`);

  const decisions = loadDecisions(options.decisionsPath);
  console.log(`  decisions loaded: ${decisions.length}`);

  const healthInputs = await loadSeriesHealthInputs(prisma, options.userId);

  const seriesReports: DryRunSeriesEntry[] = [];

  for (const decision of decisions) {
    const baseEntry = {
      title: decision.title,
      decision: decision.decision,
      provider: decision.provider ?? null,
      providerId: decision.providerId !== undefined ? String(decision.providerId) : null,
      notes: decision.notes ?? null,
    };

    if (EXCLUDED_TITLES.includes(decision.title)) {
      seriesReports.push({
        ...baseEntry,
        ...EMPTY_COMPARISON_FIELDS,
        classification: null,
        reason: `"${decision.title}" is excluded from this pass regardless of the decision file — see EXCLUDED_TITLES.`,
      });
      console.log(`  [EXCLUDED] ${decision.title}`);
      continue;
    }

    if (decision.decision !== 'confirm') {
      seriesReports.push({
        ...baseEntry,
        ...EMPTY_COMPARISON_FIELDS,
        classification: null,
        reason: `decision is "${decision.decision}" — no dry-run comparison attempted.`,
      });
      console.log(`  [${decision.decision.toUpperCase()}] ${decision.title}`);
      continue;
    }

    // decision === 'confirm' from here.
    const local = healthInputs.find((s) => s.title === decision.title);
    if (!local) {
      seriesReports.push({
        ...baseEntry,
        ...EMPTY_COMPARISON_FIELDS,
        classification: 'LOCAL_SERIES_NOT_FOUND',
        reason: `no local series titled "${decision.title}" was found.`,
      });
      console.log(`  [LOCAL_SERIES_NOT_FOUND] ${decision.title}`);
      continue;
    }

    const bySeason = new Map<number, number>();
    for (const ep of local.episodes) bySeason.set(ep.seasonNumber, (bySeason.get(ep.seasonNumber) ?? 0) + 1);
    const localShape = buildSeasonShape([...bySeason.entries()].sort(([a], [b]) => a - b).map(([, count]) => count));
    const watchedEpisodeCount = local.episodes.filter((e) => e.watched).length;

    if (!decision.provider || decision.providerId === undefined) {
      seriesReports.push({
        ...baseEntry,
        ...EMPTY_COMPARISON_FIELDS,
        classification: 'BLOCKED_RISK',
        reason: `decision is "confirm" but is missing a "provider" and/or "providerId" — cannot fetch a candidate to compare against.`,
        seriesId: local.seriesId,
        localSeasonShape: localShape,
        watchedEpisodeCount,
      });
      console.log(`  [BLOCKED_RISK] ${decision.title} — missing provider/providerId`);
      continue;
    }

    const providerId = String(decision.providerId);
    const localSeasonNumbers = [...bySeason.keys()];

    try {
      const fetched =
        decision.provider === 'tmdb' ? await fetchTmdbCandidate(tmdb, providerId, localSeasonNumbers) : await fetchTvmazeCandidate(tvmaze, providerId);

      const providerShape = buildSeasonShape(
        [...new Set(fetched.episodes.map((e) => e.seasonNumber))].sort((a, b) => a - b).map((sn) => fetched.episodes.filter((e) => e.seasonNumber === sn).length),
      );

      const sanity = checkTitleYearSanity({ localTitle: decision.title, candidateTitle: fetched.candidateTitle, candidateYear: fetched.candidateYear });

      const fullLocalEpisodes = await loadFullLocalEpisodes(prisma, options.userId, local.seriesId);
      const comparison = compareSeriesCatalog({
        localEpisodes: fullLocalEpisodes,
        providerEpisodes: fetched.episodes,
        currentReleaseStatus: local.releaseStatus,
        providerReleaseStatus: fetched.releaseStatus,
        currentUserStatus: local.progress?.userStatus ?? UserSeriesStatus.UNKNOWN,
        currentNextEpisodeId: local.progress?.nextEpisodeId ?? null,
        now: generatedAt,
      });

      const decisionResult = classifyProviderConfirmationDryRun({ titleYearSanity: sanity, comparison });

      const orphanedCount = countOrphanedWatchedEpisodes(fullLocalEpisodes, fetched.episodes);

      const proposedExternalIdsUpdate = {
        tmdbId: decision.provider === 'tmdb' ? providerId : null,
        provider: decision.provider,
        providerId,
      };
      const proposedPosterUpdate = { from: local.posterUrl, to: fetched.posterUrl, wouldChange: local.posterUrl !== fetched.posterUrl };
      // Only TMDb exposes a distinct backdrop image in this codebase's
      // provider clients — TVmaze's show object has no separate
      // "backdrop"/fanart field, only the poster-shaped `image`.
      const proposedBackdropUpdate = decision.provider === 'tmdb' ? { from: local.backdropUrl, to: local.backdropUrl, wouldChange: false } : null;
      const proposedNextEpisodeChange = {
        from: local.progress?.nextEpisodeId ?? null,
        to: comparison.proposedNextEpisodeId,
        toLabel: comparison.proposedNextEpisodeLabel,
        toIsNew: comparison.proposedNextEpisodeIsNew,
        wouldChange: comparison.nextEpisodeWouldChange,
      };
      const proposedUserStatusChange = {
        from: local.progress?.userStatus ?? UserSeriesStatus.UNKNOWN,
        to: comparison.proposedUserStatus,
        wouldChange: (local.progress?.userStatus ?? UserSeriesStatus.UNKNOWN) !== comparison.proposedUserStatus,
      };

      seriesReports.push({
        ...baseEntry,
        classification: decisionResult.classification,
        reason: decisionResult.reason,
        seriesId: local.seriesId,
        localSeasonShape: localShape,
        providerSeasonShape: providerShape,
        watchedEpisodeCount,
        watchedEpisodesOrphaned: orphanedCount,
        newEpisodesCount: comparison.newEpisodes.length,
        releasedNewEpisodesCount: comparison.releasedNewEpisodeCount,
        futureNewEpisodesCount: comparison.futureNewEpisodeCount,
        fieldChangeCount: comparison.fieldChanges.length,
        proposedExternalIdsUpdate,
        proposedPosterUpdate,
        proposedBackdropUpdate,
        proposedNextEpisodeChange,
        proposedUserStatusChange,
        warnings: comparison.warnings,
      });

      console.log(`  [${decisionResult.classification}] ${decision.title} (${decision.provider}:${providerId})`);
    } catch (err) {
      const isNotFound = (err instanceof TmdbRequestError || err instanceof TvMazeRequestError) && err.status === 404;
      const message = err instanceof TmdbRequestError || err instanceof TvMazeRequestError ? err.message : (err as Error).message;

      seriesReports.push({
        ...baseEntry,
        ...EMPTY_COMPARISON_FIELDS,
        classification: isNotFound ? 'PROVIDER_NOT_FOUND' : 'BLOCKED_RISK',
        reason: isNotFound ? `provider candidate ${decision.provider}:${providerId} was not found.` : `provider fetch failed: ${message}`,
        seriesId: local.seriesId,
        localSeasonShape: localShape,
        watchedEpisodeCount,
        warnings: [message],
      });
      console.log(`  [${isNotFound ? 'PROVIDER_NOT_FOUND' : 'BLOCKED_RISK'}] ${decision.title} — ${message}`);
    }
  }

  const report = buildProviderConfirmationDryRunReport({
    generatedAt,
    targetUserId: options.userId,
    decisionsFilePath: options.decisionsPath,
    decisionsLoadedCount: decisions.length,
    series: seriesReports,
  });
  const markdown = buildProviderConfirmationDryRunMarkdownReport(report);
  const written = writeProviderConfirmationDryRunReports(options.outDir, report, markdown);

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
