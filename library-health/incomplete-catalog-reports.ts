// Report shape + file-writing for the focused INCOMPLETE_CATALOG
// investigation. Kept separate from library-health/reports.ts (the main
// Library Health report) since the two have different per-series shapes
// and output filenames, but follow the exact same conventions.

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { RiskFlag } from './health-logic';
import { IncompleteCatalogIssueClassification, IncompleteCatalogRecommendedAction } from './incomplete-catalog-investigation';

export interface IncompleteCatalogProviderComparisonSummary {
  attempted: boolean;
  succeeded: boolean;
  error: string | null;
  providerSeasonCount: number | null;
  providerEpisodeCount: number | null;
  newEpisodesFound: number | null;
  releasedNewEpisodesFound: number | null;
  futureNewEpisodesFound: number | null;
  // Mirrors episode-release-refresh's own RefreshClassification values —
  // kept as a plain string here rather than importing that type, so this
  // report's shape doesn't silently change if that pipeline's enum grows.
  comparisonClassification: string | null;
  warnings: string[];
}

export interface IncompleteCatalogSeriesReport {
  seriesId: string;
  title: string;
  releaseStatus: ReleaseStatus;
  userStatus: UserSeriesStatus | null;
  tmdbId: string | null;
  tvmazeId: string | null;
  localSeasonCount: number;
  localEpisodeCount: number;
  watchedEpisodeCount: number;
  latestWatchedEpisodeLabel: string | null;
  latestWatchedAt: string | null;
  nextEpisodeId: string | null;
  hasPoster: boolean;
  hasBackdrop: boolean;
  healthRiskFlags: RiskFlag[];
  providerComparison: IncompleteCatalogProviderComparisonSummary;
  issueClassification: IncompleteCatalogIssueClassification;
  recommendedNextAction: IncompleteCatalogRecommendedAction;
  reason: string;
}

export interface IncompleteCatalogReport {
  generatedAt: string;
  mode: 'read-only';
  writesToAppTables: false;
  writesToProviderData: false;
  targetUserId: string;
  investigatedSeriesCount: number;
  summary: {
    countByIssueClassification: Record<IncompleteCatalogIssueClassification, number>;
    countByRecommendedAction: Record<IncompleteCatalogRecommendedAction, number>;
  };
  series: IncompleteCatalogSeriesReport[];
}

const ALL_ISSUE_CLASSIFICATIONS: IncompleteCatalogIssueClassification[] = [
  'SAFE_PROVIDER_REFRESH_CANDIDATE',
  'NEEDS_PROVIDER_MATCH',
  'NEEDS_ABSOLUTE_NUMBERING_PROVIDER',
  'PROVIDER_STRUCTURE_RISK',
  'LIKELY_ALREADY_COMPLETE_BUT_UNTRUSTED',
  'NEEDS_MANUAL_USER_CONFIRMATION',
];

const ALL_RECOMMENDED_ACTIONS: IncompleteCatalogRecommendedAction[] = [
  'RUN_TARGETED_TMDB_REFRESH_DRY_RUN',
  'RUN_TVMAZE_COMPARISON',
  'ADD_TO_PROVIDER_STRUCTURE_RISK_LIST',
  'USE_ABSOLUTE_NUMBERING_PROVIDER_LATER',
  'ASK_USER_TO_CONFIRM_PROGRESS',
  'NO_ACTION',
];

export function buildIncompleteCatalogReport(input: { generatedAt: Date; targetUserId: string; series: IncompleteCatalogSeriesReport[] }): IncompleteCatalogReport {
  const countByIssueClassification = Object.fromEntries(
    ALL_ISSUE_CLASSIFICATIONS.map((c) => [c, input.series.filter((s) => s.issueClassification === c).length]),
  ) as Record<IncompleteCatalogIssueClassification, number>;
  const countByRecommendedAction = Object.fromEntries(
    ALL_RECOMMENDED_ACTIONS.map((a) => [a, input.series.filter((s) => s.recommendedNextAction === a).length]),
  ) as Record<IncompleteCatalogRecommendedAction, number>;

  return {
    generatedAt: input.generatedAt.toISOString(),
    mode: 'read-only',
    writesToAppTables: false,
    writesToProviderData: false,
    targetUserId: input.targetUserId,
    investigatedSeriesCount: input.series.length,
    summary: { countByIssueClassification, countByRecommendedAction },
    series: input.series,
  };
}

const ISSUE_LABELS: Record<IncompleteCatalogIssueClassification, string> = {
  SAFE_PROVIDER_REFRESH_CANDIDATE: 'Safe provider refresh candidate',
  NEEDS_PROVIDER_MATCH: 'Needs provider match',
  NEEDS_ABSOLUTE_NUMBERING_PROVIDER: 'Needs absolute-numbering provider',
  PROVIDER_STRUCTURE_RISK: 'Provider structure risk',
  LIKELY_ALREADY_COMPLETE_BUT_UNTRUSTED: 'Likely already complete but untrusted',
  NEEDS_MANUAL_USER_CONFIRMATION: 'Needs manual user confirmation',
};

