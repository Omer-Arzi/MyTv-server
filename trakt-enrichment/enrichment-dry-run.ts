// Orchestration for the Trakt enrichment dry run: for each un-enriched
// Series, search Trakt, score candidates (scoring.ts), and — for anything
// scoring well enough to be worth a closer look — fetch the show + full
// episode catalog to compare against what MyTv already knows was watched.
//
// Deliberately never writes to Series/Season/Episode/ExternalIds — this is
// enforced structurally (no such write calls exist below), not by a
// --dry-run flag, per the task's hard requirement. The only writes are to
// the import-bookkeeping tables (ImportBatch/ImportRawRow/ImportIssue),
// which is exactly what "cache raw responses" and "produce a needs-review
// report" require.

import { ImportIssueSeverity, ImportStatus, Prisma, PrismaClient, UserSeriesStatus } from '@prisma/client';
import { TraktClient } from './trakt-client';
import { decideTier, extractTitleYearHint, normalizeTitle, scoreCandidates, ScoreBreakdown } from './scoring';
import { mapTraktStatusToReleaseStatus } from './release-status-mapping';
import { TraktSearchResult, TraktSeasonWithEpisodes, TraktShowFull } from './trakt-types';
import { proposeUserStatusAfterEnrichment } from '../src/common/derive-user-status';

const BATCH_SOURCE = 'trakt-enrichment';

export interface EnrichmentDryRunOptions {
  userId: string;
  limit?: number;
  cacheFreshnessDays?: number;
  force?: boolean;
}

export interface CandidateSummary {
  traktId: string;
  traktTitle: string;
  traktYear: number | null;
  confidenceScore: number;
  reasonBreakdown: ScoreBreakdown;
}

export interface AutoMatchCandidateReport {
  mytvSeriesId: string;
  mytvSeriesTitle: string;
  chosen: CandidateSummary;
  watchedEpisodeCount: number;
  traktTotalEpisodeCount: number;
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
  traktTotalEpisodeCount: number | null;
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
  trakt: TraktClient,
  options: EnrichmentDryRunOptions,
): Promise<EnrichmentDryRunResult> {
  const freshnessMs = (options.cacheFreshnessDays ?? DEFAULT_CACHE_FRESHNESS_DAYS) * 24 * 60 * 60 * 1000;
  let cacheHitCount = 0;

  const batch = await prisma.importBatch.create({
    data: { source: BATCH_SOURCE, status: ImportStatus.RUNNING, startedAt: new Date() },
  });

  async function getCachedOrFetch<T>(kind: string, key: string, fetchFn: () => Promise<T>): Promise<T> {
    const sourceFile = `trakt:${kind}:${key}`;

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
      data: {
        importBatchId: batch.id,
        sourceFile,
        sourceRowNumber: 1,
        payload: data as unknown as Prisma.InputJsonValue,
      },
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

    const searchResults = await getCachedOrFetch<TraktSearchResult[]>('search', normalizeTitle(hint.bareTitle), () =>
      trakt.searchShow(hint.bareTitle),
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
        traktTotalEpisodeCount: null,
        currentUserStatus: null,
        proposedUserStatusAfterEnrichment: null,
        userStatusChangeReason: null,
      });
      issues.push({
        importBatchId: batch.id,
        severity: ImportIssueSeverity.WARNING,
        relatedEntityType: 'Series',
        relatedEntityId: s.id,
        message: `No confident Trakt match for "${s.title}": ${decision.reason}`,
      });
      continue;
    }

    // Both AUTO_MATCH and NEEDS_REVIEW fetch the top candidate's full data —
    // an ambiguous/low-confidence match still gets cached so a human
    // reviewer isn't starting from zero (docs/trakt-enrichment-plan.md §3.3).
    const top = decision.top!;
    const traktId = String(top.result.show.ids.trakt);

    const [show, seasons] = await Promise.all([
      getCachedOrFetch<TraktShowFull>('show', traktId, () => trakt.getShow(traktId)),
      getCachedOrFetch<TraktSeasonWithEpisodes[]>('seasons', traktId, () => trakt.getSeasonsWithEpisodes(traktId)),
    ]);

    const traktTotalEpisodeCount = sumAiredEpisodes(seasons);
    const candidateSummary = toCandidateSummary(top.result, top.breakdown, show);

    const currentUserStatus = currentUserStatusBySeriesId.get(s.id) ?? UserSeriesStatus.UNKNOWN;
    const { proposedUserStatus, reason: userStatusChangeReason } = proposeUserStatusAfterEnrichment({
      currentUserStatus,
      watchedEpisodeCount,
      totalKnownEpisodeCount: traktTotalEpisodeCount,
      candidateReleaseStatus: mapTraktStatusToReleaseStatus(show.status),
    });

    let tier = decision.tier;
    let reason = decision.reason;

    // Post-fetch sanity check (docs/trakt-enrichment-plan.md §3.2): watching
    // more episodes than the matched show is known to have is logically
    // impossible and downgrades an otherwise-confident match.
    if (tier === 'AUTO_MATCH' && watchedEpisodeCount > traktTotalEpisodeCount) {
      tier = 'NEEDS_REVIEW';
      reason = `episode-count sanity check failed: MyTv has ${watchedEpisodeCount} watched episodes for "${s.title}" but Trakt's "${top.result.show.title}" only has ${traktTotalEpisodeCount} aired episodes`;
    }

    if (tier === 'AUTO_MATCH') {
      autoMatchCandidates.push({
        mytvSeriesId: s.id,
        mytvSeriesTitle: s.title,
        chosen: candidateSummary,
        watchedEpisodeCount,
        traktTotalEpisodeCount,
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
        traktTotalEpisodeCount,
        currentUserStatus,
        proposedUserStatusAfterEnrichment: proposedUserStatus,
        userStatusChangeReason,
      });
      issues.push({
        importBatchId: batch.id,
        severity: ImportIssueSeverity.WARNING,
        relatedEntityType: 'Series',
        relatedEntityId: s.id,
        message: `Trakt match for "${s.title}" needs review: ${reason}`,
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
    apiCallCount: trakt.requestCount,
    cacheHitCount,
  };
}

function toCandidateSummary(result: TraktSearchResult, breakdown: ScoreBreakdown, show?: TraktShowFull): CandidateSummary {
  return {
    traktId: String(result.show.ids.trakt),
    traktTitle: show?.title ?? result.show.title,
    traktYear: show?.year ?? result.show.year,
    confidenceScore: breakdown.totalScore,
    reasonBreakdown: breakdown,
  };
}

function sumAiredEpisodes(seasons: TraktSeasonWithEpisodes[]): number {
  return seasons.reduce((total, season) => {
    if (typeof season.aired_episodes === 'number') return total + season.aired_episodes;
    if (typeof season.episode_count === 'number') return total + season.episode_count;
    if (Array.isArray(season.episodes)) return total + season.episodes.length;
    return total;
  }, 0);
}
