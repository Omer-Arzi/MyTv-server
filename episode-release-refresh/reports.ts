// Report shape + file-writing for the episode-release-refresh dry run. Kept
// separate from run-refresh.ts (the orchestration loop) so the report
// structure can be read/reasoned about on its own, matching the split
// tmdb-enrichment/reports.ts and watch-next-review/reports.ts already use.

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { RefreshClassification, SeriesSkipReason } from './refresh-logic';

export interface SkippedSeriesEntry {
  seriesId: string;
  seriesTitle: string;
  userStatus: UserSeriesStatus;
  reason: SeriesSkipReason;
}

export interface RefreshedSeriesEntry {
  seriesId: string;
  seriesTitle: string;
  userStatus: UserSeriesStatus;
  currentNextEpisodeId: string | null;
  tmdbId: string;
  localEpisodeCount: number;
  providerEpisodeCount: number | null; // null only for PROVIDER_ERROR entries
  newEpisodesFound: number;
  releasedNewEpisodesFound: number;
  futureNewEpisodesFound: number;
  fieldChangeCount: number;
  releaseStatusChange: { from: ReleaseStatus; to: ReleaseStatus } | null;
  proposedNextEpisodeId: string | null;
  proposedNextEpisodeLabel: string | null;
  proposedNextEpisodeIsNew: boolean;
  nextEpisodeWouldChange: boolean;
  proposedUserStatus: UserSeriesStatus | null;
  userStatusWouldChangeToWatching: boolean;
  classification: RefreshClassification;
  warnings: string[];
}

export interface RefreshReport {
  generatedAt: string;
  mode: 'dry-run';
  writesToAppTables: false;
  targetUserId: string;
  eligibleSeriesCount: number;
  skippedSeriesCount: number;
  skippedByReason: Record<SeriesSkipReason, number>;
  skippedSeries: SkippedSeriesEntry[];
  refreshedSeries: RefreshedSeriesEntry[];
  summary: {
    NO_CHANGE: number;
    NEW_RELEASE_AVAILABLE: number;
    FUTURE_ONLY: number;
    NEEDS_MANUAL_REVIEW: number;
    RISKY_DO_NOT_APPLY: number;
    PROVIDER_ERROR: number;
  };
}

const ALL_SKIP_REASONS: SeriesSkipReason[] = ['user-status-not-tracked', 'no-tmdb-id', 'risk-list', 'release-status-finished'];

export function buildRefreshReport(input: {
  generatedAt: Date;
  targetUserId: string;
  skippedSeries: SkippedSeriesEntry[];
  refreshedSeries: RefreshedSeriesEntry[];
}): RefreshReport {
  const skippedByReason = Object.fromEntries(
    ALL_SKIP_REASONS.map((reason) => [reason, input.skippedSeries.filter((s) => s.reason === reason).length]),
  ) as Record<SeriesSkipReason, number>;

  const summary = {
    NO_CHANGE: 0,
    NEW_RELEASE_AVAILABLE: 0,
    FUTURE_ONLY: 0,
    NEEDS_MANUAL_REVIEW: 0,
    RISKY_DO_NOT_APPLY: 0,
    PROVIDER_ERROR: 0,
  };
  for (const entry of input.refreshedSeries) summary[entry.classification] += 1;

  return {
    generatedAt: input.generatedAt.toISOString(),
    mode: 'dry-run',
    writesToAppTables: false,
    targetUserId: input.targetUserId,
    eligibleSeriesCount: input.refreshedSeries.length,
    skippedSeriesCount: input.skippedSeries.length,
    skippedByReason,
    skippedSeries: input.skippedSeries,
    refreshedSeries: input.refreshedSeries,
    summary,
  };
}

const CLASSIFICATION_LABELS: Record<RefreshClassification, string> = {
  NO_CHANGE: 'No change',
  NEW_RELEASE_AVAILABLE: 'New release available',
  FUTURE_ONLY: 'Future episodes only',
  NEEDS_MANUAL_REVIEW: 'Needs manual review',
  RISKY_DO_NOT_APPLY: 'Risky — do not apply',
  PROVIDER_ERROR: 'Provider fetch error',
};

