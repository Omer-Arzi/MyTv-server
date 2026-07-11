// Report shape + file-writing for the progress-reconciliation audit/apply
// tool (run-progress-reconciliation.ts). Kept separate from the orchestration
// script and from progress-reconciliation-logic.ts (pure decision logic),
// same split convention as reports.ts/apply-refresh-reports.ts already use
// for the rest of this pipeline.

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { UserSeriesStatus } from '@prisma/client';
import { ProgressMismatchType } from './progress-reconciliation-logic';

// The full set of report categories Phase 6 requires — the four real
// mismatch types from progress-reconciliation-logic.ts, plus three
// audit-specific categories that aren't part of the core reconciliation
// decision itself (a protected status, a missing tmdbId, or a clean match
// are not "mismatches" needing correction, they're reasons no correction
// was attempted or needed).
export type AuditMismatchCategory =
  | ProgressMismatchType
  | 'protected-manual-status-skipped'
  | 'no-tmdb-id-skipped'
  | 'no-mismatch';

export interface ProgressAuditEntry {
  seriesId: string;
  seriesTitle: string;
  storedUserStatus: UserSeriesStatus;
  computedUserStatus: UserSeriesStatus | null;
  storedNextEpisodeId: string | null;
  computedNextEpisodeId: string | null;
  category: AuditMismatchCategory;
  // Whether this row is a candidate for automatic apply — a 'changed'
  // mismatch on a tracked, non-protected, non-risk-listed series. Always
  // false for every non-mismatch category (nothing to apply).
  safeToApply: boolean;
  reason: string;
  // Populated only once an apply pass actually ran (see run-progress-reconciliation.ts
  // --apply) — null in a pure dry-run report.
  applied: boolean | null;
}

export interface ProgressReconciliationAuditReport {
  generatedAt: string;
  mode: 'dry-run' | 'apply';
  writesToAppTables: boolean;
  targetUserId: string;
  onlySeriesId: string | null;
  totalRowsInspected: number;
  entries: ProgressAuditEntry[];
  countsByCategory: Record<AuditMismatchCategory, number>;
  safeMismatchCount: number;
  unsafeMismatchCount: number;
  appliedCount: number;
  applyErrors: { seriesId: string; seriesTitle: string; message: string }[];
}

const ALL_CATEGORIES: AuditMismatchCategory[] = [
  'stale-caught-up-with-released-unwatched-episode',
  'stale-watching-with-no-released-unwatched-episode',
  'wrong-or-null-next-episode-id',
  'stale-completed',
  'protected-manual-status-skipped',
  'no-tmdb-id-skipped',
  'no-mismatch',
];

export function buildProgressReconciliationAuditReport(input: {
  generatedAt: Date;
  apply: boolean;
  targetUserId: string;
  onlySeriesId: string | null;
  entries: ProgressAuditEntry[];
  applyErrors: { seriesId: string; seriesTitle: string; message: string }[];
}): ProgressReconciliationAuditReport {
  const countsByCategory = Object.fromEntries(
    ALL_CATEGORIES.map((category) => [category, input.entries.filter((e) => e.category === category).length]),
  ) as Record<AuditMismatchCategory, number>;

  const safeMismatchCount = input.entries.filter((e) => e.safeToApply).length;
  const mismatchCategories: AuditMismatchCategory[] = [
    'stale-caught-up-with-released-unwatched-episode',
    'stale-watching-with-no-released-unwatched-episode',
    'wrong-or-null-next-episode-id',
    'stale-completed',
  ];
  const unsafeMismatchCount = input.entries.filter((e) => mismatchCategories.includes(e.category) && !e.safeToApply).length;

  return {
    generatedAt: input.generatedAt.toISOString(),
    mode: input.apply ? 'apply' : 'dry-run',
    writesToAppTables: input.apply,
    targetUserId: input.targetUserId,
    onlySeriesId: input.onlySeriesId,
    totalRowsInspected: input.entries.length,
    entries: input.entries,
    countsByCategory,
    safeMismatchCount,
    unsafeMismatchCount,
    appliedCount: input.entries.filter((e) => e.applied === true).length,
    applyErrors: input.applyErrors,
  };
}

