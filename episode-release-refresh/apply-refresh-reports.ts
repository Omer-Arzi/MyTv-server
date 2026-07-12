// Report shape + file-writing for Phase 1 apply mode. Kept separate from
// run-apply-refresh.ts (the orchestration loop) and from reports.ts (the
// dry-run report, whose shape stays untouched) for the same reasons those
// two are already split from their own callers.

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { UserSeriesStatus } from '@prisma/client';
import { RefreshClassification, SeriesSkipReason } from './refresh-logic';

export interface ApplySkippedSeriesEntry {
  seriesId: string;
  seriesTitle: string;
  userStatus: UserSeriesStatus;
  reason: SeriesSkipReason;
}

export interface ApplyProgressChange {
  userStatusFrom: UserSeriesStatus;
  userStatusTo: UserSeriesStatus;
  nextEpisodeIdFrom: string | null;
  nextEpisodeIdTo: string | null;
}

export interface ApplyProcessedSeriesEntry {
  seriesId: string;
  seriesTitle: string;
  tmdbId: string;
  userStatus: UserSeriesStatus;
  classification: RefreshClassification;
  localEpisodeCount: number;
  providerEpisodeCount: number;
  // The plan, as computed before any write was attempted — always
  // populated (both dry-run and apply mode), distinct from the *Created/
  // *Inserted fields below, which reflect actual DB write results.
  seasonsPlanned: number[];
  episodesPlanned: number;
  // Non-null only when compareSeriesCatalog's bulk-insert guard actually
  // triggered for this series (classification === SUSPICIOUS_BULK_INSERT).
  bulkInsertReason: string | null;
  // Non-null only when compareSeriesCatalog's season-0 guard actually
  // triggered for this series (classification === SEASON_ZERO_PROPOSED).
  seasonZeroReason: string | null;
  seasonsCreated: number[];
  episodesInserted: number;
  duplicatesSkipped: number;
  progressRecomputed: boolean;
  progressChange: ApplyProgressChange | null;
  // Which write path produced (or attempted) this entry's progress result —
  // 'catalog-insert' when episodes were inserted this call (applySeriesInsertPlan's
  // own recompute), 'progress-only' when nothing was inserted but progress
  // reconciliation still ran (applyProgressReconciliation — the fix for
  // docs/progress-reconciliation-architecture-todo.md's confirmed bug),
  // 'not-attempted' when neither ran (e.g. write-time eligibility failed
  // before either path was reached). Purely informational — both paths
  // share the same result shape/semantics.
  progressReconciliationSource: 'catalog-insert' | 'progress-only' | 'not-attempted';
  // Populated when episodes WERE inserted but progress specifically was
  // not recomputed this call, OR when the progress-only path ran but found
  // nothing to change.
  progressSkippedReason: string | null;
  // Populated when NOTHING was written at all for this series this call —
  // the live eligibility gate failed before any Season/Episode/Progress
  // write was attempted (a race since candidate selection). Distinct from
  // progressSkippedReason, which implies episodes WERE still inserted.
  writeSkippedReason: string | null;
  warnings: string[];
}

// Populated only when --only=<seriesId> was passed. Not derived after the
// fact from processedSeries/skippedSeries alone — writesAttempted in
// particular is tracked directly at the one call site that invokes
// applySeriesInsertPlan, so it reflects an actual attempt, not a guess
// reconstructed from counts.
export interface OnlySeriesReport {
  requestedOnlySeriesId: string;
  found: boolean;
  eligible: boolean;
  finalClassification: RefreshClassification | null;
  writesAttempted: boolean;
  message: string | null;
}

export interface ApplyRefreshReport {
  generatedAt: string;
  mode: 'apply-dry-run' | 'apply';
  writesToAppTables: boolean;
  targetUserId: string;
  onlySeriesReport: OnlySeriesReport | null;
  eligibleSeriesCount: number;
  skippedSeriesCount: number;
  skippedByReason: Record<SeriesSkipReason, number>;
  skippedSeries: ApplySkippedSeriesEntry[];
  processedSeries: ApplyProcessedSeriesEntry[];
  errors: { seriesId: string; seriesTitle: string; message: string }[];
  summary: {
    seriesBlockedByBulkGuard: number;
    seriesBlockedBySeasonZeroGuard: number;
    seasonsCreated: number;
    episodesInserted: number;
    duplicatesSkipped: number;
    seriesWithProgressRecomputed: number;
    seriesSkippedAtWriteTime: number;
    errorCount: number;
  };
}

