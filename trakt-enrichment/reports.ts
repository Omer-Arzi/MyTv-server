import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { EnrichmentDryRunResult } from './enrichment-dry-run';

export interface DryRunReportMeta {
  importBatchId: string;
  startedAt: Date;
  finishedAt: Date;
  userId: string;
}

// trakt-enrichment-report.json — the auto-match candidates plus a run
// summary. Each candidate includes exactly what docs/trakt-enrichment-plan.md
// (and this task) asks for: MyTv series id/title, chosen Trakt id/title/year,
// confidence score, reason breakdown, watched vs Trakt total episode count.
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
      traktApiCallCount: result.apiCallCount,
      cacheHitCount: result.cacheHitCount,
    },
    autoMatchCandidates: result.autoMatchCandidates.map((c) => ({
      mytvSeriesId: c.mytvSeriesId,
      mytvSeriesTitle: c.mytvSeriesTitle,
      chosenTraktId: c.chosen.traktId,
      chosenTraktTitle: c.chosen.traktTitle,
      chosenTraktYear: c.chosen.traktYear,
      confidenceScore: c.chosen.confidenceScore,
      reasonBreakdown: c.chosen.reasonBreakdown,
      watchedEpisodeCount: c.watchedEpisodeCount,
      traktTotalEpisodeCount: c.traktTotalEpisodeCount,
    })),
  };
}

// trakt-needs-review.json — everything that didn't auto-match: ambiguous
// candidates, low-confidence candidates, zero-result searches, and
// auto-match candidates that got downgraded by the episode-count sanity
// check. Mirrors the shape of the TV Time importer's needs-review.json.
export function buildNeedsReview(result: EnrichmentDryRunResult) {
  return result.needsReview.map((entry) => ({
    mytvSeriesId: entry.mytvSeriesId,
    mytvSeriesTitle: entry.mytvSeriesTitle,
    tier: entry.tier,
    reason: entry.reason,
    topCandidate: entry.topCandidate
      ? {
          traktId: entry.topCandidate.traktId,
          traktTitle: entry.topCandidate.traktTitle,
          traktYear: entry.topCandidate.traktYear,
          confidenceScore: entry.topCandidate.confidenceScore,
          reasonBreakdown: entry.topCandidate.reasonBreakdown,
        }
      : null,
    watchedEpisodeCount: entry.watchedEpisodeCount,
    traktTotalEpisodeCount: entry.traktTotalEpisodeCount,
  }));
}

export function writeDryRunReports(outDir: string, importBatchId: string, enrichmentReport: unknown, needsReview: unknown) {
  const batchDir = path.join(outDir, importBatchId);
  mkdirSync(batchDir, { recursive: true });

  writeFileSync(path.join(batchDir, 'trakt-enrichment-report.json'), JSON.stringify(enrichmentReport, null, 2));
  writeFileSync(path.join(batchDir, 'trakt-needs-review.json'), JSON.stringify(needsReview, null, 2));

  return batchDir;
}
