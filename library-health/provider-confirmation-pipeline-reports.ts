// Report shape + file-writing for the general provider-confirmation
// pipeline (library-health:pipeline). Deliberately more concise than
// provider-confirmation-decisions-reports.ts's exhaustive per-series dry
// run report — this is meant to be skimmed after every scheduled run, not
// read like a full audit.

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { DryRunClassification, SupportedProvider } from './provider-confirmation-decisions-logic';
import { MigrationClassification, StatusSource } from './migration-confirmation-logic';
import { OrphanedWatchedEpisode } from './season-zero-orphan-logic';
import { IdentityConfidenceBand } from './migration-policy-logic';
import { MigrationOperatingClassification } from '../src/common/migration-operating-classification';

// Phase 7 verification, run automatically for every real apply (see
// run-provider-confirmation-pipeline.ts) — compact pass/fail summary in the
// report; the full per-check detail is logged to the console at apply time
// rather than duplicated into the JSON report on every run.
export interface AppliedVerificationResult {
  passed: boolean;
  failedChecks: string[];
}

// Additive fields from the stable-version migration policy work — present
// on every entry (not just migration-mode ones) so a report reader never
// has to know two separate vocabularies. autoMigrationEligible/identityBand
// are computed for EVERY confirmed decision regardless of migrationIntent;
// catalog-reconciliation counts (seasonsCreated/episodesCreated) are the
// NEW missing-season/episode creation capability (see
// migration-catalog-plan-logic.ts) applied uniformly to every applied/safe
// title, not just migration-mode ones.
export interface OperatingOutcomeFields {
  operatingClassification: MigrationOperatingClassification;
  identityBand: IdentityConfidenceBand;
  autoMigrationEligible: boolean;
  autoMigrationEligibilityReason: string;
}

export interface CatalogReconciliationFields {
  seasonsCreated: number[];
  episodesCreated: number;
  matchedWatchedCount: number;
  matchedTotalCount: number;
}

// Present on both applied and dry-run-safe entries so a batch manifest (see
// batch-manifest-logic.ts) can read "current vs proposed" the same way
// regardless of whether writes actually happened yet. For dry-run entries
// these are previews (what WOULD change), never something already written.
export interface ProgressChangeFields {
  userStatus: { from: string; to: string; changed: boolean };
  nextEpisodeId: { from: string | null; to: string | null; changed: boolean };
}

// migrationIntent/statusSource/migrationClassification are additive on
// every entry type below: migrationIntent is false and
// migrationClassification is null for every ordinary (non-migration)
// series — classification always stays the BASE
// classifyProviderConfirmationDryRun result, never overwritten by a
// migration outcome, so a report consumer that predates migration mode
// still sees exactly what it always saw. See migration-confirmation-logic.ts.
export interface PipelineAppliedSeriesEntry extends OperatingOutcomeFields, CatalogReconciliationFields, ProgressChangeFields {
  title: string;
  seriesId: string;
  provider: SupportedProvider;
  providerId: string;
  classification: DryRunClassification;
  episodeUpdateCount: number;
  posterUpdated: boolean;
  preservedOrphanEpisodeCount: number;
  preservedOrphanEpisodes: OrphanedWatchedEpisode[];
  migrationIntent: boolean;
  statusSource: StatusSource;
  migrationClassification: MigrationClassification | null;
  // True when this title reached the safe-to-apply branch via the new
  // objective auto-policy rather than an already-safe base classification
  // or an explicit migrationIntent — i.e. it would have required a manual
  // migrationIntent flag before this task.
  viaAutoMigrationPolicy: boolean;
  verification: AppliedVerificationResult;
}

// Safe classification, but nothing was written because the pipeline ran in
// dry-run mode (the default) — the would-be plan is summarized the same
// way an applied entry would be, minus anything that only exists once a
// transaction actually runs.
export interface PipelineDryRunSafeEntry extends OperatingOutcomeFields, CatalogReconciliationFields, ProgressChangeFields {
  title: string;
  seriesId: string;
  provider: SupportedProvider;
  providerId: string;
  classification: DryRunClassification;
  episodeUpdateCount: number;
  wouldUpdatePoster: boolean;
  preservedOrphanEpisodeCount: number;
  preservedOrphanEpisodes: OrphanedWatchedEpisode[];
  migrationIntent: boolean;
  statusSource: StatusSource;
  migrationClassification: MigrationClassification | null;
  viaAutoMigrationPolicy: boolean;
}

