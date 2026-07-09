// Report shape + file-writing for the provider-confirmation-decisions dry
// run. Kept separate from the orchestration script, same split as every
// other report module in this repo.

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { SeasonShape } from '../tmdb-enrichment/season-structure-tiebreak';
import { DryRunClassification, ProviderConfirmationDecisionType, SupportedProvider } from './provider-confirmation-decisions-logic';
import { OrphanedWatchedEpisode } from './season-zero-orphan-logic';

export interface ProposedFieldUpdate<T> {
  from: T;
  to: T;
  wouldChange: boolean;
}

export interface DryRunSeriesEntry {
  title: string;
  decision: ProviderConfirmationDecisionType;
  provider: SupportedProvider | null;
  providerId: string | null;
  notes: string | null;
  // null exactly for skip/defer/excluded entries — no dry-run was attempted.
  classification: DryRunClassification | null;
  reason: string;
  seriesId: string | null;
  localSeasonShape: SeasonShape | null;
  providerSeasonShape: SeasonShape | null;
  watchedEpisodeCount: number | null;
  watchedEpisodesOrphaned: number | null;
  newEpisodesCount: number | null;
  releasedNewEpisodesCount: number | null;
  futureNewEpisodesCount: number | null;
  fieldChangeCount: number | null;
  proposedExternalIdsUpdate: { tmdbId: string | null; provider: SupportedProvider; providerId: string } | null;
  proposedPosterUpdate: ProposedFieldUpdate<string | null> | null;
  proposedBackdropUpdate: ProposedFieldUpdate<string | null> | null;
  proposedNextEpisodeChange: (ProposedFieldUpdate<string | null> & { toLabel: string | null; toIsNew: boolean }) | null;
  proposedUserStatusChange: ProposedFieldUpdate<string> | null;
  warnings: string[];
  // Populated whenever a season-zero-orphan check was run (i.e. the
  // comparison found something that would otherwise block) — see
  // season-zero-orphan-logic.ts. null when no check was needed/run (e.g.
  // skip/defer/excluded entries, or entries that never got far enough to
  // compare).
  orphanSeasonZeroEpisodeCount: number | null;
  orphanSeasonZeroEpisodes: OrphanedWatchedEpisode[] | null;
  realSeasonShapeMatchesProvider: boolean | null;
  // Only ever set alongside classification === 'SAFE_WITH_SPLIT_EPISODE_TAIL'
  // — the tail orphan rows a future apply step must preserve as-is
  // (no delete, no renumber, no overwrite). See split-episode-tail-logic.ts.
  tailOrphanedEpisodes: OrphanedWatchedEpisode[] | null;
  // Only ever set alongside classification === 'SAFE_WITH_LOCAL_SPECIAL_ORPHAN'
  // or 'SAFE_WITH_SPLIT_EPISODE_TAIL'.
  recommendation: string | null;
}

export interface ProviderConfirmationDryRunReport {
  generatedAt: string;
  mode: 'dry-run';
  writesToAppTables: false;
  writesToProviderData: false;
  targetUserId: string;
  decisionsFilePath: string;
  decisionsLoadedCount: number;
  summary: {
    countByClassification: Record<DryRunClassification, number>;
    countByDecision: Record<ProviderConfirmationDecisionType, number>;
  };
  series: DryRunSeriesEntry[];
}

const ALL_CLASSIFICATIONS: DryRunClassification[] = [
  'SAFE_TO_APPLY_LATER',
  'SAFE_WITH_LOCAL_SPECIAL_ORPHAN',
  'SAFE_WITH_SPLIT_EPISODE_TAIL',
  'NEEDS_MANUAL_REVIEW',
  'BLOCKED_RISK',
  'PROVIDER_NOT_FOUND',
  'LOCAL_SERIES_NOT_FOUND',
];
const ALL_DECISIONS: ProviderConfirmationDecisionType[] = ['confirm', 'skip', 'defer'];

