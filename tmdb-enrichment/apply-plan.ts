// TMDb enrichment APPLY — the write step that tmdb-enrichment/enrichment-dry-run.ts
// deliberately never had. Reads ONLY tmdb-apply-plan.json's safeApplyCandidates
// as input (see apply-plan-validation.ts) and never re-runs scoring,
// re-searches TMDb, or re-decides which candidate matched a series — that
// decision was already made by the dry run + the plan-generation step, and
// is treated here as fixed. This file's only two jobs are: (1) fetch the
// full TMDb metadata for the tmdbId the plan already chose, and (2) write
// it — or, in dry-run mode (the default), print exactly what would be
// written without writing it.
//
// Default mode is dry-run. Real writes require options.apply === true,
// which run-apply-plan.ts only sets when the caller passes --apply
// explicitly.

import { ImportIssueSeverity, ImportStatus, Prisma, PrismaClient, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { TmdbClient, MAX_APPEND_TO_RESPONSE_ITEMS } from './tmdb-client';
import { getAppendedSeason, TmdbSeason, TmdbTvDetails } from './tmdb-types';
import { mapTmdbStatusToReleaseStatus } from './release-status-mapping';
import { ApplyPlanCandidate, TmdbApplyPlan } from './apply-plan-types';
import { resolveAndValidateCandidates } from './apply-plan-validation';
import { computeSeriesFieldUpdate, computeSeriesTitleUpdate, decideUserStatusUpdate, tmdbImageUrl } from './apply-plan-writes';

const APPLY_BATCH_SOURCE = 'tmdb-enrichment-apply';
// Dry-run cache reads are allowed to hit rows written by the ORIGINAL dry
// run too (source 'tmdb-enrichment') — the whole point of reusing the
// cache is that the --limit=50/full dry runs that produced this plan
// already fetched this exact tmdbId's show/season data, so apply (dry-run
// or real) shouldn't need a second TMDb round-trip for data that's still
// fresh.
const READABLE_CACHE_SOURCES = ['tmdb-enrichment', APPLY_BATCH_SOURCE];
const DEFAULT_CACHE_FRESHNESS_DAYS = 30;

export interface ApplyRunOptions {
  userId: string;
  apply: boolean; // false = dry-run (default everywhere this is constructed)
  seriesIds?: string[]; // optional --series= filter; omitted = every safe candidate
  cacheFreshnessDays?: number;
  force?: boolean; // allow a live TMDb fetch even in dry-run, if cache is missing/stale
}

type CacheOutcome<T> = { status: 'hit' | 'fetched'; data: T } | { status: 'missing' };

async function getCachedOrFetch<T>(
  prisma: PrismaClient,
  writeBatchId: string | null,
  kind: string,
  key: string,
  fetchFn: () => Promise<T>,
  options: { allowFetch: boolean; cacheFreshnessDays?: number; force?: boolean },
): Promise<CacheOutcome<T>> {
  const sourceFile = `tmdb:${kind}:${key}`;
  const freshnessMs = (options.cacheFreshnessDays ?? DEFAULT_CACHE_FRESHNESS_DAYS) * 24 * 60 * 60 * 1000;

  if (!options.force) {
    const cached = await prisma.importRawRow.findFirst({
      where: { sourceFile, importBatch: { source: { in: READABLE_CACHE_SOURCES } } },
      orderBy: { createdAt: 'desc' },
    });
    if (cached && Date.now() - cached.createdAt.getTime() < freshnessMs) {
      return { status: 'hit', data: cached.payload as T };
    }
  }

  if (!options.allowFetch) {
    return { status: 'missing' };
  }

  const data = await fetchFn();
  if (writeBatchId) {
    await prisma.importRawRow.create({
      data: { importBatchId: writeBatchId, sourceFile, sourceRowNumber: 1, payload: data as unknown as Prisma.InputJsonValue },
    });
  }
  return { status: 'fetched', data };
}

async function fetchAllSeasons(
  prisma: PrismaClient,
  tmdb: TmdbClient,
  writeBatchId: string | null,
  tmdbId: string,
  numberOfSeasons: number,
  cacheOptions: { allowFetch: boolean; cacheFreshnessDays?: number; force?: boolean },
): Promise<CacheOutcome<TmdbSeason[]>> {
  if (numberOfSeasons <= 0) return { status: 'hit', data: [] };

  const seasonNumbers = Array.from({ length: numberOfSeasons }, (_, i) => i + 1);
  const seasons: TmdbSeason[] = [];
  let anyFetched = false;

  for (let i = 0; i < seasonNumbers.length; i += MAX_APPEND_TO_RESPONSE_ITEMS) {
    const chunk = seasonNumbers.slice(i, i + MAX_APPEND_TO_RESPONSE_ITEMS);
    const batchIndex = Math.floor(i / MAX_APPEND_TO_RESPONSE_ITEMS);
    const outcome = await getCachedOrFetch(
      prisma,
      writeBatchId,
      'seasons',
      `${tmdbId}:batch${batchIndex}`,
      () => tmdb.getSeasonsBatch(tmdbId, chunk),
      cacheOptions,
    );
    if (outcome.status === 'missing') return { status: 'missing' };
    if (outcome.status === 'fetched') anyFetched = true;
    for (const seasonNumber of chunk) {
      const season = getAppendedSeason(outcome.data, seasonNumber);
      if (season) seasons.push(season);
    }
  }

  return { status: anyFetched ? 'fetched' : 'hit', data: seasons };
}

export interface PlannedEpisodeUpdate {
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  overview: string | null;
  airDate: string | null;
  imageUrl: string | null;
}

export interface PlannedSeasonUpdate {
  seasonNumber: number;
  title: string | null;
  episodeCount: number;
}

export interface PlannedCandidateUpdate {
  mytvSeriesId: string;
  mytvSeriesTitle: string;
  tmdbId: string;
  status: 'ready' | 'missing-tmdb-data';
  reason?: string;
  series?: {
    currentTitle: string;
    newTitle: string | null;
    titleChangeReason: string;
    overview: string | null;
    posterUrl: string | null;
    backdropUrl: string | null;
    releaseStatus: ReleaseStatus;
  };
  externalIds?: {
    tmdbId: string;
    provider: string;
    providerId: string;
    matchSource: string;
  };
  seasons?: PlannedSeasonUpdate[];
  episodes?: PlannedEpisodeUpdate[];
  userStatus?: {
    currentLiveStatus: UserSeriesStatus;
    proposedUserStatus: UserSeriesStatus;
    shouldUpdate: boolean;
    reason: string;
  };
}

// Fetches (from cache when possible) everything needed for one candidate
// and computes exactly what would be written — the single function backing
// both the dry-run report and the real apply, so they can never disagree.
async function planCandidateUpdate(
  prisma: PrismaClient,
  tmdb: TmdbClient,
  writeBatchId: string | null,
  candidate: ApplyPlanCandidate,
  userId: string,
  cacheOptions: { allowFetch: boolean; cacheFreshnessDays?: number; force?: boolean },
): Promise<PlannedCandidateUpdate> {
  const showOutcome = await getCachedOrFetch<TmdbTvDetails>(
    prisma,
    writeBatchId,
    'show',
    candidate.tmdbId,
    () => tmdb.getShowDetails(candidate.tmdbId),
    cacheOptions,
  );
  if (showOutcome.status === 'missing') {
    return {
      mytvSeriesId: candidate.mytvSeriesId,
      mytvSeriesTitle: candidate.mytvSeriesTitle,
      tmdbId: candidate.tmdbId,
      status: 'missing-tmdb-data',
      reason: `no cached TMDb show details for tmdbId ${candidate.tmdbId} and this run is not allowed to fetch live (dry-run without --force)`,
    };
  }
  const show = showOutcome.data;

  const seasonsOutcome = await fetchAllSeasons(prisma, tmdb, writeBatchId, candidate.tmdbId, show.number_of_seasons ?? 0, cacheOptions);
  if (seasonsOutcome.status === 'missing') {
    return {
      mytvSeriesId: candidate.mytvSeriesId,
      mytvSeriesTitle: candidate.mytvSeriesTitle,
      tmdbId: candidate.tmdbId,
      status: 'missing-tmdb-data',
      reason: `no cached TMDb season data for tmdbId ${candidate.tmdbId} and this run is not allowed to fetch live (dry-run without --force)`,
    };
  }
  const seasons = seasonsOutcome.data;

  const series = await prisma.series.findUnique({ where: { id: candidate.mytvSeriesId }, select: { title: true, rawMetadata: true } });
  if (!series) {
    return {
      mytvSeriesId: candidate.mytvSeriesId,
      mytvSeriesTitle: candidate.mytvSeriesTitle,
      tmdbId: candidate.tmdbId,
      status: 'missing-tmdb-data',
      reason: `Series ${candidate.mytvSeriesId} no longer exists in the database`,
    };
  }

  const titleUpdate = computeSeriesTitleUpdate(series.title);
  const fieldUpdate = computeSeriesFieldUpdate(show, mapTmdbStatusToReleaseStatus);

  const progress = await prisma.userSeriesProgress.findUnique({
    where: { userId_seriesId: { userId, seriesId: candidate.mytvSeriesId } },
    select: { userStatus: true },
  });
  const currentLiveStatus = progress?.userStatus ?? UserSeriesStatus.UNKNOWN;
  const proposedUserStatus = candidate.proposedUserStatusAfterEnrichment as UserSeriesStatus;
  const userStatusDecision = decideUserStatusUpdate(currentLiveStatus, proposedUserStatus);

  return {
    mytvSeriesId: candidate.mytvSeriesId,
    mytvSeriesTitle: candidate.mytvSeriesTitle,
    tmdbId: candidate.tmdbId,
    status: 'ready',
    series: {
      currentTitle: series.title,
      newTitle: titleUpdate.newTitle,
      titleChangeReason: titleUpdate.reason,
      overview: fieldUpdate.overview,
      posterUrl: fieldUpdate.posterUrl,
      backdropUrl: fieldUpdate.backdropUrl,
      releaseStatus: fieldUpdate.releaseStatus,
    },
    externalIds: {
      tmdbId: candidate.tmdbId,
      provider: 'tmdb',
      providerId: candidate.tmdbId,
      matchSource: candidate.realTier === 'AUTO_MATCH' ? 'tmdb-enrichment:real-auto-match' : 'tmdb-enrichment:structural-auto-match',
    },
    seasons: seasons.map((s) => ({ seasonNumber: s.season_number, title: s.name ?? null, episodeCount: s.episodes?.length ?? 0 })),
    episodes: seasons.flatMap(
      (s) =>
        s.episodes?.map((e) => ({
          seasonNumber: s.season_number,
          episodeNumber: e.episode_number,
          title: e.name ?? null,
          overview: e.overview ?? null,
          airDate: e.air_date ?? null,
          imageUrl: tmdbImageUrl(e.still_path),
        })) ?? [],
    ),
    userStatus: {
      currentLiveStatus,
      proposedUserStatus,
      shouldUpdate: userStatusDecision.shouldUpdate,
      reason: userStatusDecision.reason,
    },
  };
}

export interface ApplyRunResult {
  applied: boolean; // false for dry-run
  importBatchId: string | null;
  candidatesRequested: number;
  candidatesPlanned: PlannedCandidateUpdate[];
  candidatesReady: number;
  candidatesMissingData: number;
  candidatesWritten: number; // 0 in dry-run
}

// The single entry point run-apply-plan.ts calls. Validates against the
// plan first (resolveAndValidateCandidates) — any violation fails the
// WHOLE run before any TMDb fetch or DB write happens, per "fail the run
// instead of applying it."
export async function runApplyPlan(prisma: PrismaClient, tmdb: TmdbClient, plan: TmdbApplyPlan, options: ApplyRunOptions): Promise<ApplyRunResult> {
  const validation = resolveAndValidateCandidates(plan, options.seriesIds);
  if (!validation.ok) {
    throw new Error(`apply plan validation failed:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  const cacheOptions = { allowFetch: options.apply || !!options.force, cacheFreshnessDays: options.cacheFreshnessDays, force: options.force };

  // Bookkeeping batch created for BOTH modes (mirrors every other script in
  // this codebase — dry runs still get an ImportBatch/ImportRawRow trail)
  // EXCEPT dry-run never writes it: writeBatchId stays null unless applying,
  // so getCachedOrFetch above never persists a new cache row in dry-run
  // (only reads existing ones) and no ImportBatch/ImportIssue row is
  // created either. Dry-run is a true no-op against the database.
  let writeBatchId: string | null = null;
  if (options.apply) {
    const batch = await prisma.importBatch.create({
      data: { source: APPLY_BATCH_SOURCE, status: ImportStatus.RUNNING, startedAt: new Date() },
    });
    writeBatchId = batch.id;
  }

  const plannedUpdates: PlannedCandidateUpdate[] = [];
  for (const candidate of validation.candidates) {
    plannedUpdates.push(await planCandidateUpdate(prisma, tmdb, writeBatchId, candidate, options.userId, cacheOptions));
  }

  const ready = plannedUpdates.filter((p) => p.status === 'ready');
  const missing = plannedUpdates.filter((p) => p.status === 'missing-tmdb-data');

  if (!options.apply) {
    return {
      applied: false,
      importBatchId: null,
      candidatesRequested: validation.candidates.length,
      candidatesPlanned: plannedUpdates,
      candidatesReady: ready.length,
      candidatesMissingData: missing.length,
      candidatesWritten: 0,
    };
  }

  // Real apply: every ready candidate's writes happen in ONE transaction —
  // mirrors trakt-enrichment/run-backfill.ts's single-transaction pattern.
  // A raised timeout accounts for potentially thousands of Episode upserts
  // across ~180 series.
  await prisma.$transaction(
    async (tx) => {
      for (const plannedUpdate of ready) {
        await writeCandidateUpdate(tx, writeBatchId!, options.userId, plannedUpdate);
      }

      if (missing.length > 0) {
        await tx.importIssue.createMany({
          data: missing.map((m) => ({
            importBatchId: writeBatchId!,
            severity: ImportIssueSeverity.ERROR,
            relatedEntityType: 'Series',
            relatedEntityId: m.mytvSeriesId,
            message: `apply skipped "${m.mytvSeriesTitle}": ${m.reason}`,
          })),
        });
      }

      await tx.importBatch.update({ where: { id: writeBatchId! }, data: { status: ImportStatus.COMPLETED, finishedAt: new Date() } });
    },
    { maxWait: 10_000, timeout: 300_000 },
  );

  return {
    applied: true,
    importBatchId: writeBatchId,
    candidatesRequested: validation.candidates.length,
    candidatesPlanned: plannedUpdates,
    candidatesReady: ready.length,
    candidatesMissingData: missing.length,
    candidatesWritten: ready.length,
  };
}

async function writeCandidateUpdate(tx: Prisma.TransactionClient, importBatchId: string, userId: string, plan: PlannedCandidateUpdate): Promise<void> {
  if (plan.status !== 'ready' || !plan.series || !plan.externalIds || !plan.seasons || !plan.episodes || !plan.userStatus) {
    throw new Error(`writeCandidateUpdate called on a non-ready plan for ${plan.mytvSeriesTitle} — this is a bug, not a data issue`);
  }

  const existingSeries = await tx.series.findUnique({ where: { id: plan.mytvSeriesId }, select: { rawMetadata: true } });
  const existingRawMetadata = (existingSeries?.rawMetadata as Record<string, unknown> | null) ?? {};

  await tx.series.update({
    where: { id: plan.mytvSeriesId },
    data: {
      title: plan.series.newTitle ?? undefined,
      overview: plan.series.overview ?? undefined,
      posterUrl: plan.series.posterUrl ?? undefined,
      backdropUrl: plan.series.backdropUrl ?? undefined,
      releaseStatus: plan.series.releaseStatus,
      rawMetadata: { ...existingRawMetadata, tmdb: { fetchedAt: new Date().toISOString(), tmdbId: plan.tmdbId } } as Prisma.InputJsonValue,
      importBatchId,
    },
  });

  await tx.externalIds.upsert({
    where: { seriesId: plan.mytvSeriesId },
    create: {
      seriesId: plan.mytvSeriesId,
      tmdbId: plan.externalIds.tmdbId,
      provider: plan.externalIds.provider,
      providerId: plan.externalIds.providerId,
      matchSource: plan.externalIds.matchSource,
      matchedAt: new Date(),
      rawMetadata: { importBatchId, appliedFrom: 'tmdb-apply-plan.json' } as Prisma.InputJsonValue,
    },
    update: {
      tmdbId: plan.externalIds.tmdbId,
      provider: plan.externalIds.provider,
      providerId: plan.externalIds.providerId,
      matchSource: plan.externalIds.matchSource,
      matchedAt: new Date(),
      rawMetadata: { importBatchId, appliedFrom: 'tmdb-apply-plan.json' } as Prisma.InputJsonValue,
    },
  });

  const seasonIdByNumber = new Map<number, string>();
  for (const season of plan.seasons) {
    const row = await tx.season.upsert({
      where: { seriesId_seasonNumber: { seriesId: plan.mytvSeriesId, seasonNumber: season.seasonNumber } },
      create: { seriesId: plan.mytvSeriesId, seasonNumber: season.seasonNumber, title: season.title, rawMetadata: { tmdb: { episodeCount: season.episodeCount } } as Prisma.InputJsonValue, importBatchId },
      update: { title: season.title, rawMetadata: { tmdb: { episodeCount: season.episodeCount } } as Prisma.InputJsonValue, importBatchId },
    });
    seasonIdByNumber.set(season.seasonNumber, row.id);
  }

  for (const episode of plan.episodes) {
    const seasonId = seasonIdByNumber.get(episode.seasonNumber);
    if (!seasonId) continue;

    const existingEpisode = await tx.episode.findUnique({
      where: { seasonId_episodeNumber: { seasonId, episodeNumber: episode.episodeNumber } },
      select: { rawMetadata: true },
    });
    const existingEpisodeRawMetadata = (existingEpisode?.rawMetadata as Record<string, unknown> | null) ?? {};
    const rawMetadata = { ...existingEpisodeRawMetadata, tmdb: { seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber } } as Prisma.InputJsonValue;

    await tx.episode.upsert({
      where: { seasonId_episodeNumber: { seasonId, episodeNumber: episode.episodeNumber } },
      create: {
        seasonId,
        episodeNumber: episode.episodeNumber,
        title: episode.title,
        overview: episode.overview,
        airDate: episode.airDate ? new Date(episode.airDate) : null,
        imageUrl: episode.imageUrl ?? undefined,
        rawMetadata,
        importBatchId,
      },
      update: {
        title: episode.title,
        overview: episode.overview,
        airDate: episode.airDate ? new Date(episode.airDate) : null,
        // "imageUrl if available": only overwritten when TMDb has one —
        // never clobbers an existing image with null just because this
        // particular episode's still_path is missing.
        imageUrl: episode.imageUrl ?? undefined,
        rawMetadata,
        importBatchId,
      },
    });
  }

  if (plan.userStatus.shouldUpdate) {
    await tx.userSeriesProgress.upsert({
      where: { userId_seriesId: { userId, seriesId: plan.mytvSeriesId } },
      create: { userId, seriesId: plan.mytvSeriesId, userStatus: plan.userStatus.proposedUserStatus },
      update: { userStatus: plan.userStatus.proposedUserStatus },
    });
  }
}
