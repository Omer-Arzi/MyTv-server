// Orchestration for the TMDb enrichment dry run — mirrors
// trakt-enrichment/enrichment-dry-run.ts's shape and safety properties
// deliberately (docs/tmdb-enrichment-plan.md is written as a parallel to
// docs/trakt-enrichment-plan.md), but is its own independent implementation,
// not a modification of the Trakt one.
//
// Deliberately never writes to Series/Season/Episode/ExternalIds/
// UserSeriesProgress/EpisodeWatch/EpisodeRating/EpisodeEmotion/SeriesRating —
// enforced structurally (no such write calls exist below), not by a flag.
// The only writes are to ImportBatch/ImportRawRow/ImportIssue.

import { ImportIssueSeverity, ImportStatus, Prisma, PrismaClient, UserSeriesStatus } from '@prisma/client';
import { TmdbClient, MAX_APPEND_TO_RESPONSE_ITEMS } from './tmdb-client';
import { decideTier, extractTitleYearHint, scoreCandidates, detectAnimeNumberingRisk, ScoreBreakdown, TitleYearHint } from './scoring';
import { getAppendedSeason, TmdbSeason, TmdbTvDetails, TmdbTvSearchResult } from './tmdb-types';
import { mapTmdbStatusToReleaseStatus } from './release-status-mapping';
import { proposeUserStatusAfterEnrichment } from '../src/common/derive-user-status';

const BATCH_SOURCE = 'tmdb-enrichment';

export interface EnrichmentDryRunOptions {
  userId: string;
  limit?: number;
  cacheFreshnessDays?: number;
  force?: boolean;
}

export interface CandidateSummary {
  tmdbId: string;
  tmdbTitle: string;
  tmdbYear: number | null;
  confidenceScore: number;
  reasonBreakdown: ScoreBreakdown;
}

export interface AutoMatchCandidateReport {
  mytvSeriesId: string;
  mytvSeriesTitle: string;
  chosen: CandidateSummary;
  watchedEpisodeCount: number;
  tmdbTotalEpisodeCount: number;
  animeNumberingRiskDetected: boolean;
  // Preview-only (docs/status-model-plan.md §7a) — what userStatus would
  // become if this candidate were applied, computed but never written.
  currentUserStatus: UserSeriesStatus;
  proposedUserStatusAfterEnrichment: UserSeriesStatus;
  userStatusChangeReason: string;
}

export interface NeedsReviewEntry {
  mytvSeriesId: string;
  mytvSeriesTitle: string;
  tier: 'NEEDS_REVIEW' | 'NO_MATCH';
  reason: string;
  topCandidate: CandidateSummary | null;
  watchedEpisodeCount: number | null;
  tmdbTotalEpisodeCount: number | null;
  animeNumberingRiskDetected: boolean | null;
  currentUserStatus: UserSeriesStatus | null;
  proposedUserStatusAfterEnrichment: UserSeriesStatus | null;
  userStatusChangeReason: string | null;
}

export interface EnrichmentDryRunResult {
  importBatchId: string;
  seriesConsidered: number;
  autoMatchCandidates: AutoMatchCandidateReport[];
  needsReview: NeedsReviewEntry[];
  apiCallCount: number;
  cacheHitCount: number;
}

const DEFAULT_CACHE_FRESHNESS_DAYS = 30;

