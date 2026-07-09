// Report shape + file-writing for the one-time ExternalIds.tmdbId
// backfill. Same split as every other report module in this repo.

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { BackfillPlanEntry } from './tmdb-external-ids-backfill-logic';

export interface BackfillErrorEntry {
  seriesId: string;
  title: string;
  message: string;
}

export interface TmdbExternalIdsBackfillReport {
  generatedAt: string;
  mode: 'dry-run' | 'apply';
  applied: boolean;
  writesToAppTables: boolean;
  writesToProviderData: false;
  candidateCount: number;
  backfillCount: number;
  collisionCount: number;
  appliedCount: number;
  errorCount: number;
  plan: BackfillPlanEntry[];
  errors: BackfillErrorEntry[];
}

export function buildTmdbExternalIdsBackfillReport(input: {
  generatedAt: Date;
  applied: boolean;
  plan: BackfillPlanEntry[];
  appliedCount: number;
  errors: BackfillErrorEntry[];
}): TmdbExternalIdsBackfillReport {
  const backfillCount = input.plan.filter((p) => p.action === 'backfill').length;
  const collisionCount = input.plan.filter((p) => p.action === 'skip_collision').length;

  return {
    generatedAt: input.generatedAt.toISOString(),
    mode: input.applied ? 'apply' : 'dry-run',
    applied: input.applied,
    writesToAppTables: input.applied && input.appliedCount > 0,
    writesToProviderData: false,
    candidateCount: input.plan.length,
    backfillCount,
    collisionCount,
    appliedCount: input.appliedCount,
    errorCount: input.errors.length,
    plan: input.plan,
    errors: input.errors,
  };
}

export function buildTmdbExternalIdsBackfillMarkdownReport(report: TmdbExternalIdsBackfillReport): string {
  const lines: string[] = [];
  lines.push('# ExternalIds.tmdbId Backfill');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Mode: \`${report.mode}\`${report.writesToAppTables ? ' — **writes were made**' : ' — no writes'}`);
  lines.push('');
  lines.push('| | Count |');
  lines.push('| --- | --- |');
  lines.push(`| Candidates | ${report.candidateCount} |`);
  lines.push(`| Would backfill / backfilled | ${report.applied ? report.appliedCount : report.backfillCount} |`);
  lines.push(`| Skipped — collision | ${report.collisionCount} |`);
  lines.push(`| Errors | ${report.errorCount} |`);
  lines.push('');

  const backfillRows = report.plan.filter((p) => p.action === 'backfill');
  const collisionRows = report.plan.filter((p) => p.action === 'skip_collision');

  if (backfillRows.length > 0) {
    lines.push(report.applied ? '## Backfilled' : '## Would backfill (dry-run)');
    lines.push('');
    for (const p of backfillRows) lines.push(`- **${p.title}** (\`${p.seriesId}\`) — tmdbId → \`${p.providerId}\``);
    lines.push('');
  }

  if (collisionRows.length > 0) {
    lines.push('## Skipped — collision');
    lines.push('');
    for (const p of collisionRows) lines.push(`- **${p.title}** (\`${p.seriesId}\`) — ${p.reason}`);
    lines.push('');
  }

  if (report.errors.length > 0) {
    lines.push('## Errors');
    lines.push('');
    for (const e of report.errors) lines.push(`- **${e.title}** (\`${e.seriesId}\`) — ${e.message}`);
    lines.push('');
  }

  return lines.join('\n');
}

export interface WrittenTmdbExternalIdsBackfillPaths {
  latestJsonPath: string;
  latestMarkdownPath: string;
  archivedJsonPath: string;
  archivedMarkdownPath: string;
}

export function writeTmdbExternalIdsBackfillReports(
  outDir: string,
  report: TmdbExternalIdsBackfillReport,
  markdown: string,
): WrittenTmdbExternalIdsBackfillPaths {
  const runsDir = path.join(outDir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  const json = JSON.stringify(report, null, 2);
  const timestamp = report.generatedAt.replace(/[:.]/g, '-');

  const latestJsonPath = path.join(outDir, 'latest-tmdb-external-ids-backfill-report.json');
  const latestMarkdownPath = path.join(outDir, 'latest-tmdb-external-ids-backfill-report.md');
  const archivedJsonPath = path.join(runsDir, `${timestamp}-tmdb-external-ids-backfill-report.json`);
  const archivedMarkdownPath = path.join(runsDir, `${timestamp}-tmdb-external-ids-backfill-report.md`);

  writeFileSync(latestJsonPath, json);
  writeFileSync(latestMarkdownPath, markdown);
  writeFileSync(archivedJsonPath, json);
  writeFileSync(archivedMarkdownPath, markdown);

  return { latestJsonPath, latestMarkdownPath, archivedJsonPath, archivedMarkdownPath };
}
