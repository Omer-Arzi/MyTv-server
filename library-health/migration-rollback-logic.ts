// Pure rollback-eligibility/preview logic for a single MigrationHistory
// row (prisma/schema.prisma) — the Migration Workbench's rollback path.
// Same safety policy and refusal vocabulary as the existing batch-level
// rollback-logic.ts (never delete a watched episode, never restore
// progress that has since drifted), reused conceptually rather than
// imported directly: that module scopes deletions by
// CATALOG_RECONCILIATION_IMPORT_BATCH_ID, a single constant shared by
// EVERY migration ever run — safe for a one-time whole-batch rollback, but
// unsafe here, where the same series could have TWO separate
// MigrationHistory rows (migrated once, then migrated again later) sharing
// that same constant; rolling back the second could otherwise delete
// episodes the FIRST migration created. This module scopes deletion to the
// EXACT episode ids recorded on ONE MigrationHistory row instead, which is
// strictly more precise. See migration-rollback-executor.ts for the actual
// (transactional) delete/restore.

export type MigrationRollbackRefusalReason = 'ALREADY_ROLLED_BACK' | 'EPISODE_HAS_BEEN_WATCHED' | 'PROGRESS_HAS_DRIFTED_SINCE_MIGRATION' | 'NO_REVERSIBLE_CHANGES';

export interface MigrationRollbackEligibility {
  eligible: boolean;
  refusalReasons: MigrationRollbackRefusalReason[];
  // Human-readable, one sentence per refusal reason — surfaced verbatim by
  // the API/mobile UI ("explain why rollback is blocked").
  explanations: string[];
}

export interface EvaluateMigrationRollbackEligibilityInput {
  alreadyRolledBack: boolean;
  episodesInsertedIds: string[];
  // Live-read at check time — every id (among episodesInsertedIds) that
  // currently has at least one EpisodeWatch row. Real user activity on a
  // row this migration created must never be silently deleted.
  watchedInsertedEpisodeIds: string[];
  // Live-read UserSeriesProgress values, compared against this migration's
  // OWN recorded "after" values — any difference means something later
  // (another migration, a manual status change, further watching) has
  // already moved progress on, and blindly restoring the "before" value
  // would discard that newer, real activity.
  currentUserStatus: string;
  currentNextEpisodeId: string | null;
  userStatusAfter: string;
  nextEpisodeIdAfter: string | null;
  // This migration's own recorded before/after — used only to detect the
  // degenerate "nothing to undo" case (no episodes inserted, and progress
  // never actually changed).
  userStatusBefore: string;
  nextEpisodeIdBefore: string | null;
}

export function evaluateMigrationRollbackEligibility(input: EvaluateMigrationRollbackEligibilityInput): MigrationRollbackEligibility {
  const refusalReasons: MigrationRollbackRefusalReason[] = [];
  const explanations: string[] = [];

  if (input.alreadyRolledBack) {
    return { eligible: false, refusalReasons: ['ALREADY_ROLLED_BACK'], explanations: ['This migration has already been rolled back — rollback is not repeatable once it has succeeded.'] };
  }

  if (input.watchedInsertedEpisodeIds.length > 0) {
    refusalReasons.push('EPISODE_HAS_BEEN_WATCHED');
    explanations.push(
      `${input.watchedInsertedEpisodeIds.length} episode(s) this migration added have since been watched — removing them would delete real watch history, which rollback never does.`,
    );
  }

  const progressDrifted = input.currentUserStatus !== input.userStatusAfter || input.currentNextEpisodeId !== input.nextEpisodeIdAfter;
  if (progressDrifted) {
    refusalReasons.push('PROGRESS_HAS_DRIFTED_SINCE_MIGRATION');
    explanations.push('This series\' status has changed since the migration ran (a later migration, manual status change, or further watching) — restoring the prior status would discard that newer activity.');
  }

  const progressActuallyChanged = input.userStatusBefore !== input.userStatusAfter || input.nextEpisodeIdBefore !== input.nextEpisodeIdAfter;
  if (input.episodesInsertedIds.length === 0 && !progressActuallyChanged) {
    refusalReasons.push('NO_REVERSIBLE_CHANGES');
    explanations.push('This migration only confirmed the provider match — no episodes were added and no status change was made, so there is nothing to roll back.');
  }

  return { eligible: refusalReasons.length === 0, refusalReasons, explanations };
}

export interface MigrationRollbackPreviewProviderRef {
  provider: string | null;
  providerId: string | null;
  tmdbId: string | null;
}

export interface MigrationRollbackPreview {
  migrationId: string;
  eligible: boolean;
  refusalReasons: MigrationRollbackRefusalReason[];
  explanations: string[];
  wouldRestoreProvider: MigrationRollbackPreviewProviderRef | null;
  wouldRestoreUserStatus: string | null;
  wouldRestoreNextEpisodeId: string | null;
  wouldRemoveEpisodeCount: number;
  // Always true: rollback never touches EpisodeWatch rows under any
  // circumstance, whether eligible or not — a fixed, unconditional fact
  // about this tool, not something that depends on eligibility.
  watchHistoryPreserved: true;
}

export function buildMigrationRollbackPreview(input: {
  migrationId: string;
  eligibility: MigrationRollbackEligibility;
  providerBefore: MigrationRollbackPreviewProviderRef | null;
  userStatusBefore: string;
  nextEpisodeIdBefore: string | null;
  episodesInsertedIds: string[];
}): MigrationRollbackPreview {
  const { eligibility } = input;
  return {
    migrationId: input.migrationId,
    eligible: eligibility.eligible,
    refusalReasons: eligibility.refusalReasons,
    explanations: eligibility.explanations,
    wouldRestoreProvider: eligibility.eligible ? input.providerBefore : null,
    wouldRestoreUserStatus: eligibility.eligible ? input.userStatusBefore : null,
    wouldRestoreNextEpisodeId: eligibility.eligible ? input.nextEpisodeIdBefore : null,
    wouldRemoveEpisodeCount: eligibility.eligible ? input.episodesInsertedIds.length : 0,
    watchHistoryPreserved: true,
  };
}
