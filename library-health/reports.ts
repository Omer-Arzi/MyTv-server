// Report shape + file-writing for the Library Health report. Kept separate
// from run-health-report.ts (the orchestration loop) so the report
// structure can be read/reasoned about on its own — same split as
// episode-release-refresh/reports.ts.

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { LibraryHealthClassification, SeriesHealthResult } from './health-logic';

export interface LibraryHealthSummary {
  totalSeries: number;
  countByClassification: Record<LibraryHealthClassification, number>;
  providerCoverageCount: number;
  posterCoverageCount: number;
  episodeCatalogCoverageCount: number;
  activeTrackedCount: number;
  trustedWatchNextCount: number;
  riskyActiveCount: number;
  missingProviderMatchCount: number;
  manualConfirmationCount: number;
}

export interface LibraryHealthReport {
  generatedAt: string;
  mode: 'read-only';
  writesToAppTables: false;
  writesToProviderData: false;
  targetUserId: string;
  summary: LibraryHealthSummary;
  series: SeriesHealthResult[];
}

const ALL_CLASSIFICATIONS: LibraryHealthClassification[] = [
  'READY',
  'MISSING_PROVIDER_MATCH',
  'INCOMPLETE_CATALOG',
  'PROVIDER_STRUCTURE_RISK',
  'NEEDS_MANUAL_CONFIRMATION',
  'CAUGHT_UP_TRUSTED',
  'WATCH_NEXT_TRUSTED',
  'UNTRACKED_OR_LOW_PRIORITY',
];

export function buildLibraryHealthSummary(series: SeriesHealthResult[]): LibraryHealthSummary {
  const countByClassification = Object.fromEntries(
    ALL_CLASSIFICATIONS.map((c) => [c, series.filter((s) => s.classification === c).length]),
  ) as Record<LibraryHealthClassification, number>;

  return {
    totalSeries: series.length,
    countByClassification,
    providerCoverageCount: series.filter((s) => s.tmdbId !== null).length,
    posterCoverageCount: series.filter((s) => s.hasPoster).length,
    episodeCatalogCoverageCount: series.filter((s) => s.localEpisodeCount > 0).length,
    activeTrackedCount: series.filter((s) => s.classification !== 'UNTRACKED_OR_LOW_PRIORITY').length,
    trustedWatchNextCount: countByClassification.WATCH_NEXT_TRUSTED,
    riskyActiveCount: countByClassification.PROVIDER_STRUCTURE_RISK,
    missingProviderMatchCount: countByClassification.MISSING_PROVIDER_MATCH,
    manualConfirmationCount: countByClassification.NEEDS_MANUAL_CONFIRMATION,
  };
}

export function buildLibraryHealthReport(input: { generatedAt: Date; targetUserId: string; series: SeriesHealthResult[] }): LibraryHealthReport {
  return {
    generatedAt: input.generatedAt.toISOString(),
    mode: 'read-only',
    writesToAppTables: false,
    writesToProviderData: false,
    targetUserId: input.targetUserId,
    summary: buildLibraryHealthSummary(input.series),
    series: input.series,
  };
}

const CLASSIFICATION_LABELS: Record<LibraryHealthClassification, string> = {
  READY: 'Ready',
  MISSING_PROVIDER_MATCH: 'Missing provider match',
  INCOMPLETE_CATALOG: 'Incomplete catalog',
  PROVIDER_STRUCTURE_RISK: 'Provider structure risk',
  NEEDS_MANUAL_CONFIRMATION: 'Needs manual confirmation',
  CAUGHT_UP_TRUSTED: 'Caught up (trusted)',
  WATCH_NEXT_TRUSTED: 'Watch Next (trusted)',
  UNTRACKED_OR_LOW_PRIORITY: 'Untracked / low priority',
};

// Itemized in full in the markdown — these are exactly the categories with
// a non-NO_ACTION recommendedNextAction, i.e. everything the report exists
// to surface.
const ACTIONABLE_CLASSIFICATIONS: LibraryHealthClassification[] = [
  'PROVIDER_STRUCTURE_RISK',
  'MISSING_PROVIDER_MATCH',
  'NEEDS_MANUAL_CONFIRMATION',
  'INCOMPLETE_CATALOG',
];