// Already has this exact provider/providerId in ExternalIds AND the plan
// would write nothing new (no episode changes, no poster change, no
// progress change) — a true no-op re-confirmation, not a pending apply.
// Reported separately so it stops appearing under dryRunSafeSeries/
// appliedSeries run after run once there's genuinely nothing left to do.
export interface PipelineAlreadyAppliedSeriesEntry {
  title: string;
  seriesId: string;
  provider: SupportedProvider;
  providerId: string;
  classification: DryRunClassification;
  migrationIntent: boolean;
  migrationClassification: MigrationClassification | null;
}

export interface PipelineSkippedSeriesEntry {
  title: string;
  seriesId: string | null;
  classification: DryRunClassification | null;
  reason: string;
  migrationIntent: boolean;
  migrationClassification: MigrationClassification | null;
  // Null for skips that happen before any classification is possible at
  // all (no local series found, no provider/providerId set) — those are
  // REVIEW_IDENTITY by construction but not worth a full computed object
  // for a case with no fetched candidate to reason about.
  operatingClassification: MigrationOperatingClassification | null;
}

export interface PipelineErrorEntry {
  title: string;
  message: string;
}

export interface PipelineManualReviewCandidate {
  title: string;
  seriesId: string;
  reason: string;
}

export interface ProviderConfirmationPipelineReport {
  generatedAt: string;
  mode: 'dry-run' | 'apply';
  writesToAppTables: boolean;
  writesToProviderData: false;
  targetUserId: string;
  decisionsFilePath: string;
  summary: {
    appliedCount: number;
    dryRunSafeCount: number;
    alreadyAppliedCount: number;
    skippedBlockedCount: number;
    skippedDeferredCount: number;
    errorCount: number;
    manualReviewCandidateCount: number;
    preservedOrphanEpisodeCount: number;
    // New in the stable-version migration policy work.
    viaAutoMigrationPolicyCount: number;
    seasonsCreatedCount: number;
    episodesCreatedCount: number;
    operatingClassificationCounts: Record<MigrationOperatingClassification, number>;
    // Phase 7 verification, run automatically for every real apply. A
    // non-zero count here means a write happened that didn't match its own
    // expectation — investigate before applying any further batches.
    verificationFailureCount: number;
  };
  appliedSeries: PipelineAppliedSeriesEntry[];
  dryRunSafeSeries: PipelineDryRunSafeEntry[];
  // True no-op re-confirmations — see PipelineAlreadyAppliedSeriesEntry.
  alreadyAppliedSeries: PipelineAlreadyAppliedSeriesEntry[];
  skippedBlockedSeries: PipelineSkippedSeriesEntry[];
  // Covers both decision === 'defer' and decision === 'skip' entries from
  // the decisions file — neither is ever applied, and this task's report
  // shape doesn't distinguish the two (both mean "a human already looked
  // and chose not to confirm yet").
  skippedDeferredSeries: PipelineSkippedSeriesEntry[];
  errors: PipelineErrorEntry[];
  // Local series with no confirmed provider match at all — no
  // provider-confirmation-decisions.json entry, or an entry that isn't
  // "confirm" — surfaced as the next candidates for the separate,
  // human-driven library-health:missing-provider-candidates /
  // library-health:provider-confirmation discovery workflow. This pipeline
  // never invents a provider identity itself.
  nextManualReviewCandidates: PipelineManualReviewCandidate[];
}

