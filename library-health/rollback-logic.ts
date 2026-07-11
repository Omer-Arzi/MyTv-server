// Pure rollback-readiness logic — Phase 8 of the stable-version migration
// policy work. Deliberately NOT a delete executor: this module only
// determines WHETHER a rollback is safe and WHAT it would do if run. The
// gated executor (which still refuses unless eligibility says so) lives in
// rollback-executor.ts; no run-*.ts script in this task ever invokes it —
// wiring a real rollback command is Phase 11 rollout work, contingent on
// this eligibility logic being tested and trusted first.
//
// Built directly from PipelineAppliedSeriesEntry (extend, don't duplicate,
// per the task's instruction) — the applied-series report already records
// exactly what a rollback needs to know: prior vs. new userStatus/
// nextEpisodeId (see ProgressChangeFields), and how many
// seasons/episodes were created under this batch's importBatchId.
//
// Documented, permanent scope limitation (not a bug): episode METADATA
// backfills (title/overview/airDate/runtime updates on already-matched
// episodes, via planEpisodeUpdates) are not reversible by this module.
// PipelineAppliedSeriesEntry's episodeUpdateCount records how many fields
// changed but not their prior values — no schema column or report field
// captures the old value today. Reverting those would require either a
// per-field before/after audit log or snapshotting the whole row pre-write,
// neither of which exists. Recorded here explicitly, per the task's
// instruction to document missing schema/data support rather than silently
// skip it. Rollback below is scoped to what CAN be verified safe: reversing
// row CREATION (Season/Episode rows this batch alone created) and restoring
// UserSeriesProgress to its pre-apply value.

import { PipelineAppliedSeriesEntry, ProviderConfirmationPipelineReport } from './provider-confirmation-pipeline-reports';

export interface RollbackManifestEntry {
  seriesId: string;
  title: string;
  importBatchId: string;
  priorUserStatus: string;
  priorNextEpisodeId: string | null;
  appliedUserStatus: string;
  appliedNextEpisodeId: string | null;
  createdSeasonNumbers: number[];
  createdEpisodeCount: number;
  episodeMetadataUpdateCount: number;
  // True iff this entry has anything a rollback could safely reverse
  // (created rows and/or a progress change). False for e.g. a poster-only
  // or metadata-only apply, where the only changes made are ones this
  // module cannot safely undo.
  hasReversibleChanges: boolean;
  unsupportedChangeNote: string | null;
}

export interface RollbackManifest {
  batchId: string;
  generatedAt: string;
  targetUserId: string;
  entries: RollbackManifestEntry[];
  scopeNote: string;
}

const SCOPE_NOTE =
  'This rollback manifest covers Season/Episode rows created by this batch (identified by importBatchId) and UserSeriesProgress restoration only. ' +
  'Episode metadata field backfills (title/overview/airDate/runtime on already-matched episodes) and ExternalIds changes are NOT reversible by this ' +
  'tool — no prior-value snapshot exists in the current schema/report shape. See rollback-logic.ts header comment.';

function toManifestEntry(s: PipelineAppliedSeriesEntry, importBatchId: string): RollbackManifestEntry {
  const hasCreatedRows = s.seasonsCreated.length > 0 || s.episodesCreated > 0;
  const hasProgressChange = s.userStatus.changed || s.nextEpisodeId.changed;
  return {
    seriesId: s.seriesId,
    title: s.title,
    importBatchId,
    priorUserStatus: s.userStatus.from,
    priorNextEpisodeId: s.nextEpisodeId.from,
    appliedUserStatus: s.userStatus.to,
    appliedNextEpisodeId: s.nextEpisodeId.to,
    createdSeasonNumbers: s.seasonsCreated,
    createdEpisodeCount: s.episodesCreated,
    episodeMetadataUpdateCount: s.episodeUpdateCount,
    hasReversibleChanges: hasCreatedRows || hasProgressChange,
    unsupportedChangeNote: s.episodeUpdateCount > 0 ? `${s.episodeUpdateCount} episode metadata field update(s) applied — not reversible by this tool.` : null,
  };
}

