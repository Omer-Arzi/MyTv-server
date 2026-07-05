import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { SeriesComparisonReport, TvMazeDryRunResult } from './tvmaze-dry-run';

export interface DryRunReportMeta {
  importBatchId: string;
  startedAt: Date;
  finishedAt: Date;
  userId: string;
}

const SAFE_IMPROVEMENT_CATEGORIES = new Set(['TVMAZE_LOOKS_BETTER', 'BOTH_AGREE']);
const NEEDS_REVIEW_CATEGORIES = new Set([
  'BOTH_UNCERTAIN',
  'POSSIBLE_REMAKE_COLLISION',
  'POSSIBLE_ANIME_NUMBERING_MISMATCH',
  'POSSIBLE_SPECIALS_MISMATCH',
  'WATCHED_COUNT_EXCEEDS_PROVIDER_CATALOG',
]);

// tvmaze-match-report.json — every series considered, full comparison detail.
export function buildMatchReport(meta: DryRunReportMeta, result: TvMazeDryRunResult) {
  const counts: Record<string, number> = {};
  for (const c of result.comparisons) counts[c.category] = (counts[c.category] ?? 0) + 1;

  return {
    importBatchId: result.importBatchId,
    userId: meta.userId,
    startedAt: meta.startedAt.toISOString(),
    finishedAt: meta.finishedAt.toISOString(),
    durationMs: meta.finishedAt.getTime() - meta.startedAt.getTime(),
    writesToAppTables: false,
    summary: {
      seriesConsidered: result.seriesConsidered,
      apiCallCount: result.apiCallCount,
      cacheHitCount: result.cacheHitCount,
      duplicateTitleGroupCount: result.duplicateTitleGroups.length,
      byCategory: counts,
    },
    comparisons: result.comparisons,
    duplicateTitleGroups: result.duplicateTitleGroups,
  };
}

// tvmaze-needs-review.json — everything that isn't a clean SAFE improvement:
// ambiguous, uncertain, or flagged for a specific reason (remake/anime/
// specials/over-watched). Nothing here is applied automatically.
export function buildNeedsReview(result: TvMazeDryRunResult): SeriesComparisonReport[] {
  return result.comparisons.filter((c) => NEEDS_REVIEW_CATEGORIES.has(c.category));
}

// tvmaze-safe-improvements.json — candidates where TVmaze either confirms
// the existing TMDb match (BOTH_AGREE) or offers a confident match where
// none exists yet (TVMAZE_LOOKS_BETTER). "Safe" here means safe to REVIEW
// next, not safe to auto-apply — nothing in this pipeline writes to
// ExternalIds/Series/Episode; see run-tvmaze-dry-run.ts's header.
export function buildSafeImprovements(result: TvMazeDryRunResult): SeriesComparisonReport[] {
  return result.comparisons.filter((c) => SAFE_IMPROVEMENT_CATEGORIES.has(c.category));
}

export function writeDryRunReports(outDir: string, importBatchId: string, matchReport: unknown, needsReview: unknown, safeImprovements: unknown) {
  const batchDir = path.join(outDir, importBatchId);
  mkdirSync(batchDir, { recursive: true });

  writeFileSync(path.join(batchDir, 'tvmaze-match-report.json'), JSON.stringify(matchReport, null, 2));
  writeFileSync(path.join(batchDir, 'tvmaze-needs-review.json'), JSON.stringify(needsReview, null, 2));
  writeFileSync(path.join(batchDir, 'tvmaze-safe-improvements.json'), JSON.stringify(safeImprovements, null, 2));

  return batchDir;
}
