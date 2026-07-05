// Orchestration for the TVmaze secondary-provider dry run — mirrors
// tmdb-enrichment/enrichment-dry-run.ts's shape and safety properties
// deliberately (same caching-via-ImportRawRow pattern, same
// ImportBatch/ImportIssue bookkeeping), but is its own independent
// implementation.
//
// Deliberately never writes to Series/Season/Episode/ExternalIds/
// UserSeriesProgress/EpisodeWatch/etc — enforced structurally (no such write
// calls exist below), not by a flag. The only writes are to
// ImportBatch/ImportRawRow/ImportIssue, exactly like the TMDb/Trakt dry runs.

import { ImportIssueSeverity, ImportStatus, Prisma, PrismaClient, ReleaseStatus } from '@prisma/client';
import { TvMazeClient } from './tvmaze-client';
import {
  decideTier,
  detectAnimeNumberingRisk,
  detectCloseCompetitor,
  evaluateStructuralAutoMatch,
  extractTitleYearHint,
  scoreCandidates,
  CloseCompetitorResult,
  ScoreBreakdown,
  TitleYearHint,
} from './tvmaze-scoring';
import { categorizeComparison, computeNextEpisodeComparison, ProviderComparisonCategory, TvMazeTier } from './tvmaze-compare';
import { detectDuplicateTitleGroups, DuplicateTitleGroup } from '../tmdb-enrichment/data-quality';
import { TvMazeEpisode, TvMazeSearchResult } from './tvmaze-types';

const TOP_CANDIDATES_LIMIT = 5;
const NO_CLOSE_COMPETITOR: CloseCompetitorResult = { detected: false, reason: null, kind: null };
const BATCH_SOURCE = 'secondary-provider-audit-tvmaze';

export interface TvMazeDryRunOptions {
  userId: string;
  limit?: number;
  cacheFreshnessDays?: number;
  force?: boolean;
}

export interface CandidateSummary {
  tvmazeId: number;
  tvmazeTitle: string;
  tvmazeYear: number | null;
  confidenceScore: number;
  reasonBreakdown: ScoreBreakdown;
}

export interface SeriesComparisonReport {
  mytvSeriesId: string;
  mytvSeriesTitle: string;
  hasTmdbMatch: boolean;
  currentReleaseStatus: ReleaseStatus;
  mytvKnownEpisodeCount: number;
  watchedEpisodeCount: number;

  tvmazeTier: TvMazeTier;
  tier: TvMazeTier; // duplicate alias for readability in report consumers
  tvmazeReason: string;
  topCandidate: CandidateSummary | null;
  topCandidates: CandidateSummary[];
  candidateCount: number;
  closeCompetitorDetected: boolean;
  closeCompetitorReason: string | null;
  isDuplicateTitleGroupMember: boolean;

  tvmazeStatus: string | null;
  tvmazeRegularEpisodeCount: number | null;
  tvmazeEpisodeCountIncludingSpecials: number | null;
  animeNumberingRiskDetected: boolean;
  // Preview-only — see tvmaze-scoring.ts's evaluateStructuralAutoMatch.
  // Never changes tvmazeTier/tier above; only informs category assignment.
  structuralAutoMatchProposed: boolean;
  structuralAutoMatchReason: string;

  mytvCurrentNextEpisodeLabel: string | null;
  tvmazeProposedNextEpisodeLabel: string | null;
  tvmazeProposedNextEpisodeTitle: string | null;
  nextEpisodeTitlesComparable: boolean;
  nextEpisodeTitlesMatch: boolean | null;
  nextEpisodeComparisonNote: string;

  category: ProviderComparisonCategory;
  reasons: string[];
}

export interface TvMazeDryRunResult {
  importBatchId: string;
  seriesConsidered: number;
  comparisons: SeriesComparisonReport[];
  duplicateTitleGroups: DuplicateTitleGroup[];
  apiCallCount: number;
  cacheHitCount: number;
}

