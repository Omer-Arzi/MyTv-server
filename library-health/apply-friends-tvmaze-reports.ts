// Report shape + file-writing for the single Friends+TVmaze-431 apply
// script. Kept separate from the orchestration script, same split as every
// other report module in this repo.

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { EpisodeUpdatePlan, FriendsApplyPlan, PosterUpdatePlan } from './apply-friends-tvmaze-logic';

export interface FriendsApplyReport {
  generatedAt: string;
  mode: 'dry-run' | 'apply';
  applied: boolean;
  writesToAppTables: boolean;
  writesToProviderData: false;
  targetUserId: string;
  guard: { allowed: boolean; violations: string[] };
  dryRunClassification: string | null;
  plan: FriendsApplyPlan | null;
  outcome: string;
}

export function buildFriendsApplyReport(input: {
  generatedAt: Date;
  applied: boolean;
  targetUserId: string;
  guard: { allowed: boolean; violations: string[] };
  dryRunClassification: string | null;
  plan: FriendsApplyPlan | null;
  outcome: string;
}): FriendsApplyReport {
  return {
    generatedAt: input.generatedAt.toISOString(),
    mode: input.applied ? 'apply' : 'dry-run',
    applied: input.applied,
    writesToAppTables: input.applied,
    writesToProviderData: false,
    targetUserId: input.targetUserId,
    guard: input.guard,
    dryRunClassification: input.dryRunClassification,
    plan: input.plan,
    outcome: input.outcome,
  };
}

function fmtEpisodeUpdate(u: EpisodeUpdatePlan): string {
  const changed = Object.entries(u.changes)
    .map(([field, value]) => `${field}=${JSON.stringify(value)}`)
    .join(', ');
  return `S${u.seasonNumber}E${u.episodeNumber} (${u.episodeId}): ${changed}`;
}

function fmtPosterUpdate(u: PosterUpdatePlan | null): string {
  if (!u) return '_no change (poster already set, or provider has none)_';
  return `${u.from ?? '_none_'} → **${u.to}**`;
}

export function buildFriendsApplyMarkdownReport(report: FriendsApplyReport): string {
  const lines: string[] = [];
  lines.push('# Friends + TVmaze 431 — Single-Title Apply');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Mode: \`${report.mode}\`${report.applied ? ' — **writes were made**' : ' — preview only, nothing written'}`);
  lines.push(`Target user: \`${report.targetUserId}\``);
  lines.push('');
  lines.push(`> ${report.outcome}`);
  lines.push('');
  lines.push('## Guard');
  lines.push('');
  lines.push(`- Allowed: ${report.guard.allowed ? 'yes' : 'no'}`);
  if (report.guard.violations.length > 0) {
    lines.push('- Violations:');
    for (const v of report.guard.violations) lines.push(`  - ${v}`);
  }
  lines.push(`- Dry-run classification at time of run: \`${report.dryRunClassification ?? '_not computed_'}\``);
  lines.push('');

  if (report.plan) {
    lines.push('## Plan');
    lines.push('');
    lines.push(`- ExternalIds: provider=\`${report.plan.externalIdsUpdate.provider}\`, providerId=\`${report.plan.externalIdsUpdate.providerId}\``);
    lines.push(`- Poster: ${fmtPosterUpdate(report.plan.posterUpdate)}`);
    lines.push(`- UserSeriesProgress: userStatus → \`${report.plan.progressUpdate.userStatus}\`, nextEpisodeId → \`${report.plan.progressUpdate.nextEpisodeId ?? 'null'}\` (lastWatchedAt left unchanged)`);
    lines.push(`- Episode field updates: ${report.plan.episodeUpdateCount}`);
    if (report.plan.episodeUpdateCount > 0) {
      lines.push('');
      lines.push('<details><summary>Episode updates</summary>');
      lines.push('');
      for (const u of report.plan.episodeUpdates) lines.push(`- ${fmtEpisodeUpdate(u)}`);
      lines.push('');
      lines.push('</details>');
    }
    lines.push('');
  }

  return lines.join('\n');
}

export interface WrittenFriendsApplyReportPaths {
  latestJsonPath: string;
  latestMarkdownPath: string;
  archivedJsonPath: string;
  archivedMarkdownPath: string;
}

export function writeFriendsApplyReports(outDir: string, report: FriendsApplyReport, markdown: string): WrittenFriendsApplyReportPaths {
  const runsDir = path.join(outDir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  const json = JSON.stringify(report, null, 2);
  const timestamp = report.generatedAt.replace(/[:.]/g, '-');

  const latestJsonPath = path.join(outDir, 'latest-apply-friends-tvmaze-report.json');
  const latestMarkdownPath = path.join(outDir, 'latest-apply-friends-tvmaze-report.md');
  const archivedJsonPath = path.join(runsDir, `${timestamp}-apply-friends-tvmaze-report.json`);
  const archivedMarkdownPath = path.join(runsDir, `${timestamp}-apply-friends-tvmaze-report.md`);

  writeFileSync(latestJsonPath, json);
  writeFileSync(latestMarkdownPath, markdown);
  writeFileSync(archivedJsonPath, json);
  writeFileSync(archivedMarkdownPath, markdown);

  return { latestJsonPath, latestMarkdownPath, archivedJsonPath, archivedMarkdownPath };
}