export function buildProviderConfirmationDryRunReport(input: {
  generatedAt: Date;
  targetUserId: string;
  decisionsFilePath: string;
  decisionsLoadedCount: number;
  series: DryRunSeriesEntry[];
}): ProviderConfirmationDryRunReport {
  const countByClassification = Object.fromEntries(
    ALL_CLASSIFICATIONS.map((c) => [c, input.series.filter((s) => s.classification === c).length]),
  ) as Record<DryRunClassification, number>;
  const countByDecision = Object.fromEntries(ALL_DECISIONS.map((d) => [d, input.series.filter((s) => s.decision === d).length])) as Record<
    ProviderConfirmationDecisionType,
    number
  >;

  return {
    generatedAt: input.generatedAt.toISOString(),
    mode: 'dry-run',
    writesToAppTables: false,
    writesToProviderData: false,
    targetUserId: input.targetUserId,
    decisionsFilePath: input.decisionsFilePath,
    decisionsLoadedCount: input.decisionsLoadedCount,
    summary: { countByClassification, countByDecision },
    series: input.series,
  };
}

const CLASSIFICATION_LABELS: Record<DryRunClassification, string> = {
  SAFE_TO_APPLY_LATER: 'Safe to apply later',
  SAFE_WITH_LOCAL_SPECIAL_ORPHAN: 'Safe, with a local special orphan',
  SAFE_WITH_SPLIT_EPISODE_TAIL: 'Safe, with a split-episode tail',
  NEEDS_MANUAL_REVIEW: 'Needs manual review',
  BLOCKED_RISK: 'Blocked — risk',
  PROVIDER_NOT_FOUND: 'Provider not found',
  LOCAL_SERIES_NOT_FOUND: 'Local series not found',
};

function fmtShape(shape: SeasonShape | null): string {
  if (!shape) return '_unknown_';
  return `${shape.seasonCount} season(s) [${shape.episodesPerSeason.join(', ')}] = ${shape.totalEpisodeCount} episodes`;
}

function fmtFieldUpdate(update: ProposedFieldUpdate<string | null> | null): string {
  if (!update) return '_n/a_';
  if (!update.wouldChange) return `unchanged (${update.from ?? '_none_'})`;
  return `${update.from ?? '_none_'} → **${update.to ?? '_none_'}**`;
}

