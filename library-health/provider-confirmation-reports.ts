// Report shape + file-writing for the provider-confirmation report. Kept
// separate from the orchestration script, same split as every other report
// module in this repo.

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { UserSeriesStatus } from '@prisma/client';
import { SeasonShape } from '../tmdb-enrichment/season-structure-tiebreak';
import {
  ProviderCandidateComparisonEntry,
  ProviderConfirmationClassification,
  ProviderConfirmationRecommendedAction,
} from './provider-confirmation-logic';

export interface ProviderConfirmationSeriesReport {
  seriesId: string;
  title: string;
  userStatus: UserSeriesStatus | null;
  nextEpisodeId: string | null;
  lastWatchedAt: string | null;
  watchedEpisodeCount: number;
  localSeasonShape: SeasonShape;
  isPriorityScope: boolean;
  tmdbCandidates: ProviderCandidateComparisonEntry[];
  tvmazeCandidates: ProviderCandidateComparisonEntry[];
  recommendedCandidate: ProviderCandidateComparisonEntry | null;
  classification: ProviderConfirmationClassification;
  recommendedNextAction: ProviderConfirmationRecommendedAction;
  reason: string;
}

export interface ProviderConfirmationReport {
  generatedAt: string;
  mode: 'read-only';
  writesToAppTables: false;
  writesToProviderData: false;
  targetUserId: string;
  investigatedSeriesCount: number;
  summary: {
    countByClassification: Record<ProviderConfirmationClassification, number>;
    countByRecommendedAction: Record<ProviderConfirmationRecommendedAction, number>;
  };
  series: ProviderConfirmationSeriesReport[];
}

const ALL_CLASSIFICATIONS: ProviderConfirmationClassification[] = [
  'READY_FOR_HUMAN_CONFIRMATION',
  'STILL_AMBIGUOUS',
  'NEEDS_TVMAZE_OVER_TMDB',
  'NEEDS_SPECIAL_PROVIDER_HANDLING',
  'DEFER',
];

const ALL_ACTIONS: ProviderConfirmationRecommendedAction[] = [
  'CONFIRM_TMDB_CANDIDATE',
  'CONFIRM_TVMAZE_CANDIDATE',
  'CHOOSE_BETWEEN_CANDIDATES',
  'DEFER_HIGH_RISK',
  'NO_GOOD_MATCH',
];

export function buildProviderConfirmationReport(input: {
  generatedAt: Date;
  targetUserId: string;
  series: ProviderConfirmationSeriesReport[];
}): ProviderConfirmationReport {
  const countByClassification = Object.fromEntries(
    ALL_CLASSIFICATIONS.map((c) => [c, input.series.filter((s) => s.classification === c).length]),
  ) as Record<ProviderConfirmationClassification, number>;
  const countByRecommendedAction = Object.fromEntries(
    ALL_ACTIONS.map((a) => [a, input.series.filter((s) => s.recommendedNextAction === a).length]),
  ) as Record<ProviderConfirmationRecommendedAction, number>;

  return {
    generatedAt: input.generatedAt.toISOString(),
    mode: 'read-only',
    writesToAppTables: false,
    writesToProviderData: false,
    targetUserId: input.targetUserId,
    investigatedSeriesCount: input.series.length,
    summary: { countByClassification, countByRecommendedAction },
    series: input.series,
  };
}

const CLASSIFICATION_LABELS: Record<ProviderConfirmationClassification, string> = {
  READY_FOR_HUMAN_CONFIRMATION: 'Ready for human confirmation',
  STILL_AMBIGUOUS: 'Still ambiguous',
  NEEDS_TVMAZE_OVER_TMDB: 'Needs TVmaze over TMDb',
  NEEDS_SPECIAL_PROVIDER_HANDLING: 'Needs special provider handling',
  DEFER: 'Defer',
};

const CLASSIFICATION_ORDER: ProviderConfirmationClassification[] = [
  'READY_FOR_HUMAN_CONFIRMATION',
  'NEEDS_TVMAZE_OVER_TMDB',
  'STILL_AMBIGUOUS',
  'NEEDS_SPECIAL_PROVIDER_HANDLING',
  'DEFER',
];

function fmtShape(shape: SeasonShape | null): string {
  if (!shape) return '_unknown_';
  return `${shape.seasonCount} season(s) [${shape.episodesPerSeason.join(', ')}] = ${shape.totalEpisodeCount} episodes`;
}

function candidateShape(c: ProviderCandidateComparisonEntry): SeasonShape | null {
  if (c.seasonCount === null || c.episodesPerSeason === null || c.totalEpisodeCount === null) return null;
  return { seasonCount: c.seasonCount, episodesPerSeason: c.episodesPerSeason, totalEpisodeCount: c.totalEpisodeCount };
}

