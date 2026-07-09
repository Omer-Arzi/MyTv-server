// Report shape + file-writing for the missing-provider-candidates report.
// Kept separate from the orchestration script, same split as every other
// report module in this repo (library-health/reports.ts,
// library-health/incomplete-catalog-reports.ts).

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { SeasonShape } from '../tmdb-enrichment/season-structure-tiebreak';
import {
  MissingProviderCandidateClassification,
  MissingProviderCandidateRecommendedAction,
  MissingProviderCandidateSummary,
} from './missing-provider-candidates-logic';

export interface MissingProviderSeriesReport {
  seriesId: string;
  title: string;
  userStatus: UserSeriesStatus | null;
  releaseStatus: ReleaseStatus;
  nextEpisodeId: string | null;
  watchedEpisodeCount: number;
  localSeasonShape: SeasonShape;
  candidates: MissingProviderCandidateSummary[];
  recommendedCandidate: MissingProviderCandidateSummary | null;
  classification: MissingProviderCandidateClassification;
  recommendedNextAction: MissingProviderCandidateRecommendedAction;
  reason: string;
}

export interface MissingProviderCandidatesReport {
  generatedAt: string;
  mode: 'read-only';
  writesToAppTables: false;
  writesToProviderData: false;
  targetUserId: string;
  investigatedSeriesCount: number;
  summary: {
    countByClassification: Record<MissingProviderCandidateClassification, number>;
    countByRecommendedAction: Record<MissingProviderCandidateRecommendedAction, number>;
  };
  series: MissingProviderSeriesReport[];
}

const ALL_CLASSIFICATIONS: MissingProviderCandidateClassification[] = [
  'SAFE_CANDIDATE_HIGH_CONFIDENCE',
  'NEEDS_MANUAL_CONFIRMATION',
  'NEEDS_ABSOLUTE_NUMBERING_PROVIDER',
  'PROVIDER_STRUCTURE_RISK',
  'NO_GOOD_MATCH',
  'SKIP_LOW_CONFIDENCE',
];

const ALL_ACTIONS: MissingProviderCandidateRecommendedAction[] = [
  'CONFIRM_PROVIDER_MATCH',
  'REVIEW_CANDIDATES_MANUALLY',
  'WAIT_FOR_THETVDB',
  'MARK_AS_RISK',
  'RUN_TARGETED_PROVIDER_AUDIT',
  'NO_ACTION',
];

