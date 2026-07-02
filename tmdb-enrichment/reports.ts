import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { EnrichmentDryRunResult } from './enrichment-dry-run';

export interface DryRunReportMeta {
  importBatchId: string;
  startedAt: Date;
  finishedAt: Date;
  userId: string;
}

// tmdb-enrichment-report.json — the auto-match candidates plus a run
// summary. Each candidate includes exactly what this task (and
// docs/tmdb-enrichment-plan.md) asks for: MyTv series id/title, chosen TMDb
// id/title/year, confidence score, reason breakdown, watched vs TMDb-known
// episode count, whether long-running/anime-like numbering risk was
// detected, and (docs/status-model-plan.md §7a) a preview of what
// userStatus would become if this candidate were applied —
// currentUserStatus/proposedUserStatusAfterEnrichment/
// userStatusChangeReason. Preview only: nothing here is written to
// UserSeriesProgress. Same idea for releaseStatus, as real structured
// fields rather than only embedded in userStatusChangeReason prose —
// currentReleaseStatus/tmdbRawStatus/proposedReleaseStatus. Preview only:
// nothing here is written to Series.releaseStatus.
export function buildEnrichmentReport(meta: DryRunReportMeta, result: EnrichmentDryRunResult) {
  return {
    importBatchId: result.importBatchId,
    userId: meta.userId,
    startedAt: meta.startedAt.toISOString(),
    finishedAt: meta.finishedAt.toISOString(),
    durationMs: meta.finishedAt.getTime() - meta.startedAt.getTime(),
    writesToAppTables: false,
    summary: {
      seriesConsidered: result.seriesConsidered,
      autoMatchCount: result.autoMatchCandidates.length,
      needsReviewCount: result.needsReview.filter((n) => n.tier === 'NEEDS_REVIEW').length,
      noMatchCount: result.needsReview.filter((n) => n.tier === 'NO_MATCH').length,
      animeNumberingRiskCount: result.autoMatchCandidates.filter((c) => c.animeNumberingRiskDetected).length,
      tmdbApiCallCount: result.apiCallCount,
      cacheHitCount: result.cacheHitCount,
    },
    autoMatchCandidates: result.autoMatchCandidates.map((c) => ({
      mytvSeriesId: c.mytvSeriesId,
      mytvSeriesTitle: c.mytvSeriesTitle,
      chosenTmdbId: c.chosen.tmdbId,
      chosenTmdbTitle: c.chosen.tmdbTitle,
      chosenTmdbYear: c.chosen.tmdbYear,
      confidenceScore: c.chosen.confidenceScore,
      reasonBreakdown: c.chosen.reasonBreakdown,
      watchedEpisodeCount: c.watchedEpisodeCount,
      tmdbTotalEpisodeCount: c.tmdbTotalEpisodeCount,
      animeNumberingRiskDetected: c.animeNumberingRiskDetected,
      currentUserStatus: c.currentUserStatus,
      proposedUserStatusAfterEnrichment: c.proposedUserStatusAfterEnrichment,
      userStatusChangeReason: c.userStatusChangeReason,
      currentReleaseStatus: c.currentReleaseStatus,
      tmdbRawStatus: c.tmdbRawStatus,
      proposedReleaseStatus: c.proposedReleaseStatus,
    })),
  };
}

// tmdb-needs-review.json — ambiguous/low-confidence/no-match/downgraded
// entries. Same shape as trakt-needs-review.json so a future combined
// reviewer tool can treat both providers identically.
export function buildNeedsReview(result: EnrichmentDryRunResult) {
  return result.needsReview.map((entry) => ({
    mytvSeriesId: entry.mytvSeriesId,
    mytvSeriesTitle: entry.mytvSeriesTitle,
    tier: entry.tier,
    reason: entry.reason,
    topCandidate: entry.topCandidate
      ? {
          tmdbId: entry.topCandidate.tmdbId,
          tmdbTitle: entry.topCandidate.tmdbTitle,
          tmdbYear: entry.topCandidate.tmdbYear,
          confidenceScore: entry.topCandidate.confidenceScore,
          reasonBreakdown: entry.topCandidate.reasonBreakdown,
        }
      : null,
    watchedEpisodeCount: entry.watchedEpisodeCount,
    tmdbTotalEpisodeCount: entry.tmdbTotalEpisodeCount,
    animeNumberingRiskDetected: entry.animeNumberingRiskDetected,
    currentUserStatus: entry.currentUserStatus,
    proposedUserStatusAfterEnrichment: entry.proposedUserStatusAfterEnrichment,
    userStatusChangeReason: entry.userStatusChangeReason,
    currentReleaseStatus: entry.currentReleaseStatus,
    tmdbRawStatus: entry.tmdbRawStatus,
    proposedReleaseStatus: entry.proposedReleaseStatus,
  }));
}

export function writeDryRunReports(outDir: string, importBatchId: string, enrichmentReport: unknown, needsReview: unknown) {
  const batchDir = path.join(outDir, importBatchId);
  mkdirSync(batchDir, { recursive: true });

  writeFileSync(path.join(batchDir, 'tmdb-enrichment-report.json'), JSON.stringify(enrichmentReport, null, 2));
  writeFileSync(path.join(batchDir, 'tmdb-needs-review.json'), JSON.stringify(needsReview, null, 2));

  return batchDir;
}