function fmtCandidateTable(candidates: ProviderCandidateComparisonEntry[]): string[] {
  if (candidates.length === 0) return ['_none fetched_', ''];
  const lines: string[] = [];
  lines.push('| Provider | Title | Year/Premiere | Network | Status | Shape | Poster | Confidence | Gap | Why likely/unlikely correct | Warnings |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const c of candidates) {
    lines.push(
      `| ${c.provider} | ${c.title} | ${c.yearOrPremiereDate ?? '_?_'} | ${c.network ?? '_?_'} | ${c.status ?? '_?_'} | ${fmtShape(candidateShape(c))} | ${c.hasPoster === null ? '_?_' : c.hasPoster ? 'yes' : 'no'} | ${c.confidenceScore} | ${c.watchedVsTotalGap ?? '_?_'} | ${c.likelyCorrectReason} | ${c.warnings.join('; ') || '_none_'} |`,
    );
  }
  return lines;
}

export function buildProviderConfirmationMarkdownReport(report: ProviderConfirmationReport): string {
  const lines: string[] = [];
  lines.push('# Provider Confirmation Report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Target user: \`${report.targetUserId}\``);
  lines.push('');
  lines.push(
    '**Read-only.** No writes to any app table, no provider writes, no apply mode. TMDb and TVmaze reads only, ' +
      'via the existing rate-limited clients — see `library-health/provider-confirmation-logic.ts`.',
  );
  lines.push('');
  lines.push(`Series investigated: **${report.investigatedSeriesCount}**`);
  lines.push('');
  lines.push('| Classification | Count |');
  lines.push('| --- | --- |');
  for (const c of ALL_CLASSIFICATIONS) lines.push(`| ${CLASSIFICATION_LABELS[c]} | ${report.summary.countByClassification[c]} |`);
  lines.push('');
  lines.push('| Recommended action | Count |');
  lines.push('| --- | --- |');
  for (const a of ALL_ACTIONS) lines.push(`| ${a} | ${report.summary.countByRecommendedAction[a]} |`);
  lines.push('');
  lines.push('---');
  lines.push('');

  const byClassification = new Map<ProviderConfirmationClassification, ProviderConfirmationSeriesReport[]>();
  for (const entry of report.series) {
    const bucket = byClassification.get(entry.classification) ?? [];
    bucket.push(entry);
    byClassification.set(entry.classification, bucket);
  }

  for (const classification of CLASSIFICATION_ORDER) {
    const entries = byClassification.get(classification);
    if (!entries || entries.length === 0) continue;

    lines.push(`## ${CLASSIFICATION_LABELS[classification]} (${entries.length})`);
    lines.push('');

    for (const entry of [...entries].sort((a, b) => b.watchedEpisodeCount - a.watchedEpisodeCount)) {
      lines.push(`### ${entry.title}`);
      lines.push('');
      lines.push(`- Series id: \`${entry.seriesId}\` · userStatus: ${entry.userStatus ?? '_none_'} · nextEpisodeId: ${entry.nextEpisodeId ?? '_none_'}`);
      lines.push(`- Watched: ${entry.watchedEpisodeCount} · Last watched: ${entry.lastWatchedAt ? entry.lastWatchedAt.slice(0, 10) : '_never_'}`);
      lines.push(`- Local shape: ${fmtShape(entry.localSeasonShape)}`);
      lines.push('');
      lines.push(
        `**Recommended next action**: \`${entry.recommendedNextAction}\`${entry.recommendedCandidate ? ` — **${entry.recommendedCandidate.title}** (${entry.recommendedCandidate.provider} id \`${entry.recommendedCandidate.id}\`)` : ''}`,
      );
      lines.push('');
      lines.push(`> ${entry.reason}`);
      lines.push('');

      if (entry.tmdbCandidates.length > 0 || entry.tvmazeCandidates.length > 0) {
        lines.push('<details><summary>Side-by-side candidate comparison</summary>');
        lines.push('');
        lines.push('**TMDb**');
        lines.push('');
        lines.push(...fmtCandidateTable(entry.tmdbCandidates));
        lines.push('');
        lines.push('**TVmaze**');
        lines.push('');
        lines.push(...fmtCandidateTable(entry.tvmazeCandidates));
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

export interface WrittenProviderConfirmationReportPaths {
  latestJsonPath: string;
  latestMarkdownPath: string;
  archivedJsonPath: string;
  archivedMarkdownPath: string;
}

export function writeProviderConfirmationReports(outDir: string, report: ProviderConfirmationReport, markdown: string): WrittenProviderConfirmationReportPaths {
  const runsDir = path.join(outDir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  const json = JSON.stringify(report, null, 2);
  const timestamp = report.generatedAt.replace(/[:.]/g, '-');

  const latestJsonPath = path.join(outDir, 'latest-provider-confirmation-report.json');
  const latestMarkdownPath = path.join(outDir, 'latest-provider-confirmation-report.md');
  const archivedJsonPath = path.join(runsDir, `${timestamp}-provider-confirmation-report.json`);
  const archivedMarkdownPath = path.join(runsDir, `${timestamp}-provider-confirmation-report.md`);

  writeFileSync(latestJsonPath, json);
  writeFileSync(latestMarkdownPath, markdown);
  writeFileSync(archivedJsonPath, json);
  writeFileSync(archivedMarkdownPath, markdown);

  return { latestJsonPath, latestMarkdownPath, archivedJsonPath, archivedMarkdownPath };
}