const ALL_SKIP_REASONS: SeriesSkipReason[] = ['user-status-unknown', 'no-tmdb-id', 'risk-list'];

export function buildApplyRefreshReport(input: {
  generatedAt: Date;
  apply: boolean;
  targetUserId: string;
  onlySeriesReport?: OnlySeriesReport | null;
  skippedSeries: ApplySkippedSeriesEntry[];
  processedSeries: ApplyProcessedSeriesEntry[];
  errors: { seriesId: string; seriesTitle: string; message: string }[];
}): ApplyRefreshReport {
  const skippedByReason = Object.fromEntries(
    ALL_SKIP_REASONS.map((reason) => [reason, input.skippedSeries.filter((s) => s.reason === reason).length]),
  ) as Record<SeriesSkipReason, number>;

  const summary = {
    seriesBlockedByBulkGuard: input.processedSeries.filter((e) => e.classification === 'SUSPICIOUS_BULK_INSERT').length,
    seriesBlockedBySeasonZeroGuard: input.processedSeries.filter((e) => e.classification === 'SEASON_ZERO_PROPOSED').length,
    seasonsCreated: input.processedSeries.reduce((sum, e) => sum + e.seasonsCreated.length, 0),
    episodesInserted: input.processedSeries.reduce((sum, e) => sum + e.episodesInserted, 0),
    duplicatesSkipped: input.processedSeries.reduce((sum, e) => sum + e.duplicatesSkipped, 0),
    seriesWithProgressRecomputed: input.processedSeries.filter((e) => e.progressRecomputed).length,
    seriesSkippedAtWriteTime: input.processedSeries.filter((e) => e.writeSkippedReason !== null).length,
    errorCount: input.errors.length,
  };

  return {
    generatedAt: input.generatedAt.toISOString(),
    mode: input.apply ? 'apply' : 'apply-dry-run',
    writesToAppTables: input.apply,
    targetUserId: input.targetUserId,
    onlySeriesReport: input.onlySeriesReport ?? null,
    eligibleSeriesCount: input.processedSeries.length,
    skippedSeriesCount: input.skippedSeries.length,
    skippedByReason,
    skippedSeries: input.skippedSeries,
    processedSeries: input.processedSeries,
    errors: input.errors,
    summary,
  };
}