export function buildMarkdownReport(report: RefreshReport): string {
  const lines: string[] = [];
  lines.push('# Episode Release Refresh — Dry Run');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Target user: \`${report.targetUserId}\``);
  lines.push('');
  lines.push('**This report makes no changes.** No writes to Series/Season/Episode/UserSeriesProgress or any other table — see `docs/episode-release-refresh-strategy.md`.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Eligible series inspected: **${report.eligibleSeriesCount}**`);
  lines.push(`- Skipped series: **${report.skippedSeriesCount}**`);
  for (const reason of ALL_SKIP_REASONS) {
    lines.push(`  - \`${reason}\`: ${report.skippedByReason[reason]}`);
  }
  lines.push('');
  lines.push('| Classification | Count |');
  lines.push('| --- | --- |');
  for (const [classification, count] of Object.entries(report.summary)) {
    lines.push(`| ${CLASSIFICATION_LABELS[classification as RefreshClassification]} | ${count} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  const byClassification = new Map<RefreshClassification, RefreshedSeriesEntry[]>();
  for (const entry of report.refreshedSeries) {
    const bucket = byClassification.get(entry.classification) ?? [];
    bucket.push(entry);
    byClassification.set(entry.classification, bucket);
  }

  // Riskiest/most actionable first, so a reviewer scanning top-to-bottom
  // sees what needs attention before what doesn't.
  const classificationOrder: RefreshClassification[] = [
    'RISKY_DO_NOT_APPLY',
    'NEEDS_MANUAL_REVIEW',
    'PROVIDER_ERROR',
    'NEW_RELEASE_AVAILABLE',
    'FUTURE_ONLY',
    'NO_CHANGE',
  ];

  for (const classification of classificationOrder) {
    const entries = byClassification.get(classification);
    if (!entries || entries.length === 0) continue;

    lines.push(`## ${CLASSIFICATION_LABELS[classification]} (${entries.length})`);
    lines.push('');

    for (const entry of entries) {
      lines.push(`### ${entry.seriesTitle}`);
      lines.push('');
      lines.push(`- Series id: \`${entry.seriesId}\` · TMDb id: \`${entry.tmdbId}\` · userStatus: ${entry.userStatus}`);
      lines.push(`- Local episodes known: ${entry.localEpisodeCount} · Provider episodes: ${entry.providerEpisodeCount ?? 'unknown (fetch failed)'}`);
      lines.push(`- New episodes found: ${entry.newEpisodesFound} (released: ${entry.releasedNewEpisodesFound}, future: ${entry.futureNewEpisodesFound})`);
      lines.push(`- Field changes on existing episodes: ${entry.fieldChangeCount}`);
      if (entry.releaseStatusChange) {
        lines.push(`- releaseStatus would change: ${entry.releaseStatusChange.from} → ${entry.releaseStatusChange.to}`);
      }
      lines.push(
        `- nextEpisodeId: current \`${entry.currentNextEpisodeId ?? 'none'}\` → proposed ${
          entry.proposedNextEpisodeLabel ? `**${entry.proposedNextEpisodeLabel}**${entry.proposedNextEpisodeIsNew ? ' (new episode, not yet in DB)' : ` (\`${entry.proposedNextEpisodeId}\`)`}` : '_none_'
        }${entry.nextEpisodeWouldChange ? ' — **would change**' : ' — unchanged'}`,
      );
      if (entry.userStatusWouldChangeToWatching) {
        lines.push('- userStatus would move **CAUGHT_UP → WATCHING** — a new released episode is now available.');
      }
      if (entry.warnings.length > 0) {
        lines.push('- Warnings:');
        for (const warning of entry.warnings) lines.push(`  - ${warning}`);
      }
      lines.push('');
    }
  }

  if (report.skippedSeries.length > 0) {
    lines.push('## Skipped series');
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

export interface WrittenReportPaths {
  latestJsonPath: string;
  latestMarkdownPath: string;
  archivedJsonPath: string;
  archivedMarkdownPath: string;
}

// Always overwrites the two "latest" files, and additionally writes a
// timestamped copy under output/runs/ so past runs stay inspectable — the
// task calls for both. mkdirSync(..., { recursive: true }) covers "make
// sure output/runs exists" unconditionally, cheap to call every run.
export function writeRefreshReports(outDir: string, report: RefreshReport, markdown: string): WrittenReportPaths {
  const runsDir = path.join(outDir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  const json = JSON.stringify(report, null, 2);
  const timestamp = report.generatedAt.replace(/[:.]/g, '-');

  const latestJsonPath = path.join(outDir, 'latest-refresh-report.json');
  const latestMarkdownPath = path.join(outDir, 'latest-refresh-report.md');
  const archivedJsonPath = path.join(runsDir, `${timestamp}-refresh-report.json`);
  const archivedMarkdownPath = path.join(runsDir, `${timestamp}-refresh-report.md`);

  writeFileSync(latestJsonPath, json);
  writeFileSync(latestMarkdownPath, markdown);
  writeFileSync(archivedJsonPath, json);
  writeFileSync(archivedMarkdownPath, markdown);

  return { latestJsonPath, latestMarkdownPath, archivedJsonPath, archivedMarkdownPath };
}