export function buildRollbackManifest(input: { report: ProviderConfirmationPipelineReport; batchId: string; generatedAt: Date; importBatchId: string }): RollbackManifest {
  const entries = [...input.report.appliedSeries].sort((a, b) => a.seriesId.localeCompare(b.seriesId)).map((s) => toManifestEntry(s, input.importBatchId));
  return {
    batchId: input.batchId,
    generatedAt: input.generatedAt.toISOString(),
    targetUserId: input.report.targetUserId,
    entries,
    scopeNote: SCOPE_NOTE,
  };
}

// --- Eligibility ------------------------------------------------------------

export type RollbackRefusalReason = 'CREATED_EPISODE_HAS_BEEN_WATCHED' | 'PROGRESS_HAS_DRIFTED_SINCE_APPLY' | 'NO_REVERSIBLE_CHANGES';

export interface RollbackEligibility {
  seriesId: string;
  eligible: boolean;
  refusalReasons: RollbackRefusalReason[];
}

export interface EvaluateRollbackEligibilityInput {
  entry: RollbackManifestEntry;
  // Live-read at rollback-check time, not trusted from the manifest.
  currentUserStatus: string;
  currentNextEpisodeId: string | null;
  // Episode ids, among those created under this batch's importBatchId for
  // this series, that currently have at least one EpisodeWatch. Non-empty
  // means real user activity happened on a row this batch created — the
  // task's explicit "must not silently delete it" case.
  createdEpisodesWithWatches: string[];
}

export function evaluateRollbackEligibility(input: EvaluateRollbackEligibilityInput): RollbackEligibility {
  const refusalReasons: RollbackRefusalReason[] = [];

  if (input.createdEpisodesWithWatches.length > 0) {
    refusalReasons.push('CREATED_EPISODE_HAS_BEEN_WATCHED');
  }

  // Progress is only safe to restore if it's still exactly what THIS batch
  // set it to. Any drift (a later manual status change, or the user
  // watching further episodes and nextEpisodeId moving on) means blindly
  // restoring the prior value would discard real, newer activity.
  const progressDrifted = input.currentUserStatus !== input.entry.appliedUserStatus || input.currentNextEpisodeId !== input.entry.appliedNextEpisodeId;
  if (progressDrifted) {
    refusalReasons.push('PROGRESS_HAS_DRIFTED_SINCE_APPLY');
  }

  if (!input.entry.hasReversibleChanges) {
    refusalReasons.push('NO_REVERSIBLE_CHANGES');
  }

  return { seriesId: input.entry.seriesId, eligible: refusalReasons.length === 0, refusalReasons };
}

// --- Preview (dry-run only — no delete, ever, from this module) ------------

export interface RollbackPreviewEntry {
  seriesId: string;
  title: string;
  eligible: boolean;
  refusalReasons: RollbackRefusalReason[];
  wouldDeleteEpisodeCount: number;
  wouldDeleteSeasonNumbers: number[];
  wouldRestoreUserStatus: string | null;
  wouldRestoreNextEpisodeId: string | null;
}

export function buildRollbackPreviewEntry(entry: RollbackManifestEntry, eligibility: RollbackEligibility): RollbackPreviewEntry {
  return {
    seriesId: entry.seriesId,
    title: entry.title,
    eligible: eligibility.eligible,
    refusalReasons: eligibility.refusalReasons,
    wouldDeleteEpisodeCount: eligibility.eligible ? entry.createdEpisodeCount : 0,
    wouldDeleteSeasonNumbers: eligibility.eligible ? entry.createdSeasonNumbers : [],
    wouldRestoreUserStatus: eligibility.eligible ? entry.priorUserStatus : null,
    wouldRestoreNextEpisodeId: eligibility.eligible ? entry.priorNextEpisodeId : null,
  };
}