export function buildProviderConfirmationPipelineReport(input: {
  generatedAt: Date;
  mode: 'dry-run' | 'apply';
  targetUserId: string;
  decisionsFilePath: string;
  appliedSeries: PipelineAppliedSeriesEntry[];
  dryRunSafeSeries: PipelineDryRunSafeEntry[];
  alreadyAppliedSeries: PipelineAlreadyAppliedSeriesEntry[];
  skippedBlockedSeries: PipelineSkippedSeriesEntry[];
  skippedDeferredSeries: PipelineSkippedSeriesEntry[];
  errors: PipelineErrorEntry[];
  nextManualReviewCandidates: PipelineManualReviewCandidate[];
}): ProviderConfirmationPipelineReport {
  const preservedOrphanEpisodeCount =
    input.appliedSeries.reduce((sum, s) => sum + s.preservedOrphanEpisodeCount, 0) + input.dryRunSafeSeries.reduce((sum, s) => sum + s.preservedOrphanEpisodeCount, 0);
  const viaAutoMigrationPolicyCount =
    input.appliedSeries.filter((s) => s.viaAutoMigrationPolicy).length + input.dryRunSafeSeries.filter((s) => s.viaAutoMigrationPolicy).length;
  const seasonsCreatedCount = input.appliedSeries.reduce((sum, s) => sum + s.seasonsCreated.length, 0);
  const episodesCreatedCount = input.appliedSeries.reduce((sum, s) => sum + s.episodesCreated, 0);
  const verificationFailureCount = input.appliedSeries.filter((s) => !s.verification.passed).length;

  const operatingClassificationCounts: Record<MigrationOperatingClassification, number> = {
    AUTO_MIGRATE: 0,
    AUTO_REFRESH: 0,
    REVIEW_IDENTITY: 0,
    REVIEW_ALIGNMENT: 0,
    PROVIDER_ERROR: 0,
  };
  for (const s of [...input.appliedSeries, ...input.dryRunSafeSeries]) {
    operatingClassificationCounts[s.operatingClassification] += 1;
  }
  for (const s of [...input.skippedBlockedSeries, ...input.skippedDeferredSeries]) {
    if (s.operatingClassification) operatingClassificationCounts[s.operatingClassification] += 1;
  }
  operatingClassificationCounts.PROVIDER_ERROR += input.errors.length;

  return {
    generatedAt: input.generatedAt.toISOString(),
    mode: input.mode,
    writesToAppTables: input.mode === 'apply' && input.appliedSeries.length > 0,
    writesToProviderData: false,
    targetUserId: input.targetUserId,
    decisionsFilePath: input.decisionsFilePath,
    summary: {
      appliedCount: input.appliedSeries.length,
      dryRunSafeCount: input.dryRunSafeSeries.length,
      alreadyAppliedCount: input.alreadyAppliedSeries.length,
      skippedBlockedCount: input.skippedBlockedSeries.length,
      skippedDeferredCount: input.skippedDeferredSeries.length,
      errorCount: input.errors.length,
      manualReviewCandidateCount: input.nextManualReviewCandidates.length,
      preservedOrphanEpisodeCount,
      viaAutoMigrationPolicyCount,
      seasonsCreatedCount,
      episodesCreatedCount,
      operatingClassificationCounts,
      verificationFailureCount,
    },
    appliedSeries: input.appliedSeries,
    dryRunSafeSeries: input.dryRunSafeSeries,
    alreadyAppliedSeries: input.alreadyAppliedSeries,
    skippedBlockedSeries: input.skippedBlockedSeries,
    skippedDeferredSeries: input.skippedDeferredSeries,
    errors: input.errors,
    nextManualReviewCandidates: input.nextManualReviewCandidates,
  };
}

// The JSON report always carries the full list — this only caps how many
// get spelled out in the markdown, which is meant to be skimmed after
// every run, not read as a full audit (unlike
// provider-confirmation-decisions-reports.ts's exhaustive dry-run report).
const MAX_MANUAL_REVIEW_CANDIDATES_IN_MARKDOWN = 20;

function fmtOrphans(episodes: OrphanedWatchedEpisode[]): string {
  if (episodes.length === 0) return 'none';
  return episodes.map((e) => `S${e.seasonNumber}E${e.episodeNumber}`).join(', ');
}

function fmtMigration(entry: { migrationIntent: boolean; migrationClassification: MigrationClassification | null }): string {
  if (!entry.migrationIntent) return '';
  return ` · **migration mode** → \`${entry.migrationClassification}\``;
}

