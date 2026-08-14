// Report shape + file-writing for the one-time Episode.tmdbEpisodeId
// backfill. Same split as tmdb-external-ids-backfill-reports.ts.

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { SeriesBackfillPlan } from './tmdb-episode-id-backfill-logic';

export interface SeriesBackfillReportEntry {
  seriesId: string;
  seriesTitle: string;
  plan: SeriesBackfillPlan;
  appliedCount: number;
  skippedDueToCollisionOrAmbiguity: boolean;
}

export interface BackfillErrorEntry {
  seriesId: string;
  seriesTitle: string;
  message: string;
}

export interface TmdbEpisodeIdBackfillReport {
  generatedAt: string;
  mode: 'dry-run' | 'apply';
  applied: boolean;
  writesToAppTables: boolean;
  seriesProcessed: number;
  totalExactMatches: number;
  totalAmbiguous: number;
  totalUnmatchedLocal: number;
  totalUnmatchedProvider: number;
  totalCollisions: number;
  totalApplied: number;
  seriesWithAnyCollisionOrAmbiguity: number;
  entries: SeriesBackfillReportEntry[];
  errors: BackfillErrorEntry[];
}

export function buildTmdbEpisodeIdBackfillReport(input: { generatedAt: Date; applied: boolean; entries: SeriesBackfillReportEntry[]; errors: BackfillErrorEntry[] }): TmdbEpisodeIdBackfillReport {
  const totalExactMatches = input.entries.reduce((sum, e) => sum + e.plan.exactMatches.length, 0);
  const totalAmbiguous = input.entries.reduce((sum, e) => sum + e.plan.ambiguous.length, 0);
  const totalUnmatchedLocal = input.entries.reduce((sum, e) => sum + e.plan.unmatchedLocal.length, 0);
  const totalUnmatchedProvider = input.entries.reduce((sum, e) => sum + e.plan.unmatchedProvider.length, 0);
  const totalCollisions = input.entries.reduce((sum, e) => sum + e.plan.collisions.length, 0);
  const totalApplied = input.entries.reduce((sum, e) => sum + e.appliedCount, 0);
  const seriesWithAnyCollisionOrAmbiguity = input.entries.filter((e) => e.skippedDueToCollisionOrAmbiguity).length;

  return {
    generatedAt: input.generatedAt.toISOString(),
    mode: input.applied ? 'apply' : 'dry-run',
    applied: input.applied,
    writesToAppTables: input.applied && totalApplied > 0,
    seriesProcessed: input.entries.length,
    totalExactMatches,
    totalAmbiguous,
    totalUnmatchedLocal,
    totalUnmatchedProvider,
    totalCollisions,
    totalApplied,
    seriesWithAnyCollisionOrAmbiguity,
    entries: input.entries,
    errors: input.errors,
  };
}

