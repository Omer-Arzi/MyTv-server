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

import { ImportIssueSeverity, ImportStatus, Prisma, PrismaClient, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { TmdbClient, MAX_APPEND_TO_RESPONSE_ITEMS } from './tmdb-client';
import {
  decideTier,
  detectCloseCompetitor,
  evaluateStructuralAutoMatch,
  extractTitleYearHint,
  scoreCandidates,
  detectAnimeNumberingRisk,
  CloseCompetitorResult,
  ScoreBreakdown,
  StructuralTier,
  TitleYearHint,
} from './scoring';
import { getAppendedSeason, TmdbSeason, TmdbTvDetails, TmdbTvSearchResult } from './tmdb-types';
import { mapTmdbStatusToReleaseStatus } from './release-status-mapping';
import { proposeUserStatusAfterEnrichment } from '../src/common/derive-user-status';
import { detectDuplicateTitleGroups, detectPlaceholderTitle, detectRemakeCollision, DataQualityIssueType } from './data-quality';

const TOP_CANDIDATES_LIMIT = 5;
const NO_CLOSE_COMPETITOR: CloseCompetitorResult = { detected: false, reason: null, kind: null };

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

// Same shape as CandidateSummary, plus an explicit top-level resultPosition
// (also present inside reasonBreakdown) so a reviewer/consumer can sort or
// filter the top-5 list without digging into the breakdown.
export interface TopCandidateSummary extends CandidateSummary {
  resultPosition: number;
}

export interface AutoMatchCandidateReport {
  mytvSeriesId: string;
  mytvSeriesTitle: string;
  chosen: CandidateSummary;
  watchedEpisodeCount: number;
  tmdbTotalEpisodeCount: number;
  animeNumberingRiskDetected: boolean;
  // Candidate-visibility fields (docs/tmdb-matching-tuning-notes.md, the
  // --limit=50 report finding): the top TMDb search results, not just the
  // one that was chosen, plus whether another candidate is close enough to
  // the top one to be a real ambiguity risk.
  topCandidates: TopCandidateSummary[];
  candidateCount: number;
  closeCompetitorDetected: boolean;
  closeCompetitorReason: string | null;
  // Preview-only (docs/status-model-plan.md §7a) — what userStatus would
  // become if this candidate were applied, computed but never written.
  currentUserStatus: UserSeriesStatus;
  proposedUserStatusAfterEnrichment: UserSeriesStatus;
  userStatusChangeReason: string;
  // Same preview idea, for releaseStatus — structured fields, not just
  // embedded in userStatusChangeReason prose. Never written to Series.
  currentReleaseStatus: ReleaseStatus;
  tmdbRawStatus: string | null;
  proposedReleaseStatus: ReleaseStatus;
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
  topCandidates: TopCandidateSummary[];
  candidateCount: number;
  closeCompetitorDetected: boolean;
  closeCompetitorReason: string | null;
  currentUserStatus: UserSeriesStatus | null;
  proposedUserStatusAfterEnrichment: UserSeriesStatus | null;
  userStatusChangeReason: string | null;
  currentReleaseStatus: ReleaseStatus | null;
  tmdbRawStatus: string | null;
  proposedReleaseStatus: ReleaseStatus | null;
  // docs/tmdb-matching-tuning-notes.md §3.1 — preview-only. What tier this
  // entry would have under the proposed structural rule. Never changes real
  // apply behavior; decideTier/the actual tier above are untouched.
  proposedTierAfterStructuralRule: StructuralTier;
  structuralRuleReason: string;
}

export interface DataQualityIssueReportEntry {
  mytvSeriesId: string;
  mytvSeriesTitle: string;
  issueType: DataQualityIssueType;
  message: string;
}

export interface EnrichmentDryRunResult {
  importBatchId: string;
  seriesConsidered: number;
  autoMatchCandidates: AutoMatchCandidateReport[];
  needsReview: NeedsReviewEntry[];
  dataQualityIssues: DataQualityIssueReportEntry[];
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
    select: { id: true, title: true, releaseStatus: true },
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
  const dataQualityIssues: DataQualityIssueReportEntry[] = [];
  const issues: Prisma.ImportIssueCreateManyInput[] = [];

  function pushDataQualityIssue(seriesId: string, seriesTitle: string, issue: { type: DataQualityIssueType; message: string }) {
    dataQualityIssues.push({ mytvSeriesId: seriesId, mytvSeriesTitle: seriesTitle, issueType: issue.type, message: issue.message });
    issues.push({
      importBatchId: batch.id,
      severity: ImportIssueSeverity.WARNING,
      relatedEntityType: 'Series',
      relatedEntityId: seriesId,
      message: `data quality (${issue.type}): ${issue.message}`,
    });
  }

  for (const s of series) {
    const hint = extractTitleYearHint(s.title);
    const watchedEpisodeCount = watchedCountBySeriesId.get(s.id) ?? 0;

    const placeholderIssue = detectPlaceholderTitle(s.title);
    if (placeholderIssue) pushDataQualityIssue(s.id, s.title, placeholderIssue);

    const searchResults = await getCachedOrFetch<TmdbTvSearchResult[]>(
      'search',
      searchCacheKey(hint),
      () => tmdb.searchTv(hint.bareTitle, hint.titleYear),
    );

    const scored = scoreCandidates(hint, searchResults);
    const decision = decideTier(scored);
    const candidateCount = scored.length;
    const topCandidates = scored.slice(0, TOP_CANDIDATES_LIMIT).map((c) => ({ ...toCandidateSummary(c.result, c.breakdown), resultPosition: c.breakdown.resultPosition }));
    const closeCompetitor = topCandidates.length > 1 ? detectCloseCompetitor(topCandidates[0], topCandidates.slice(1)) : NO_CLOSE_COMPETITOR;

    if (decision.tier === 'NO_MATCH') {
      const structuralPreview = evaluateStructuralAutoMatch({
        tier: decision.tier,
        titleMatchType: decision.top?.breakdown.titleMatchType ?? 'fuzzy',
        resultPosition: decision.top?.breakdown.resultPosition ?? -1,
        watchedEpisodeCount,
        tmdbTotalEpisodeCount: 0,
        animeNumberingRiskDetected: false,
        closeCompetitorDetected: closeCompetitor.detected,
      });
      needsReview.push({
        mytvSeriesId: s.id,
        mytvSeriesTitle: s.title,
        tier: 'NO_MATCH',
        reason: decision.reason,
        topCandidate: decision.top ? toCandidateSummary(decision.top.result, decision.top.breakdown) : null,
        watchedEpisodeCount,
        tmdbTotalEpisodeCount: null,
        animeNumberingRiskDetected: null,
        topCandidates,
        candidateCount,
        closeCompetitorDetected: closeCompetitor.detected,
        closeCompetitorReason: closeCompetitor.reason,
        currentUserStatus: null,
        proposedUserStatusAfterEnrichment: null,
        userStatusChangeReason: null,
        currentReleaseStatus: null,
        tmdbRawStatus: null,
        proposedReleaseStatus: null,
        proposedTierAfterStructuralRule: structuralPreview.proposedTier,
        structuralRuleReason: structuralPreview.reason,
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

    // Re-derive topCandidates/closeCompetitor now that the chosen candidate's
    // full show details (name/year) are known — the pre-fetch versions above
    // used raw search-result fields for every position, including the one
    // that turned out to be the top match.
    const enrichedTopCandidates = topCandidates.map((c) =>
      c.tmdbId === candidateSummary.tmdbId ? { ...candidateSummary, resultPosition: c.resultPosition } : c,
    );
    const enrichedCloseCompetitor =
      enrichedTopCandidates.length > 1 ? detectCloseCompetitor(enrichedTopCandidates[0], enrichedTopCandidates.slice(1)) : NO_CLOSE_COMPETITOR;

    // Structured release-status preview fields, not just embedded in
    // userStatusChangeReason prose — see docs/tmdb-matching-tuning-notes.md
    // and docs/status-model-plan.md §7a. Still preview-only: never written
    // to Series.releaseStatus.
    const currentReleaseStatus = s.releaseStatus;
    const tmdbRawStatus = show.status ?? null;
    const proposedReleaseStatus = mapTmdbStatusToReleaseStatus(tmdbRawStatus);

    const currentUserStatus = currentUserStatusBySeriesId.get(s.id) ?? UserSeriesStatus.UNKNOWN;
    const { proposedUserStatus, reason: userStatusChangeReason } = proposeUserStatusAfterEnrichment({
      currentUserStatus,
      watchedEpisodeCount,
      totalKnownEpisodeCount: tmdbTotalEpisodeCount,
      candidateReleaseStatus: proposedReleaseStatus,
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

    const remakeCollisionIssue = detectRemakeCollision({
      mytvSeriesTitle: s.title,
      chosenTmdbTitle: candidateSummary.tmdbTitle,
      chosenTmdbYear: candidateSummary.tmdbYear,
      watchedEpisodeCount,
      tmdbTotalEpisodeCount,
      animeNumberingRiskDetected,
      closeCompetitorKind: enrichedCloseCompetitor.kind,
    });
    if (remakeCollisionIssue) pushDataQualityIssue(s.id, s.title, remakeCollisionIssue);

    if (tier === 'AUTO_MATCH') {
      autoMatchCandidates.push({
        mytvSeriesId: s.id,
        mytvSeriesTitle: s.title,
        chosen: candidateSummary,
        watchedEpisodeCount,
        tmdbTotalEpisodeCount,
        animeNumberingRiskDetected,
        topCandidates: enrichedTopCandidates,
        candidateCount,
        closeCompetitorDetected: enrichedCloseCompetitor.detected,
        closeCompetitorReason: enrichedCloseCompetitor.reason,
        currentUserStatus,
        proposedUserStatusAfterEnrichment: proposedUserStatus,
        userStatusChangeReason,
        currentReleaseStatus,
        tmdbRawStatus,
        proposedReleaseStatus,
      });
    } else {
      const structuralPreview = evaluateStructuralAutoMatch({
        tier,
        titleMatchType: top.breakdown.titleMatchType,
        resultPosition: top.breakdown.resultPosition,
        watchedEpisodeCount,
        tmdbTotalEpisodeCount,
        animeNumberingRiskDetected,
        closeCompetitorDetected: enrichedCloseCompetitor.detected,
      });
      needsReview.push({
        mytvSeriesId: s.id,
        mytvSeriesTitle: s.title,
        tier: 'NEEDS_REVIEW',
        reason,
        topCandidate: candidateSummary,
        watchedEpisodeCount,
        tmdbTotalEpisodeCount,
        animeNumberingRiskDetected,
        topCandidates: enrichedTopCandidates,
        candidateCount,
        closeCompetitorDetected: enrichedCloseCompetitor.detected,
        closeCompetitorReason: enrichedCloseCompetitor.reason,
        currentUserStatus,
        proposedUserStatusAfterEnrichment: proposedUserStatus,
        userStatusChangeReason,
        currentReleaseStatus,
        tmdbRawStatus,
        proposedReleaseStatus,
        proposedTierAfterStructuralRule: structuralPreview.proposedTier,
        structuralRuleReason: structuralPreview.reason,
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

  // Cross-series check, run once after the per-series loop (docs/tmdb-matching-tuning-notes.md,
  // the --limit=50 report finding): MyTv Series rows that share a bare title
  // but differ on year suffix, e.g. "Avatar: The Last Airbender" and
  // "Avatar: The Last Airbender (2021)" — a likely TV Time dedup artifact,
  // not something TMDb matching can resolve on its own.
  for (const group of detectDuplicateTitleGroups(series.map((s) => ({ id: s.id, title: s.title })))) {
    for (const member of group.members) {
      const siblings = group.members.filter((m) => m.id !== member.id).map((m) => `"${m.title}"`).join(', ');
      pushDataQualityIssue(member.id, member.title, {
        type: 'DUPLICATE_TITLE_DIFFERENT_YEAR_SUFFIX',
        message: `"${member.title}" shares a normalized title with ${siblings} — likely duplicate/mis-year-suffixed entries for the same show. Do not auto-merge; review manually.`,
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
    dataQualityIssues,
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