// Trusted/inactive buckets are large by construction (most of a library) —
// summarized as counts only, not itemized per series, to keep the report
// readable.
const SUMMARY_ONLY_CLASSIFICATIONS: LibraryHealthClassification[] = ['WATCH_NEXT_TRUSTED', 'CAUGHT_UP_TRUSTED', 'READY', 'UNTRACKED_OR_LOW_PRIORITY'];

export function buildMarkdownReport(report: LibraryHealthReport): string {
  const lines: string[] = [];
  lines.push('# Library Health Report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Target user: \`${report.targetUserId}\``);
  lines.push('');
  lines.push('**Read-only.** No writes to any app table, no provider writes, no apply mode — see `library-health/health-logic.ts`.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total series: **${report.summary.totalSeries}**`);
  lines.push(`- Provider coverage (has tmdbId): **${report.summary.providerCoverageCount}**`);
  lines.push(`- Poster coverage: **${report.summary.posterCoverageCount}**`);
  lines.push(`- Episode catalog coverage (>0 local episodes): **${report.summary.episodeCatalogCoverageCount}**`);
  lines.push(`- Actively tracked (not untracked/low-priority): **${report.summary.activeTrackedCount}**`);
  lines.push(`- Trusted Watch Next: **${report.summary.trustedWatchNextCount}**`);
  lines.push(`- Risky active (provider structure risk): **${report.summary.riskyActiveCount}**`);
  lines.push(`- Missing provider match: **${report.summary.missingProviderMatchCount}**`);
  lines.push(`- Needs manual confirmation: **${report.summary.manualConfirmationCount}**`);
  lines.push('');
  lines.push('| Classification | Count |');
  lines.push('| --- | --- |');
  for (const classification of ALL_CLASSIFICATIONS) {
    lines.push(`| ${CLASSIFICATION_LABELS[classification]} | ${report.summary.countByClassification[classification]} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  const byClassification = new Map<LibraryHealthClassification, SeriesHealthResult[]>();
  for (const entry of report.series) {
    const bucket = byClassification.get(entry.classification) ?? [];
    bucket.push(entry);
    byClassification.set(entry.classification, bucket);
  }

  for (const classification of ACTIONABLE_CLASSIFICATIONS) {
    const entries = (byClassification.get(classification) ?? []).sort((a, b) => a.title.localeCompare(b.title));
    if (entries.length === 0) continue;

    lines.push(`## ${CLASSIFICATION_LABELS[classification]} (${entries.length})`);
    lines.push('');
    lines.push('| Series | userStatus | tmdbId | Episodes (watched/local) | Next action | Risk flags |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const entry of entries) {
      lines.push(
        `| ${entry.title} | ${entry.userStatus ?? '_none_'} | ${entry.tmdbId ?? '_none_'} | ${entry.watchedEpisodeCount}/${entry.localEpisodeCount} | ${entry.recommendedNextAction} | ${entry.riskFlags.join(', ') || '_none_'} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Trusted / inactive (summary only)');
  lines.push('');
  for (const classification of SUMMARY_ONLY_CLASSIFICATIONS) {
    const count = byClassification.get(classification)?.length ?? 0;
    lines.push(`- **${CLASSIFICATION_LABELS[classification]}**: ${count}`);
  }
  lines.push('');

  return lines.join('\n');
}

export interface WrittenLibraryHealthReportPaths {
  latestJsonPath: string;
  latestMarkdownPath: string;
  archivedJsonPath: string;
  archivedMarkdownPath: string;
}

export function writeLibraryHealthReports(outDir: string, report: LibraryHealthReport, markdown: string): WrittenLibraryHealthReportPaths {
  const runsDir = path.join(outDir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  const json = JSON.stringify(report, null, 2);
  const timestamp = report.generatedAt.replace(/[:.]/g, '-');

  const latestJsonPath = path.join(outDir, 'latest-library-health-report.json');
  const latestMarkdownPath = path.join(outDir, 'latest-library-health-report.md');
  const archivedJsonPath = path.join(runsDir, `${timestamp}-library-health-report.json`);
  const archivedMarkdownPath = path.join(runsDir, `${timestamp}-library-health-report.md`);

  writeFileSync(latestJsonPath, json);
  writeFileSync(latestMarkdownPath, markdown);
  writeFileSync(archivedJsonPath, json);
  writeFileSync(archivedMarkdownPath, markdown);

  return { latestJsonPath, latestMarkdownPath, archivedJsonPath, archivedMarkdownPath };
}
