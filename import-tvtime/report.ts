import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { SENSITIVE_EXCLUDED_FILES } from './denylist';
import { RawImportResult } from './raw-import';
import { NormalizeResult } from './normalize-watched-episodes';
import { ImportIssueInput } from './types';

export interface ImportReportInput {
  importBatchId: string;
  source: string;
  sourceDir: string;
  userId: string;
  dryRun: boolean;
  startedAt: Date;
  finishedAt: Date;
  rawImport: RawImportResult;
  normalize: NormalizeResult;
}

// import-report.json — the run summary: what was read, what was written,
// and an explicit note on what this pass deliberately does NOT normalize
// yet (ratings/emotions/notes — see docs/tvtime-data-audit.md §3.3-3.5),
// so a reader doesn't have to infer scope from what's absent.
export function buildImportReport(input: ImportReportInput) {
  const issueCounts = countBySeverity(input.normalize.issues);

  return {
    importBatchId: input.importBatchId,
    source: input.source,
    sourceDir: input.sourceDir,
    targetUserId: input.userId,
    dryRun: input.dryRun,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    rawImport: {
      filesImported: input.rawImport.importedFiles.length,
      filesExcludedSensitive: input.rawImport.excludedFiles.length,
      totalRowsRead: input.rawImport.totalRowsRead,
      totalRowsImported: input.rawImport.totalRowsImported,
      perFile: input.rawImport.importedFiles,
    },
    normalize: {
      scope: 'tracking-prod-records-v2.csv only (watched episodes + watchlist snapshot)',
      notYetNormalized: [
        'ratings (ratings-3-prod-episode_votes.csv, ratings-prod-episode_votes.csv, tv_show_rate.csv, ...)',
        'emotions (emotions-3-prod-episode_votes.csv, episode_emotion.csv, ...)',
        'notes/comments (episode_comment.csv)',
        'raw rows for these are stored in ImportRawRow and preserved for a future normalization pass',
      ],
      seriesCreated: input.normalize.seriesCreated,
      seriesReused: input.normalize.seriesReused,
      episodeWatchesCreated: input.normalize.episodeWatchesCreated,
      episodeWatchesUpdated: input.normalize.episodeWatchesUpdated,
      episodeWatchesSkippedExisting: input.normalize.episodeWatchesSkippedExisting,
      watchlistItemsUpserted: input.normalize.watchlistItemsUpserted,
      userSeriesProgressUpserted: input.normalize.userSeriesProgressUpserted,
      issueCounts,
    },
  };
}

export function buildNeedsReview(issues: ImportIssueInput[]) {
  return issues
    .filter((i) => i.severity === 'WARNING' || i.severity === 'ERROR')
    .map((i) => ({
      severity: i.severity,
      sourceFile: i.sourceFile ?? null,
      sourceRowNumber: i.sourceRowNumber ?? null,
      relatedEntityType: i.relatedEntityType ?? null,
      relatedEntityId: i.relatedEntityId ?? null,
      message: i.message,
    }));
}

// skipped-sensitive-fields.json — the policy (what's ALWAYS excluded) plus
// what this specific run actually redacted, so the policy is auditable
// against real behavior instead of just documented in prose.
export function buildSkippedSensitiveFields(rawImport: RawImportResult) {
  const fieldRedactions: Record<string, { field: string; rowCount: number }[]> = {};
  for (const file of rawImport.importedFiles) {
    if (file.fieldsRedacted.length > 0) {
      fieldRedactions[file.file] = file.fieldsRedacted;
    }
  }

  return {
    policy: {
      wholesaleExcludedFiles: SENSITIVE_EXCLUDED_FILES,
    },
    thisRun: {
      filesExcluded: rawImport.excludedFiles.map((f) => f.file),
      fieldRedactionsByFile: fieldRedactions,
    },
  };
}

function countBySeverity(issues: ImportIssueInput[]) {
  return {
    info: issues.filter((i) => i.severity === 'INFO').length,
    warning: issues.filter((i) => i.severity === 'WARNING').length,
    error: issues.filter((i) => i.severity === 'ERROR').length,
  };
}

export function writeReports(outDir: string, importBatchId: string, reports: {
  importReport: unknown;
  needsReview: unknown;
  skippedSensitiveFields: unknown;
}) {
  const batchDir = path.join(outDir, importBatchId);
  mkdirSync(batchDir, { recursive: true });

  writeFileSync(path.join(batchDir, 'import-report.json'), JSON.stringify(reports.importReport, null, 2));
  writeFileSync(path.join(batchDir, 'needs-review.json'), JSON.stringify(reports.needsReview, null, 2));
  writeFileSync(
    path.join(batchDir, 'skipped-sensitive-fields.json'),
    JSON.stringify(reports.skippedSensitiveFields, null, 2),
  );

  return batchDir;
}