export function buildTmdbEpisodeIdBackfillMarkdownReport(report: TmdbEpisodeIdBackfillReport): string {
  const lines: string[] = [];
  lines.push('# Episode.tmdbEpisodeId Backfill');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Mode: \`${report.mode}\`${report.writesToAppTables ? ' — **writes were made**' : ' — no writes'}`);
  lines.push('');
  lines.push('| | Count |');
  lines.push('| --- | --- |');
  lines.push(`| Series processed | ${report.seriesProcessed} |`);
  lines.push(`| Exact matches (would backfill / backfilled) | ${report.totalExactMatches} |`);
  lines.push(`| Ambiguous (never auto-applied) | ${report.totalAmbiguous} |`);
  lines.push(`| Unmatched local episodes | ${report.totalUnmatchedLocal} |`);
  lines.push(`| Unmatched provider episodes (informational only) | ${report.totalUnmatchedProvider} |`);
  lines.push(`| Collisions (never auto-applied) | ${report.totalCollisions} |`);
  lines.push(`| Series with any collision/ambiguity (entire series skipped) | ${report.seriesWithAnyCollisionOrAmbiguity} |`);
  lines.push(`| Applied | ${report.totalApplied} |`);
  lines.push(`| Errors | ${report.errors.length} |`);
  lines.push('');

  const clean = report.entries.filter((e) => !e.skippedDueToCollisionOrAmbiguity && e.plan.exactMatches.length > 0);
  const flagged = report.entries.filter((e) => e.skippedDueToCollisionOrAmbiguity);
  const noSignal = report.entries.filter((e) => !e.skippedDueToCollisionOrAmbiguity && e.plan.exactMatches.length === 0 && e.plan.unmatchedLocal.length > 0);

  if (clean.length > 0) {
    lines.push(report.applied ? '## Backfilled cleanly' : '## Would backfill cleanly (dry-run)');
    lines.push('');
    for (const e of clean) {
      lines.push(`- **${e.seriesTitle}** (\`${e.seriesId}\`) — ${e.plan.exactMatches.length} exact match(es)${e.plan.unmatchedLocal.length > 0 ? `, ${e.plan.unmatchedLocal.length} unmatched local episode(s) left for a dedicated repair` : ''}`);
    }
    lines.push('');
  }

  if (flagged.length > 0) {
    lines.push('## Flagged — collision or ambiguity present, entire series skipped');
    lines.push('');
    lines.push('Per safeguard: a series with ANY collision or ambiguous match writes NOTHING for that series, even for its otherwise-clean exact matches, until reviewed.');
    lines.push('');
    for (const e of flagged) {
      lines.push(`### ${e.seriesTitle} (\`${e.seriesId}\`)`);
      for (const c of e.plan.collisions) {
        lines.push(`- **Collision**: tmdbEpisodeId \`${c.tmdbEpisodeId}\` claimed by both ${c.localLabels.join(' and ')} (ids: ${c.localEpisodeIds.join(', ')})`);
      }
      for (const a of e.plan.ambiguous) {
        lines.push(`- **Ambiguous**: ${a.localLabel} (id \`${a.localEpisodeId}\`) — ${a.reason}`);
      }
      lines.push('');
    }
  }

  if (noSignal.length > 0) {
    lines.push('## Series with unmatched-only local episodes (no collision/ambiguity, but nothing to match)');
    lines.push('');
    for (const e of noSignal) {
      lines.push(`- **${e.seriesTitle}** (\`${e.seriesId}\`) — ${e.plan.unmatchedLocal.length} local episode(s) with no matchable signal (see full JSON report for the exact list)`);
    }
    lines.push('');
  }

  if (report.errors.length > 0) {
    lines.push('## Errors');
    lines.push('');
    for (const err of report.errors) lines.push(`- **${err.seriesTitle}** (\`${err.seriesId}\`) — ${err.message}`);
    lines.push('');
  }

  return lines.join('\n');
}

export interface WrittenTmdbEpisodeIdBackfillPaths {
  latestJsonPath: string;
  latestMarkdownPath: string;
  archivedJsonPath: string;
  archivedMarkdownPath: string;
}

export function writeTmdbEpisodeIdBackfillReports(outDir: string, report: TmdbEpisodeIdBackfillReport, markdown: string): WrittenTmdbEpisodeIdBackfillPaths {
  const runsDir = path.join(outDir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  const json = JSON.stringify(report, null, 2);
  const timestamp = report.generatedAt.replace(/[:.]/g, '-');

  const latestJsonPath = path.join(outDir, 'latest-tmdb-episode-id-backfill-report.json');
  const latestMarkdownPath = path.join(outDir, 'latest-tmdb-episode-id-backfill-report.md');
  const archivedJsonPath = path.join(runsDir, `${timestamp}-tmdb-episode-id-backfill-report.json`);
  const archivedMarkdownPath = path.join(runsDir, `${timestamp}-tmdb-episode-id-backfill-report.md`);

  writeFileSync(latestJsonPath, json);
  writeFileSync(latestMarkdownPath, markdown);
  writeFileSync(archivedJsonPath, json);
  writeFileSync(archivedMarkdownPath, markdown);

  return { latestJsonPath, latestMarkdownPath, archivedJsonPath, archivedMarkdownPath };
}