export function buildApplyRefreshMarkdownReport(report: ApplyRefreshReport): string {
  const lines: string[] = [];
  lines.push('# Episode Release Refresh — Phase 1 Apply');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Mode: **${report.mode}**${report.writesToAppTables ? ' (writes were made)' : ' (no writes — preview only)'}`);
  lines.push(`Target user: \`${report.targetUserId}\``);
  lines.push('');
  if (report.onlySeriesReport) {
    const o = report.onlySeriesReport;
    lines.push('## --only scope');
    lines.push('');
    lines.push(`- Requested series id: \`${o.requestedOnlySeriesId}\``);
    lines.push(`- Found: **${o.found}**`);
    lines.push(`- Eligible: **${o.eligible}**`);
    lines.push(`- Final classification: ${o.finalClassification ?? '_none — not reached_'}`);
    lines.push(`- Writes attempted: **${o.writesAttempted}**`);
    if (o.message) lines.push(`- ${o.message}`);
    lines.push('');
  }
  lines.push('Phase 1 scope: create missing Season rows and genuinely new, already-released Episode rows only. Never');
  lines.push('updates/deletes an existing Episode, never touches EpisodeWatch, never applies metadata fieldChanges, never');
  lines.push('writes Series.releaseStatus. UserSeriesProgress is recomputed only for a series where at least one episode');
  lines.push('was actually inserted. A series whose proposed insert count is suspiciously large relative to its local');
  lines.push('catalog (more than 10 released episodes, or more than half the local catalog for an already-established');
  lines.push('series) is blocked entirely — see "Blocked — suspicious bulk insert" below. A series proposing any');
  lines.push('released season-0 (specials) episode is also blocked entirely, since Phase 1 has no dedicated season-0');
  lines.push('handling or tests — see "Blocked — season 0 proposed" below.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Eligible series inspected: **${report.eligibleSeriesCount}**`);
  lines.push(`- Skipped series (ineligible before any TMDb fetch): **${report.skippedSeriesCount}**`);
  for (const reason of ALL_SKIP_REASONS) {
    lines.push(`  - \`${reason}\`: ${report.skippedByReason[reason]}`);
  }
  lines.push(`- Blocked by suspicious-bulk-insert guard: **${report.summary.seriesBlockedByBulkGuard}**`);
  lines.push(`- Blocked by season-0 guard: **${report.summary.seriesBlockedBySeasonZeroGuard}**`);
  lines.push(`- Seasons created: **${report.summary.seasonsCreated}**`);
  lines.push(`- Episodes inserted: **${report.summary.episodesInserted}**`);
  lines.push(`- Duplicate episodes skipped (already existed at write time): **${report.summary.duplicatesSkipped}**`);
  lines.push(`- Series with progress recomputed: **${report.summary.seriesWithProgressRecomputed}**`);
  lines.push(`- Series skipped at write time (live status raced since candidate selection): **${report.summary.seriesSkippedAtWriteTime}**`);
  lines.push(`- Errors: **${report.summary.errorCount}**`);
  lines.push('');
  lines.push('---');
  lines.push('');

  const blockedBySeasonZeroGuard = report.processedSeries.filter((e) => e.classification === 'SEASON_ZERO_PROPOSED');
  const blockedByBulkGuard = report.processedSeries.filter((e) => e.classification === 'SUSPICIOUS_BULK_INSERT');
  const withPlan = report.processedSeries.filter(
    (e) => e.episodesPlanned > 0 && e.classification !== 'SUSPICIOUS_BULK_INSERT' && e.classification !== 'SEASON_ZERO_PROPOSED',
  );
  const withoutPlan = report.processedSeries.filter(
    (e) => e.episodesPlanned === 0 && e.classification !== 'SUSPICIOUS_BULK_INSERT' && e.classification !== 'SEASON_ZERO_PROPOSED',
  );

  if (blockedBySeasonZeroGuard.length > 0) {
    lines.push(`## Blocked — season 0 proposed (${blockedBySeasonZeroGuard.length})`);
    lines.push('');
    lines.push('These series have at least one released new episode in season 0 (specials). Phase 1 has no dedicated');
    lines.push('season-0 handling or tests, so the entire series is blocked — zero writes, including any non-season-0');
    lines.push('episodes in the same proposed batch, so the write stays an atomic, reviewable per-series unit.');
    lines.push('');
    for (const entry of blockedBySeasonZeroGuard) {
      lines.push(`### ${entry.seriesTitle}`);
      lines.push('');
      lines.push(`- Series id: \`${entry.seriesId}\` · TMDb id: \`${entry.tmdbId}\` · userStatus: ${entry.userStatus}`);
      lines.push(`- Local episode count: ${entry.localEpisodeCount} · Provider episode count: ${entry.providerEpisodeCount}`);
      lines.push(`- Proposed released insert count: ${entry.episodesPlanned} · Proposed new season count: ${entry.seasonsPlanned.length}`);
      lines.push(`- **Threshold triggered:** ${entry.seasonZeroReason}`);
      lines.push('');
    }
  }

  if (blockedByBulkGuard.length > 0) {
    lines.push(`## Blocked — suspicious bulk insert (${blockedByBulkGuard.length})`);
    lines.push('');
    lines.push('These series produced a released-insert count large enough relative to their local catalog that it looks');
    lines.push('like an incomplete/stale local catalog rather than a genuine new release. Zero writes were made for any of them.');
    lines.push('');
    for (const entry of blockedByBulkGuard) {
      lines.push(`### ${entry.seriesTitle}`);
      lines.push('');
      lines.push(`- Series id: \`${entry.seriesId}\` · TMDb id: \`${entry.tmdbId}\` · userStatus: ${entry.userStatus}`);
      lines.push(`- Local episode count: ${entry.localEpisodeCount} · Provider episode count: ${entry.providerEpisodeCount}`);
      lines.push(`- Proposed released insert count: ${entry.episodesPlanned} · Proposed new season count: ${entry.seasonsPlanned.length}`);
      lines.push(`- **Threshold triggered:** ${entry.bulkInsertReason}`);
      lines.push('');
    }
  }

  if (withPlan.length > 0) {
    lines.push(`## Series with episodes planned or inserted (${withPlan.length})`);
    lines.push('');
    for (const entry of withPlan) {
      lines.push(`### ${entry.seriesTitle}`);
      lines.push('');
      lines.push(`- Series id: \`${entry.seriesId}\` · TMDb id: \`${entry.tmdbId}\` · userStatus: ${entry.userStatus} · classification: ${entry.classification}`);
      lines.push(`- Local episode count: ${entry.localEpisodeCount} · Provider episode count: ${entry.providerEpisodeCount}`);
      lines.push(`- Seasons planned: ${entry.seasonsPlanned.length > 0 ? entry.seasonsPlanned.join(', ') : 'none'} · created: ${entry.seasonsCreated.length > 0 ? entry.seasonsCreated.join(', ') : 'none'}`);
      lines.push(`- Episodes planned: ${entry.episodesPlanned} · inserted: ${entry.episodesInserted} · duplicates skipped: ${entry.duplicatesSkipped}`);
      if (entry.writeSkippedReason) {
        lines.push(`- **Write skipped:** ${entry.writeSkippedReason}`);
      } else if (entry.progressRecomputed && entry.progressChange) {
        lines.push(
          `- Progress recomputed: userStatus ${entry.progressChange.userStatusFrom} → ${entry.progressChange.userStatusTo}, nextEpisodeId \`${entry.progressChange.nextEpisodeIdFrom ?? 'none'}\` → \`${entry.progressChange.nextEpisodeIdTo ?? 'none'}\``,
        );
      } else if (entry.progressSkippedReason) {
        lines.push(`- Progress NOT recomputed: ${entry.progressSkippedReason}`);
      }
      if (entry.warnings.length > 0) {
        lines.push('- Warnings:');
        for (const warning of entry.warnings) lines.push(`  - ${warning}`);
      }
      lines.push('');
    }
  }

  if (withoutPlan.length > 0) {
    lines.push(`## Series with no episodes inserted (${withoutPlan.length})`);
    lines.push('');
    lines.push('| Series | userStatus | classification |');
    lines.push('| --- | --- | --- |');
    for (const entry of withoutPlan) {
      lines.push(`| ${entry.seriesTitle} | ${entry.userStatus} | ${entry.classification} |`);
    }
    lines.push('');
  }

  if (report.errors.length > 0) {
    lines.push(`## Errors (${report.errors.length})`);
    lines.push('');
    lines.push('| Series | Error |');
    lines.push('| --- | --- |');
    for (const error of report.errors) {
      lines.push(`| ${error.seriesTitle} | ${error.message} |`);
    }
    lines.push('');
  }

  if (report.skippedSeries.length > 0) {
    lines.push('## Skipped series (ineligible)');
    lines.push('');
    lines.push('| Series | userStatus | Reason |');
    lines.push('| --- | --- | --- |');
    for (const skipped of report.skippedSeries) {
      lines.push(`| ${skipped.seriesTitle} | ${skipped.userStatus} | \`${skipped.reason}\` |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export interface WrittenApplyReportPaths {
  latestJsonPath: string;
  latestMarkdownPath: string;
  archivedJsonPath: string;
  archivedMarkdownPath: string;
}

export function writeApplyRefreshReports(outDir: string, report: ApplyRefreshReport, markdown: string): WrittenApplyReportPaths {
  const runsDir = path.join(outDir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  const json = JSON.stringify(report, null, 2);
  const timestamp = report.generatedAt.replace(/[:.]/g, '-');

  const latestJsonPath = path.join(outDir, 'latest-apply-refresh-report.json');
  const latestMarkdownPath = path.join(outDir, 'latest-apply-refresh-report.md');
  const archivedJsonPath = path.join(runsDir, `${timestamp}-apply-refresh-report.json`);
  const archivedMarkdownPath = path.join(runsDir, `${timestamp}-apply-refresh-report.md`);

  writeFileSync(latestJsonPath, json);
  writeFileSync(latestMarkdownPath, markdown);
  writeFileSync(archivedJsonPath, json);
  writeFileSync(archivedMarkdownPath, markdown);

  return { latestJsonPath, latestMarkdownPath, archivedJsonPath, archivedMarkdownPath };
}