export function buildProgressReconciliationMarkdownReport(report: ProgressReconciliationAuditReport): string {
  const lines: string[] = [];
  lines.push('# Episode Release Refresh — Progress Reconciliation Audit');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Mode: **${report.mode}**${report.writesToAppTables ? ' — writes were made' : ' — read-only, no writes of any kind'}`);
  lines.push(`Target user: ${report.targetUserId}`);
  if (report.onlySeriesId) lines.push(`Scoped to a single series: ${report.onlySeriesId}`);
  lines.push('');
  lines.push(`Total rows inspected: ${report.totalRowsInspected}`);
  lines.push(`Safe mismatches: ${report.safeMismatchCount}`);
  lines.push(`Unsafe/ambiguous mismatches (routed to manual review): ${report.unsafeMismatchCount}`);
  if (report.mode === 'apply') lines.push(`Applied this run: ${report.appliedCount}`);
  lines.push('');
  lines.push('## Counts by category');
  lines.push('');
  lines.push('| Category | Count |');
  lines.push('| --- | --- |');
  for (const [category, count] of Object.entries(report.countsByCategory)) {
    lines.push(`| \`${category}\` | ${count} |`);
  }
  lines.push('');

  const mismatches = report.entries.filter((e) => e.category !== 'no-mismatch');
  if (mismatches.length > 0) {
    lines.push('## Mismatches');
    lines.push('');
    lines.push('| Series | Category | Stored | Computed | Safe? | Applied? | Reason |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const e of mismatches) {
      const stored = `${e.storedUserStatus} / ${e.storedNextEpisodeId ?? 'null'}`;
      const computed = e.computedUserStatus ? `${e.computedUserStatus} / ${e.computedNextEpisodeId ?? 'null'}` : '—';
      const applied = e.applied === null ? '—' : e.applied ? 'yes' : 'no';
      lines.push(`| ${e.seriesTitle} | \`${e.category}\` | ${stored} | ${computed} | ${e.safeToApply ? 'yes' : 'no'} | ${applied} | ${e.reason} |`);
    }
    lines.push('');
  }

  if (report.applyErrors.length > 0) {
    lines.push('## Apply errors');
    lines.push('');
    lines.push('| Series | Error |');
    lines.push('| --- | --- |');
    for (const err of report.applyErrors) {
      lines.push(`| ${err.seriesTitle} | ${err.message} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export interface WrittenProgressReconciliationReportPaths {
  latestJsonPath: string;
  latestMarkdownPath: string;
  archivedJsonPath: string;
  archivedMarkdownPath: string;
}

export function writeProgressReconciliationReports(
  outDir: string,
  report: ProgressReconciliationAuditReport,
  markdown: string,
): WrittenProgressReconciliationReportPaths {
  const runsDir = path.join(outDir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  const json = JSON.stringify(report, null, 2);
  const timestamp = report.generatedAt.replace(/[:.]/g, '-');

  const latestJsonPath = path.join(outDir, 'latest-progress-reconciliation-report.json');
  const latestMarkdownPath = path.join(outDir, 'latest-progress-reconciliation-report.md');
  const archivedJsonPath = path.join(runsDir, `${timestamp}-progress-reconciliation-report.json`);
  const archivedMarkdownPath = path.join(runsDir, `${timestamp}-progress-reconciliation-report.md`);

  writeFileSync(latestJsonPath, json);
  writeFileSync(latestMarkdownPath, markdown);
  writeFileSync(archivedJsonPath, json);
  writeFileSync(archivedMarkdownPath, markdown);

  return { latestJsonPath, latestMarkdownPath, archivedJsonPath, archivedMarkdownPath };
}