export function buildProviderConfirmationDryRunMarkdownReport(report: ProviderConfirmationDryRunReport): string {
  const lines: string[] = [];
  lines.push('# Provider Confirmation Decisions — Dry Run');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Target user: \`${report.targetUserId}\``);
  lines.push(`Decisions file: \`${report.decisionsFilePath}\` (${report.decisionsLoadedCount} entries loaded)`);
  lines.push('');
  lines.push(
    '**Dry run only.** No writes to any app table, no provider writes, no apply mode — every "proposed" field ' +
      'below is a preview only. See `library-health/provider-confirmation-decisions-logic.ts`.',
  );
  lines.push('');
  lines.push('| Classification | Count |');
  lines.push('| --- | --- |');
  for (const c of ALL_CLASSIFICATIONS) lines.push(`| ${CLASSIFICATION_LABELS[c]} | ${report.summary.countByClassification[c]} |`);
  lines.push('');
  lines.push('| Decision | Count |');
  lines.push('| --- | --- |');
  for (const d of ALL_DECISIONS) lines.push(`| ${d} | ${report.summary.countByDecision[d]} |`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const entry of report.series) {
    lines.push(`## ${entry.title}`);
    lines.push('');
    lines.push(`- Decision: \`${entry.decision}\`${entry.provider ? ` · Provider: \`${entry.provider}\` id \`${entry.providerId}\`` : ''}`);
    if (entry.notes) lines.push(`- Notes: ${entry.notes}`);
    lines.push(`- Classification: \`${entry.classification ?? '_not attempted_'}\``);
    lines.push('');
    lines.push(`> ${entry.reason}`);
    lines.push('');

    if (entry.classification !== null) {
      lines.push(`- Local shape: ${fmtShape(entry.localSeasonShape)} · Provider shape: ${fmtShape(entry.providerSeasonShape)}`);
      lines.push(`- Watched: ${entry.watchedEpisodeCount ?? '_?_'} (orphaned: ${entry.watchedEpisodesOrphaned ?? 0})`);
      lines.push(`- New episodes: ${entry.newEpisodesCount ?? 0} (released: ${entry.releasedNewEpisodesCount ?? 0}, future: ${entry.futureNewEpisodesCount ?? 0}) · Field changes: ${entry.fieldChangeCount ?? 0}`);
      if (entry.orphanSeasonZeroEpisodeCount !== null) {
        lines.push(
          `- Season-0 orphans: ${entry.orphanSeasonZeroEpisodeCount}${entry.orphanSeasonZeroEpisodes && entry.orphanSeasonZeroEpisodes.length > 0 ? ` (${entry.orphanSeasonZeroEpisodes.map((e) => `S${e.seasonNumber}E${e.episodeNumber}`).join(', ')})` : ''} · Real seasons match provider: ${entry.realSeasonShapeMatchesProvider === null ? '_?_' : entry.realSeasonShapeMatchesProvider ? 'yes' : 'no'}`,
        );
      }
      if (entry.tailOrphanedEpisodes && entry.tailOrphanedEpisodes.length > 0) {
        lines.push(
          `- Split-episode tail orphans (to be preserved, not deleted/renumbered/overwritten): ${entry.tailOrphanedEpisodes.map((e) => `S${e.seasonNumber}E${e.episodeNumber}`).join(', ')}`,
        );
      }
      if (entry.recommendation) lines.push(`- **Recommendation**: ${entry.recommendation}`);
      lines.push('');
      lines.push('**Proposed changes (preview only — nothing written):**');
      lines.push('');
      if (entry.proposedExternalIdsUpdate) {
        lines.push(`- ExternalIds: provider=\`${entry.proposedExternalIdsUpdate.provider}\`, providerId=\`${entry.proposedExternalIdsUpdate.providerId}\`, tmdbId=\`${entry.proposedExternalIdsUpdate.tmdbId ?? 'unchanged'}\``);
      }
      lines.push(`- Poster: ${fmtFieldUpdate(entry.proposedPosterUpdate)}`);
      lines.push(`- Backdrop: ${fmtFieldUpdate(entry.proposedBackdropUpdate)}`);
      if (entry.proposedNextEpisodeChange) {
        const c = entry.proposedNextEpisodeChange;
        lines.push(`- nextEpisodeId: ${c.wouldChange ? `**would change** to ${c.toLabel ?? c.to ?? '_none_'}${c.toIsNew ? ' (new episode, not yet in DB)' : ''}` : 'unchanged'}`);
      }
      if (entry.proposedUserStatusChange) {
        lines.push(`- userStatus: ${fmtFieldUpdate(entry.proposedUserStatusChange)}`);
      }
      if (entry.warnings.length > 0) {
        lines.push('- Warnings:');
        for (const w of entry.warnings) lines.push(`  - ${w}`);
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

export interface WrittenProviderConfirmationDryRunPaths {
  latestJsonPath: string;
  latestMarkdownPath: string;
  archivedJsonPath: string;
  archivedMarkdownPath: string;
}

export function writeProviderConfirmationDryRunReports(
  outDir: string,
  report: ProviderConfirmationDryRunReport,
  markdown: string,
): WrittenProviderConfirmationDryRunPaths {
  const runsDir = path.join(outDir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  const json = JSON.stringify(report, null, 2);
  const timestamp = report.generatedAt.replace(/[:.]/g, '-');

  const latestJsonPath = path.join(outDir, 'latest-provider-confirmation-dry-run.json');
  const latestMarkdownPath = path.join(outDir, 'latest-provider-confirmation-dry-run.md');
  const archivedJsonPath = path.join(runsDir, `${timestamp}-provider-confirmation-dry-run.json`);
  const archivedMarkdownPath = path.join(runsDir, `${timestamp}-provider-confirmation-dry-run.md`);

  writeFileSync(latestJsonPath, json);
  writeFileSync(latestMarkdownPath, markdown);
  writeFileSync(archivedJsonPath, json);
  writeFileSync(archivedMarkdownPath, markdown);

  return { latestJsonPath, latestMarkdownPath, archivedJsonPath, archivedMarkdownPath };
}