export async function runEnrichmentDryRun(
  prisma: PrismaClient,
  tmdb: TmdbClient,
  options: EnrichmentDryRunOptions,
): Promise<EnrichmentDryRunResult> {
  const freshnessMs = (options.cacheFreshnessDays ?? DEFAULT_CACHE_FRESHNESS_DAYS) * 24 * 60 * 60 * 1000;
  let cacheHitCount = 0;

  const batch = await prisma.importBatch.create({
    data: { source: BATCH_SOURCE, status: ImportStatus.RUNNING, startedAt: new Date() },
  });

  async function getCachedOrFetch<T>(kind: string, key: string, fetchFn: () => Promise<T>): Promise<T> {
    const sourceFile = `tmdb:${kind}:${key}`;

    if (!options.force) {
      const cached = await prisma.importRawRow.findFirst({
        where: { sourceFile, importBatch: { source: BATCH_SOURCE } },
        orderBy: { createdAt: 'desc' },
      });
      if (cached && Date.now() - cached.createdAt.getTime() < freshnessMs) {
        cacheHitCount += 1;
        return cached.payload as T;
      }
    }

    const data = await fetchFn();
    await prisma.importRawRow.create({
      data: { importBatchId: batch.id, sourceFile, sourceRowNumber: 1, payload: data as unknown as Prisma.InputJsonValue },
    });
    return data;
  }

  const series = await prisma.series.findMany({
    where: { externalIds: null },
    select: { id: true, title: true },
    orderBy: { title: 'asc' },
    take: options.limit,
  });

  const watchedRows = await prisma.episodeWatch.findMany({
    where: { userId: options.userId },
    select: { episode: { select: { season: { select: { seriesId: true } } } } },
  });
  const watchedCountBySeriesId = new Map<string, number>();
  for (const row of watchedRows) {
    const seriesId = row.episode.season.seriesId;
    watchedCountBySeriesId.set(seriesId, (watchedCountBySeriesId.get(seriesId) ?? 0) + 1);
  }

  // Current userStatus per series, for the currentUserStatus/
  // proposedUserStatusAfterEnrichment preview fields (docs/status-model-plan.md §7a).
  const progressRows = await prisma.userSeriesProgress.findMany({
    where: { userId: options.userId },
    select: { seriesId: true, userStatus: true },
  });
  const currentUserStatusBySeriesId = new Map(progressRows.map((p) => [p.seriesId, p.userStatus]));

  const autoMatchCandidates: AutoMatchCandidateReport[] = [];
  const needsReview: NeedsReviewEntry[] = [];
  const issues: Prisma.ImportIssueCreateManyInput[] = [];

  for (const s of series) {
    const hint = extractTitleYearHint(s.title);
    const watchedEpisodeCount = watchedCountBySeriesId.get(s.id) ?? 0;

    const searchResults = await getCachedOrFetch<TmdbTvSearchResult[]>(
      'search',
      searchCacheKey(hint),
      () => tmdb.searchTv(hint.bareTitle, hint.titleYear),
    );

    const scored = scoreCandidates(hint, searchResults);
    const decision = decideTier(scored);

    if (decision.tier === 'NO_MATCH') {
      needsReview.push({
        mytvSeriesId: s.id,
        mytvSeriesTitle: s.title,
        tier: 'NO_MATCH',
        reason: decision.reason,
        topCandidate: decision.top ? toCandidateSummary(decision.top.result, decision.top.breakdown) : null,
        watchedEpisodeCount,
        tmdbTotalEpisodeCount: null,
        animeNumberingRiskDetected: null,
        currentUserStatus: null,
        proposedUserStatusAfterEnrichment: null,
        userStatusChangeReason: null,
      });
      issues.push({
        importBatchId: batch.id,
        severity: ImportIssueSeverity.WARNING,
        relatedEntityType: 'Series',
        relatedEntityId: s.id,
        message: `No confident TMDb match for "${s.title}": ${decision.reason}`,
      });
      continue;
    }

    // Both AUTO_MATCH and NEEDS_REVIEW fetch the top candidate's full data —
    // same "don't leave a reviewer starting from zero" principle as the
    // Trakt pipeline (docs/tmdb-enrichment-plan.md §3.3).
    const top = decision.top!;
    const tmdbId = String(top.result.id);

    const show = await getCachedOrFetch<TmdbTvDetails>('show', tmdbId, () => tmdb.getShowDetails(tmdbId));
    const seasons = await fetchAllSeasons(tmdb, getCachedOrFetch, tmdbId, show.number_of_seasons ?? 0);

    const tmdbTotalEpisodeCount = show.number_of_episodes ?? sumEpisodes(seasons);
    const candidateSummary = toCandidateSummary(top.result, top.breakdown, show);
    const animeNumberingRiskDetected = detectAnimeNumberingRisk({
      watchedEpisodeCount,
      tmdbTotalEpisodeCount,
      genres: show.genres,
      originalLanguage: show.original_language,
      originCountry: show.origin_country,
    });

    const currentUserStatus = currentUserStatusBySeriesId.get(s.id) ?? UserSeriesStatus.UNKNOWN;
    const { proposedUserStatus, reason: userStatusChangeReason } = proposeUserStatusAfterEnrichment({
      currentUserStatus,
      watchedEpisodeCount,
      totalKnownEpisodeCount: tmdbTotalEpisodeCount,
      candidateReleaseStatus: mapTmdbStatusToReleaseStatus(show.status),
    });

    let tier = decision.tier;
    let reason = decision.reason;

    // Post-fetch sanity check (docs/tmdb-enrichment-plan.md §3.2): watching
    // more episodes than the matched show is known to have is logically
    // impossible and downgrades an otherwise-confident match.
    if (tier === 'AUTO_MATCH' && watchedEpisodeCount > tmdbTotalEpisodeCount) {
      tier = 'NEEDS_REVIEW';
      reason = `episode-count sanity check failed: MyTv has ${watchedEpisodeCount} watched episodes for "${s.title}" but TMDb's "${show.name}" only has ${tmdbTotalEpisodeCount} known episodes${animeNumberingRiskDetected ? ' (anime-like long-running numbering risk detected — this mismatch may be a numbering-convention difference rather than a wrong match)' : ''}`;
    }

    if (tier === 'AUTO_MATCH') {
      autoMatchCandidates.push({
        mytvSeriesId: s.id,
        mytvSeriesTitle: s.title,
        chosen: candidateSummary,
        watchedEpisodeCount,
        tmdbTotalEpisodeCount,
        animeNumberingRiskDetected,
        currentUserStatus,
        proposedUserStatusAfterEnrichment: proposedUserStatus,
        userStatusChangeReason,
      });
    } else {
      needsReview.push({
        mytvSeriesId: s.id,
        mytvSeriesTitle: s.title,
        tier: 'NEEDS_REVIEW',
        reason,
        topCandidate: candidateSummary,
        watchedEpisodeCount,
        tmdbTotalEpisodeCount,
        animeNumberingRiskDetected,
        currentUserStatus,
        proposedUserStatusAfterEnrichment: proposedUserStatus,
        userStatusChangeReason,
      });
      issues.push({
        importBatchId: batch.id,
        severity: ImportIssueSeverity.WARNING,
        relatedEntityType: 'Series',
        relatedEntityId: s.id,
        message: `TMDb match for "${s.title}" needs review: ${reason}`,
      });
    }
  }

  if (issues.length > 0) {
    await prisma.importIssue.createMany({ data: issues });
  }

  await prisma.importBatch.update({
    where: { id: batch.id },
    data: { status: ImportStatus.COMPLETED, finishedAt: new Date() },
  });

  return {
    importBatchId: batch.id,
    seriesConsidered: series.length,
    autoMatchCandidates,
    needsReview,
    apiCallCount: tmdb.requestCount,
    cacheHitCount,
  };
}