export function buildIncompleteCatalogMarkdownReport(report: IncompleteCatalogReport): string {
  const lines: string[] = [];
  lines.push('# Incomplete Catalog Investigation');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Target user: \`${report.targetUserId}\``);
  lines.push('');
  lines.push(
    '**Read-only.** No writes to any app table, no provider writes, no apply mode. Live TMDb reads only, via the ' +
      'same helpers `episode-release-refresh` uses — see `library-health/incomplete-catalog-investigation.ts`.',
  );
  lines.push('');
  lines.push(`Series investigated: **${report.investigatedSeriesCount}** (everything currently classified \`INCOMPLETE_CATALOG\` by the Library Health report)`);
  lines.push('');
  lines.push('| Issue classification | Count |');
  lines.push('| --- | --- |');
  for (const classification of ALL_ISSUE_CLASSIFICATIONS) {
    lines.push(`| ${ISSUE_LABELS[classification]} | ${report.summary.countByIssueClassification[classification]} |`);
  }
  lines.push('');
  lines.push('| Recommended action | Count |');
  lines.push('| --- | --- |');
  for (const action of ALL_RECOMMENDED_ACTIONS) {
    lines.push(`| ${action} | ${report.summary.countByRecommendedAction[action]} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const entry of [...report.series].sort((a, b) => a.title.localeCompare(b.title))) {
    lines.push(`## ${entry.title}`);
    lines.push('');
    lines.push(`- Series id: \`${entry.seriesId}\` · TMDb id: ${entry.tmdbId ? `\`${entry.tmdbId}\`` : '_none_'} · TVmaze id: ${entry.tvmazeId ? `\`${entry.tvmazeId}\`` : '_none_'}`);
    lines.push(`- userStatus: ${entry.userStatus ?? '_none_'} · releaseStatus: ${entry.releaseStatus}`);
    lines.push(`- Local: ${entry.localSeasonCount} season(s), ${entry.localEpisodeCount} episode(s) known, ${entry.watchedEpisodeCount} watched`);
    lines.push(`- Latest watched: ${entry.latestWatchedEpisodeLabel ?? '_none_'}${entry.latestWatchedAt ? ` (${entry.latestWatchedAt.slice(0, 10)})` : ''}`);
    lines.push(`- nextEpisodeId: ${entry.nextEpisodeId ?? '_none_'}`);
    lines.push(`- Poster: ${entry.hasPoster ? 'yes' : 'no'} · Backdrop: ${entry.hasBackdrop ? 'yes' : 'no'}`);
    lines.push(`- Flagged by Library Health because: ${entry.healthRiskFlags.join(', ') || '_(see report)_'}`);
    lines.push('');
    lines.push(`**Issue classification**: \`${entry.issueClassification}\``);
    lines.push('');
    lines.push(`**Recommended next action**: \`${entry.recommendedNextAction}\``);
    lines.push('');
    lines.push(`> ${entry.reason}`);
    lines.push('');
    if (entry.providerComparison.attempted) {
      lines.push('<details><summary>Live TMDb comparison detail</summary>');
      lines.push('');
      if (entry.providerComparison.succeeded) {
        lines.push(`- Provider seasons: ${entry.providerComparison.providerSeasonCount} · Provider episodes: ${entry.providerComparison.providerEpisodeCount}`);
        lines.push(
          `- New episodes found: ${entry.providerComparison.newEpisodesFound} (released: ${entry.providerComparison.releasedNewEpisodesFound}, future: ${entry.providerComparison.futureNewEpisodesFound})`,
        );
        lines.push(`- Comparison classification: \`${entry.providerComparison.comparisonClassification}\``);
        if (entry.providerComparison.warnings.length > 0) {
          lines.push('- Warnings:');
          for (const warning of entry.providerComparison.warnings) lines.push(`  - ${warning}`);
        }
      } else {
        lines.push(`- Fetch failed: ${entry.providerComparison.error}`);
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

export interface WrittenIncompleteCatalogReportPaths {
  latestJsonPath: string;
  latestMarkdownPath: string;
  archivedJsonPath: string;
  archivedMarkdownPath: string;
}

export function writeIncompleteCatalogReports(outDir: string, report: IncompleteCatalogReport, markdown: string): WrittenIncompleteCatalogReportPaths {
  const runsDir = path.join(outDir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  const json = JSON.stringify(report, null, 2);
  const timestamp = report.generatedAt.replace(/[:.]/g, '-');

  const latestJsonPath = path.join(outDir, 'latest-incomplete-catalog-report.json');
  const latestMarkdownPath = path.join(outDir, 'latest-incomplete-catalog-report.md');
  const archivedJsonPath = path.join(runsDir, `${timestamp}-incomplete-catalog-report.json`);
  const archivedMarkdownPath = path.join(runsDir, `${timestamp}-incomplete-catalog-report.md`);

  writeFileSync(latestJsonPath, json);
  writeFileSync(latestMarkdownPath, markdown);
  writeFileSync(archivedJsonPath, json);
  writeFileSync(archivedMarkdownPath, markdown);

  return { latestJsonPath, latestMarkdownPath, archivedJsonPath, archivedMarkdownPath };
}