export function buildProviderConfirmationPipelineMarkdownReport(report: ProviderConfirmationPipelineReport): string {
  const lines: string[] = [];
  lines.push('# Provider Confirmation Pipeline');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Mode: \`${report.mode}\`${report.writesToAppTables ? ' — **writes were made**' : ' — no writes'}`);
  lines.push(`Target user: \`${report.targetUserId}\``);
  lines.push(`Decisions file: \`${report.decisionsFilePath}\``);
  lines.push('');
  lines.push('| | Count |');
  lines.push('| --- | --- |');
  lines.push(`| Applied | ${report.summary.appliedCount} |`);
  lines.push(`| Safe, not applied (dry-run) | ${report.summary.dryRunSafeCount} |`);
  lines.push(`| Already applied (no changes needed) | ${report.summary.alreadyAppliedCount} |`);
  lines.push(`| Skipped — blocked | ${report.summary.skippedBlockedCount} |`);
  lines.push(`| Skipped — deferred/skip | ${report.summary.skippedDeferredCount} |`);
  lines.push(`| Errors | ${report.summary.errorCount} |`);
  lines.push(`| Next manual-review candidates | ${report.summary.manualReviewCandidateCount} |`);
  lines.push(`| Preserved orphan episodes (total) | ${report.summary.preservedOrphanEpisodeCount} |`);
  lines.push(`| Via new auto-migration policy (no migrationIntent needed) | ${report.summary.viaAutoMigrationPolicyCount} |`);
  lines.push(`| Seasons created | ${report.summary.seasonsCreatedCount} |`);
  lines.push(`| Episodes created (catalog reconciliation) | ${report.summary.episodesCreatedCount} |`);
  lines.push(`| Post-apply verification failures | ${report.summary.verificationFailureCount} |`);
  lines.push('');

  if (report.summary.verificationFailureCount > 0) {
    lines.push('## ⚠ Verification failures — investigate before applying further batches');
    lines.push('');
    for (const s of report.appliedSeries.filter((s) => !s.verification.passed)) {
      lines.push(`- **${s.title}** (\`${s.seriesId}\`): ${s.verification.failedChecks.join(', ')}`);
    }
    lines.push('');
  }
  lines.push('| Operating classification | Count |');
  lines.push('| --- | --- |');
  for (const [classification, count] of Object.entries(report.summary.operatingClassificationCounts)) {
    lines.push(`| ${classification} | ${count} |`);
  }
  lines.push('');

  if (report.appliedSeries.length > 0) {
    lines.push('## Applied');
    lines.push('');
    for (const s of report.appliedSeries) {
      lines.push(
        `- **${s.title}** (\`${s.provider}:${s.providerId}\`, \`${s.classification}\` → \`${s.operatingClassification}\`) — ${s.episodeUpdateCount} episode field update(s)` +
          `${s.posterUpdated ? ', poster updated' : ''}${s.userStatus.changed ? `, userStatus ${s.userStatus.from} → ${s.userStatus.to}` : ''}` +
          `${s.seasonsCreated.length > 0 ? `, ${s.seasonsCreated.length} season(s) created` : ''}${s.episodesCreated > 0 ? `, ${s.episodesCreated} episode(s) created` : ''}` +
          `${s.preservedOrphanEpisodeCount > 0 ? ` — preserved orphan(s): ${fmtOrphans(s.preservedOrphanEpisodes)}` : ''}` +
          fmtMigration(s) +
          `${s.viaAutoMigrationPolicy ? ` · **auto-migration policy** (identity: ${s.identityBand}, status source: ${s.statusSource})` : ''}` +
          `${s.migrationIntent ? ` (status source: ${s.statusSource})` : ''}`,
      );
    }
    lines.push('');
  }

  if (report.dryRunSafeSeries.length > 0) {
    lines.push('## Safe to apply, not applied (dry-run mode)');
    lines.push('');
    for (const s of report.dryRunSafeSeries) {
      lines.push(
        `- **${s.title}** (\`${s.provider}:${s.providerId}\`, \`${s.classification}\` → \`${s.operatingClassification}\`) — would update ${s.episodeUpdateCount} episode field(s)` +
          `${s.wouldUpdatePoster ? ', would update poster' : ''}${s.userStatus.changed ? `, userStatus would change ${s.userStatus.from} → ${s.userStatus.to}` : ''}` +
          `${s.seasonsCreated.length > 0 ? `, ${s.seasonsCreated.length} season(s) would be created` : ''}${s.episodesCreated > 0 ? `, ${s.episodesCreated} episode(s) would be created` : ''}` +
          `${s.preservedOrphanEpisodeCount > 0 ? ` — would preserve orphan(s): ${fmtOrphans(s.preservedOrphanEpisodes)}` : ''}` +
          fmtMigration(s) +
          `${s.viaAutoMigrationPolicy ? ` · **auto-migration policy** (identity: ${s.identityBand}, status source: ${s.statusSource})` : ''}` +
          `${s.migrationIntent ? ` (status source: ${s.statusSource})` : ''}`,
      );
    }
    lines.push('');
  }

  if (report.alreadyAppliedSeries.length > 0) {
    lines.push('## Already applied (no changes needed)');
    lines.push('');
    for (const s of report.alreadyAppliedSeries) {
      lines.push(`- **${s.title}** (\`${s.provider}:${s.providerId}\`, \`${s.classification}\`) — ExternalIds already matches, nothing new to write.${fmtMigration(s)}`);
    }
    lines.push('');
  }

  if (report.skippedBlockedSeries.length > 0) {
    lines.push('## Skipped — blocked (never auto-applied)');
    lines.push('');
    for (const s of report.skippedBlockedSeries) {
      lines.push(`- **${s.title}**${s.classification ? ` (\`${s.classification}\`)` : ''} — ${s.reason}${fmtMigration(s)}`);
    }
    lines.push('');
  }

  if (report.skippedDeferredSeries.length > 0) {
    lines.push('## Skipped — deferred/skip');
    lines.push('');
    for (const s of report.skippedDeferredSeries) {
      lines.push(`- **${s.title}** — ${s.reason}`);
    }
    lines.push('');
  }

  if (report.errors.length > 0) {
    lines.push('## Errors');
    lines.push('');
    for (const e of report.errors) {
      lines.push(`- **${e.title}** — ${e.message}`);
    }
    lines.push('');
  }

  if (report.nextManualReviewCandidates.length > 0) {
    lines.push('## Next manual-review candidates');
    lines.push('');
    lines.push('_No confirmed provider match yet. Run `library-health:missing-provider-candidates` / `library-health:provider-confirmation` to investigate, then add a decision to `provider-confirmation-decisions.json`._');
    lines.push('');
    const shown = report.nextManualReviewCandidates.slice(0, MAX_MANUAL_REVIEW_CANDIDATES_IN_MARKDOWN);
    for (const c of shown) {
      lines.push(`- **${c.title}** — ${c.reason}`);
    }
    const remaining = report.nextManualReviewCandidates.length - shown.length;
    if (remaining > 0) {
      lines.push(`- _...and ${remaining} more — see the JSON report for the full list._`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export interface WrittenProviderConfirmationPipelinePaths {
  latestJsonPath: string;
  latestMarkdownPath: string;
  archivedJsonPath: string;
  archivedMarkdownPath: string;
}

export function writeProviderConfirmationPipelineReports(
  outDir: string,
  report: ProviderConfirmationPipelineReport,
  markdown: string,
): WrittenProviderConfirmationPipelinePaths {
  const runsDir = path.join(outDir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  const json = JSON.stringify(report, null, 2);
  const timestamp = report.generatedAt.replace(/[:.]/g, '-');

  const latestJsonPath = path.join(outDir, 'latest-provider-confirmation-pipeline-report.json');
  const latestMarkdownPath = path.join(outDir, 'latest-provider-confirmation-pipeline-report.md');
  const archivedJsonPath = path.join(runsDir, `${timestamp}-provider-confirmation-pipeline-report.json`);
  const archivedMarkdownPath = path.join(runsDir, `${timestamp}-provider-confirmation-pipeline-report.md`);

  writeFileSync(latestJsonPath, json);
  writeFileSync(latestMarkdownPath, markdown);
  writeFileSync(archivedJsonPath, json);
  writeFileSync(archivedMarkdownPath, markdown);

  return { latestJsonPath, latestMarkdownPath, archivedJsonPath, archivedMarkdownPath };
}