export function buildMissingProviderCandidatesReport(input: {
  generatedAt: Date;
  targetUserId: string;
  series: MissingProviderSeriesReport[];
}): MissingProviderCandidatesReport {
  const countByClassification = Object.fromEntries(
    ALL_CLASSIFICATIONS.map((c) => [c, input.series.filter((s) => s.classification === c).length]),
  ) as Record<MissingProviderCandidateClassification, number>;
  const countByRecommendedAction = Object.fromEntries(
    ALL_ACTIONS.map((a) => [a, input.series.filter((s) => s.recommendedNextAction === a).length]),
  ) as Record<MissingProviderCandidateRecommendedAction, number>;

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

const CLASSIFICATION_LABELS: Record<MissingProviderCandidateClassification, string> = {
  SAFE_CANDIDATE_HIGH_CONFIDENCE: 'Safe candidate — high confidence',
  NEEDS_MANUAL_CONFIRMATION: 'Needs manual confirmation',
  NEEDS_ABSOLUTE_NUMBERING_PROVIDER: 'Needs absolute-numbering provider',
  PROVIDER_STRUCTURE_RISK: 'Provider structure risk',
  NO_GOOD_MATCH: 'No good match',
  SKIP_LOW_CONFIDENCE: 'Skip — low confidence',
};

const CLASSIFICATION_ORDER: MissingProviderCandidateClassification[] = [
  'SAFE_CANDIDATE_HIGH_CONFIDENCE',
  'NEEDS_MANUAL_CONFIRMATION',
  'NEEDS_ABSOLUTE_NUMBERING_PROVIDER',
  'PROVIDER_STRUCTURE_RISK',
  'NO_GOOD_MATCH',
  'SKIP_LOW_CONFIDENCE',
];

function fmtShape(shape: SeasonShape): string {
  return `${shape.seasonCount} season(s) [${shape.episodesPerSeason.join(', ')}] = ${shape.totalEpisodeCount} episodes`;
}

export function buildMissingProviderCandidatesMarkdownReport(report: MissingProviderCandidatesReport): string {
  const lines: string[] = [];
  lines.push('# Missing Provider Candidates Report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Target user: \`${report.targetUserId}\``);
  lines.push('');
  lines.push(
    '**Read-only.** No writes to any app table, no provider writes, no apply mode. TMDb reads only, via the ' +
      'existing rate-limited client — see `library-health/missing-provider-candidates-logic.ts` and ' +
      '`tmdb-enrichment/season-structure-tiebreak.ts`.',
  );
  lines.push('');
  lines.push(`Series investigated: **${report.investigatedSeriesCount}** (top MISSING_PROVIDER_MATCH series by watchedEpisodeCount, per the latest Library Health report)`);
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

  const byClassification = new Map<MissingProviderCandidateClassification, MissingProviderSeriesReport[]>();
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
      lines.push(`- Series id: \`${entry.seriesId}\` · userStatus: ${entry.userStatus ?? '_none_'} · releaseStatus: ${entry.releaseStatus}`);
      lines.push(`- Watched: ${entry.watchedEpisodeCount} · Local shape: ${fmtShape(entry.localSeasonShape)}`);
      lines.push('');
      lines.push(`**Recommended next action**: \`${entry.recommendedNextAction}\`${entry.recommendedCandidate ? ` — **${entry.recommendedCandidate.title}** (tmdbId \`${entry.recommendedCandidate.tmdbId}\`)` : ''}`);
      lines.push('');
      lines.push(`> ${entry.reason}`);
      lines.push('');

      if (entry.candidates.length > 0) {
        lines.push('<details><summary>Candidates considered</summary>');
        lines.push('');
        lines.push('| Title | Year | Confidence | Title match | Year match | Provider shape | Season structure score | Collapse? | Anime risk? | Warnings |');
        lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
        for (const c of entry.candidates) {
          lines.push(
            `| ${c.title} | ${c.year ?? '_?_'} | ${c.confidenceScore} | ${c.titleMatchType} | ${c.yearMatchType} | ${c.providerSeasonShape ? fmtShape(c.providerSeasonShape) : '_not fetched_'} | ${c.seasonStructureScore ?? '_n/a_'} | ${c.collapsePatternDetected === null ? '_n/a_' : c.collapsePatternDetected ? 'yes' : 'no'} | ${c.animeNumberingRiskDetected ? 'yes' : 'no'} | ${c.warnings.join('; ') || '_none_'} |`,
          );
        }
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

export interface WrittenMissingProviderCandidatesReportPaths {
  latestJsonPath: string;
  latestMarkdownPath: string;
  archivedJsonPath: string;
  archivedMarkdownPath: string;
}

export function writeMissingProviderCandidatesReports(
  outDir: string,
  report: MissingProviderCandidatesReport,
  markdown: string,
): WrittenMissingProviderCandidatesReportPaths {
  const runsDir = path.join(outDir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  const json = JSON.stringify(report, null, 2);
  const timestamp = report.generatedAt.replace(/[:.]/g, '-');

  const latestJsonPath = path.join(outDir, 'latest-missing-provider-candidates-report.json');
  const latestMarkdownPath = path.join(outDir, 'latest-missing-provider-candidates-report.md');
  const archivedJsonPath = path.join(runsDir, `${timestamp}-missing-provider-candidates-report.json`);
  const archivedMarkdownPath = path.join(runsDir, `${timestamp}-missing-provider-candidates-report.md`);

  writeFileSync(latestJsonPath, json);
  writeFileSync(latestMarkdownPath, markdown);
  writeFileSync(archivedJsonPath, json);
  writeFileSync(archivedMarkdownPath, markdown);

  return { latestJsonPath, latestMarkdownPath, archivedJsonPath, archivedMarkdownPath };
}