const DEFAULT_CACHE_FRESHNESS_DAYS = 30;

export async function runTvMazeDryRun(prisma: PrismaClient, tvmaze: TvMazeClient, options: TvMazeDryRunOptions): Promise<TvMazeDryRunResult> {
  const freshnessMs = (options.cacheFreshnessDays ?? DEFAULT_CACHE_FRESHNESS_DAYS) * 24 * 60 * 60 * 1000;
  let cacheHitCount = 0;

  const batch = await prisma.importBatch.create({
    data: { source: BATCH_SOURCE, status: ImportStatus.RUNNING, startedAt: new Date() },
  });

  async function getCachedOrFetch<T>(kind: string, key: string, fetchFn: () => Promise<T>): Promise<T> {
    const sourceFile = `tvmaze:${kind}:${key}`;

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
    select: {
      id: true,
      title: true,
      releaseStatus: true,
      externalIds: { select: { tmdbId: true } },
      seasons: { select: { episodes: { select: { id: true } } } },
    },
    orderBy: { title: 'asc' },
    take: options.limit,
  });

  const seriesIds = series.map((s) => s.id);

  const watchRows = await prisma.episodeWatch.findMany({
    where: { userId: options.userId, episode: { season: { seriesId: { in: seriesIds } } } },
    select: { episode: { select: { season: { select: { seriesId: true } } } } },
  });
  const watchedCountBySeriesId = new Map<string, number>();
  for (const w of watchRows) {
    const seriesId = w.episode.season.seriesId;
    watchedCountBySeriesId.set(seriesId, (watchedCountBySeriesId.get(seriesId) ?? 0) + 1);
  }

  const progressRows = await prisma.userSeriesProgress.findMany({
    where: { userId: options.userId, seriesId: { in: seriesIds } },
    select: { seriesId: true, nextEpisode: { select: { title: true, season: { select: { seasonNumber: true } }, episodeNumber: true } } },
  });
  const nextEpisodeBySeriesId = new Map(progressRows.map((p) => [p.seriesId, p.nextEpisode]));

  const duplicateGroups = detectDuplicateTitleGroups(series.map((s) => ({ id: s.id, title: s.title })));
  const duplicateSeriesIds = new Set(duplicateGroups.flatMap((g) => g.members.map((m) => m.id)));

  const comparisons: SeriesComparisonReport[] = [];
  const issues: Prisma.ImportIssueCreateManyInput[] = [];

  for (const s of series) {
    const hint = extractTitleYearHint(s.title);
    const watchedEpisodeCount = watchedCountBySeriesId.get(s.id) ?? 0;
    const hasTmdbMatch = s.externalIds?.tmdbId != null;
    const mytvKnownEpisodeCount = s.seasons.reduce((sum, season) => sum + season.episodes.length, 0);
    const currentNextEpisode = nextEpisodeBySeriesId.get(s.id) ?? null;
    const mytvCurrentNextEpisodeLabel = currentNextEpisode ? `S${currentNextEpisode.season.seasonNumber}E${currentNextEpisode.episodeNumber}` : null;

    const searchResults = await getCachedOrFetch<TvMazeSearchResult[]>('search', searchCacheKey(hint), () => tvmaze.searchShows(hint.bareTitle));

    const scored = scoreCandidates(hint, searchResults);
    const decision = decideTier(scored);
    const candidateCount = scored.length;
    const topCandidates = scored.slice(0, TOP_CANDIDATES_LIMIT).map((c) => toCandidateSummary(c.result, c.breakdown));
    const closeCompetitor =
      topCandidates.length > 1
        ? detectCloseCompetitor(toCloseCompetitorCandidate(topCandidates[0]), topCandidates.slice(1).map(toCloseCompetitorCandidate))
        : NO_CLOSE_COMPETITOR;

    if (decision.tier === 'NO_MATCH') {
      const category = categorizeComparison({
        hasTmdbMatch,
        mytvKnownEpisodeCount,
        watchedEpisodeCount,
        tvmazeTier: 'NO_MATCH',
        tvmazeRegularEpisodeCount: 0,
        tvmazeEpisodeCountIncludingSpecials: null,
        animeNumberingRiskDetected: false,
        closeCompetitorDetected: closeCompetitor.detected,
        isDuplicateTitleGroupMember: duplicateSeriesIds.has(s.id),
        structuralAutoMatchProposed: false,
      });

      comparisons.push({
        mytvSeriesId: s.id,
        mytvSeriesTitle: s.title,
        hasTmdbMatch,
        currentReleaseStatus: s.releaseStatus,
        mytvKnownEpisodeCount,
        watchedEpisodeCount,
        tvmazeTier: 'NO_MATCH',
        tier: 'NO_MATCH',
        tvmazeReason: decision.reason,
        topCandidate: decision.top ? toCandidateSummary(decision.top.result, decision.top.breakdown) : null,
        topCandidates,
        candidateCount,
        closeCompetitorDetected: closeCompetitor.detected,
        closeCompetitorReason: closeCompetitor.reason,
        isDuplicateTitleGroupMember: duplicateSeriesIds.has(s.id),
        tvmazeStatus: null,
        tvmazeRegularEpisodeCount: null,
        tvmazeEpisodeCountIncludingSpecials: null,
        animeNumberingRiskDetected: false,
        structuralAutoMatchProposed: false,
        structuralAutoMatchReason: 'current tier is NO_MATCH, not NEEDS_REVIEW — the structural rule only proposes promoting NEEDS_REVIEW entries',
        mytvCurrentNextEpisodeLabel,
        tvmazeProposedNextEpisodeLabel: null,
        tvmazeProposedNextEpisodeTitle: null,
        nextEpisodeTitlesComparable: false,
        nextEpisodeTitlesMatch: null,
        nextEpisodeComparisonNote: 'no confident TVmaze match — next-episode comparison skipped',
        category: category.category,
        reasons: [...category.reasons, decision.reason],
      });
      continue;
    }

    const top = decision.top!;
    const tvmazeId = top.result.show.id;

    const show = await getCachedOrFetch('show', String(tvmazeId), () => tvmaze.getShowWithEpisodes(tvmazeId));
    const regularEpisodes: TvMazeEpisode[] = show._embedded?.episodes ?? [];
    const tvmazeRegularEpisodeCount = regularEpisodes.length;

    const episodeCountIncludingSpecials = await getCachedOrFetch('specials-count', String(tvmazeId), () => tvmaze.getEpisodeCountIncludingSpecials(tvmazeId));

    const animeNumberingRiskDetected = detectAnimeNumberingRisk({
      watchedEpisodeCount,
      tvmazeEpisodeCount: tvmazeRegularEpisodeCount,
      genres: show.genres,
    });

    const structuralAutoMatch = evaluateStructuralAutoMatch({
      tier: decision.tier,
      titleMatchType: top.breakdown.titleMatchType,
      resultPosition: 0,
      watchedEpisodeCount,
      tvmazeEpisodeCount: tvmazeRegularEpisodeCount,
      animeNumberingRiskDetected,
      closeCompetitorDetected: closeCompetitor.detected,
    });

    const category = categorizeComparison({
      hasTmdbMatch,
      mytvKnownEpisodeCount,
      watchedEpisodeCount,
      tvmazeTier: decision.tier,
      tvmazeRegularEpisodeCount,
      tvmazeEpisodeCountIncludingSpecials: episodeCountIncludingSpecials,
      animeNumberingRiskDetected,
      closeCompetitorDetected: closeCompetitor.detected,
      isDuplicateTitleGroupMember: duplicateSeriesIds.has(s.id),
      structuralAutoMatchProposed: structuralAutoMatch.proposedTier === 'AUTO_MATCH',
    });

    const chronological = [...regularEpisodes].sort((a, b) => {
      if (a.airdate && b.airdate) return a.airdate.localeCompare(b.airdate);
      if (a.season !== b.season) return a.season - b.season;
      return (a.number ?? 0) - (b.number ?? 0);
    });
    const nextEpisodeComparison = computeNextEpisodeComparison(chronological, watchedEpisodeCount, currentNextEpisode?.title ?? null);

    if (category.category !== 'TMDB_LOOKS_CORRECT' && category.category !== 'BOTH_AGREE') {
      issues.push({
        importBatchId: batch.id,
        severity: ImportIssueSeverity.INFO,
        relatedEntityType: 'Series',
        relatedEntityId: s.id,
        message: `TVmaze secondary-provider audit for "${s.title}": ${category.category} — ${category.reasons.join('; ')}`,
      });
    }

    comparisons.push({
      mytvSeriesId: s.id,
      mytvSeriesTitle: s.title,
      hasTmdbMatch,
      currentReleaseStatus: s.releaseStatus,
      mytvKnownEpisodeCount,
      watchedEpisodeCount,
      tvmazeTier: decision.tier,
      tier: decision.tier,
      tvmazeReason: decision.reason,
      topCandidate: toCandidateSummary(top.result, top.breakdown),
      topCandidates,
      candidateCount,
      closeCompetitorDetected: closeCompetitor.detected,
      closeCompetitorReason: closeCompetitor.reason,
      isDuplicateTitleGroupMember: duplicateSeriesIds.has(s.id),
      tvmazeStatus: show.status,
      tvmazeRegularEpisodeCount,
      tvmazeEpisodeCountIncludingSpecials: episodeCountIncludingSpecials,
      animeNumberingRiskDetected,
      structuralAutoMatchProposed: structuralAutoMatch.proposedTier === 'AUTO_MATCH',
      structuralAutoMatchReason: structuralAutoMatch.reason,
      mytvCurrentNextEpisodeLabel,
      tvmazeProposedNextEpisodeLabel: nextEpisodeComparison.tvmazeProposedNextEpisodeLabel,
      tvmazeProposedNextEpisodeTitle: nextEpisodeComparison.tvmazeProposedNextEpisodeTitle,
      nextEpisodeTitlesComparable: nextEpisodeComparison.titlesComparable,
      nextEpisodeTitlesMatch: nextEpisodeComparison.titlesMatch,
      nextEpisodeComparisonNote: nextEpisodeComparison.note,
      category: category.category,
      reasons: category.reasons,
    });
  }

  if (issues.length > 0) {
    await prisma.importIssue.createMany({ data: issues });
  }

  await prisma.importBatch.update({ where: { id: batch.id }, data: { status: ImportStatus.COMPLETED, finishedAt: new Date() } });

  return {
    importBatchId: batch.id,
    seriesConsidered: series.length,
    comparisons,
    duplicateTitleGroups: duplicateGroups,
    apiCallCount: tvmaze.requestCount,
    cacheHitCount,
  };
}

function searchCacheKey(hint: TitleYearHint): string {
  const normalized = hint.bareTitle.trim().toLowerCase().replace(/\s+/g, ' ');
  return hint.titleYear ? `${normalized}:${hint.titleYear}` : normalized;
}

function toCandidateSummary(result: TvMazeSearchResult, breakdown: ScoreBreakdown): CandidateSummary {
  return {
    tvmazeId: result.show.id,
    tvmazeTitle: result.show.name,
    tvmazeYear: parseYear(result.show.premiered),
    confidenceScore: breakdown.totalScore,
    reasonBreakdown: breakdown,
  };
}

function toCloseCompetitorCandidate(c: CandidateSummary) {
  return { tvmazeId: c.tvmazeId, tvmazeTitle: c.tvmazeTitle, tvmazeYear: c.tvmazeYear, confidenceScore: c.confidenceScore };
}

function parseYear(dateString: string | null | undefined): number | null {
  if (!dateString) return null;
  const year = Number(dateString.slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
}