function searchCacheKey(hint: TitleYearHint): string {
  const normalized = hint.bareTitle.trim().toLowerCase().replace(/\s+/g, ' ');
  return hint.titleYear ? `${normalized}:${hint.titleYear}` : normalized;
}

function toCandidateSummary(result: TmdbTvSearchResult, breakdown: ScoreBreakdown, show?: TmdbTvDetails): CandidateSummary {
  return {
    tmdbId: String(result.id),
    tmdbTitle: show?.name ?? result.name,
    tmdbYear: parseYear(show?.first_air_date ?? result.first_air_date),
    confidenceScore: breakdown.totalScore,
    reasonBreakdown: breakdown,
  };
}

function parseYear(dateString: string | null | undefined): number | null {
  if (!dateString) return null;
  const year = Number(dateString.slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
}

// Fetches every season 1..numberOfSeasons (season 0 "specials" excluded —
// out of scope for this dry run's reporting needs) in as few calls as TMDb's
// 20-item append_to_response cap allows. Simpler than bundling this into the
// show-details call (which the plan's §4 describes as the ideal) because we
// don't know numberOfSeasons until after that first call anyway — trades one
// extra request for materially simpler code, well within TMDb's rate headroom.
async function fetchAllSeasons(
  tmdb: TmdbClient,
  getCachedOrFetch: <T>(kind: string, key: string, fetchFn: () => Promise<T>) => Promise<T>,
  tmdbId: string,
  numberOfSeasons: number,
): Promise<TmdbSeason[]> {
  if (numberOfSeasons <= 0) return [];

  const seasonNumbers = Array.from({ length: numberOfSeasons }, (_, i) => i + 1);
  const seasons: TmdbSeason[] = [];

  for (let i = 0; i < seasonNumbers.length; i += MAX_APPEND_TO_RESPONSE_ITEMS) {
    const chunk = seasonNumbers.slice(i, i + MAX_APPEND_TO_RESPONSE_ITEMS);
    const batchIndex = Math.floor(i / MAX_APPEND_TO_RESPONSE_ITEMS);
    const response = await getCachedOrFetch(
      'seasons',
      `${tmdbId}:batch${batchIndex}`,
      () => tmdb.getSeasonsBatch(tmdbId, chunk),
    );
    for (const seasonNumber of chunk) {
      const season = getAppendedSeason(response, seasonNumber);
      if (season) seasons.push(season);
    }
  }

  return seasons;
}

function sumEpisodes(seasons: TmdbSeason[]): number {
  return seasons.reduce((total, season) => total + (season.episodes?.length ?? 0), 0);
}
