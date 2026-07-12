// Gated rollback executor for a single MigrationHistory row — the real,
// transactional counterpart to migration-rollback-logic.ts's pure
// eligibility check. Same defense-in-depth posture as the existing
// rollback-executor.ts: re-verifies both live safety conditions itself
// inside the transaction rather than trusting a caller-supplied
// eligibility result, and throws instead of writing anything when either
// check fails.

import { MigrationHistory, Prisma, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { evaluateMigrationRollbackEligibility, MigrationRollbackEligibility } from './migration-rollback-logic';

export class MigrationRollbackRefusedError extends Error {
  constructor(
    migrationId: string,
    public readonly reasons: string[],
  ) {
    super(`Refusing to roll back migration ${migrationId}: ${reasons.join(', ')}`);
    this.name = 'MigrationRollbackRefusedError';
  }
}

export interface MigrationRollbackExecutionResult {
  migrationId: string;
  episodesDeleted: number;
  providerRestored: boolean;
  progressRestored: boolean;
}

// Runs inside a caller-supplied transaction so a refusal or failure never
// partially applies. Order matters for safety, not just style: progress is
// restored to its "before" value BEFORE any episode is deleted, so a
// currently-live nextEpisodeId can never still point at a row this
// function is about to remove (see migration-rollback-logic.ts header for
// why the OLD batch-scoped executor didn't need this — it never restored
// progress and deletion in the same call path this precisely).
export async function executeMigrationRollback(tx: Prisma.TransactionClient, userId: string, history: MigrationHistory): Promise<MigrationRollbackExecutionResult> {
  const episodesInsertedIds = history.episodesInsertedIds as string[];

  const watchedInsertedEpisodeIds =
    episodesInsertedIds.length > 0
      ? (await tx.episodeWatch.findMany({ where: { episodeId: { in: episodesInsertedIds } }, select: { episodeId: true } })).map((w) => w.episodeId)
      : [];

  const liveProgress = await tx.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId, seriesId: history.seriesId } } });
  const currentUserStatus = liveProgress?.userStatus ?? UserSeriesStatus.UNKNOWN;
  const currentNextEpisodeId = liveProgress?.nextEpisodeId ?? null;

  const eligibility: MigrationRollbackEligibility = evaluateMigrationRollbackEligibility({
    alreadyRolledBack: history.rolledBackAt !== null,
    episodesInsertedIds,
    watchedInsertedEpisodeIds,
    currentUserStatus,
    currentNextEpisodeId,
    userStatusAfter: history.userStatusAfter,
    nextEpisodeIdAfter: history.nextEpisodeIdAfter,
    userStatusBefore: history.userStatusBefore,
    nextEpisodeIdBefore: history.nextEpisodeIdBefore,
  });

  if (!eligibility.eligible) {
    throw new MigrationRollbackRefusedError(history.id, eligibility.refusalReasons);
  }

  // 1. Restore progress FIRST — never leaves a live nextEpisodeId dangling
  // on a row about to be deleted (see header comment).
  let progressRestored = false;
  if (currentUserStatus !== history.userStatusBefore || currentNextEpisodeId !== history.nextEpisodeIdBefore) {
    await tx.userSeriesProgress.upsert({
      where: { userId_seriesId: { userId, seriesId: history.seriesId } },
      create: { userId, seriesId: history.seriesId, userStatus: history.userStatusBefore as UserSeriesStatus, nextEpisodeId: history.nextEpisodeIdBefore },
      update: { userStatus: history.userStatusBefore as UserSeriesStatus, nextEpisodeId: history.nextEpisodeIdBefore },
    });
    progressRestored = true;
  }

  // 2. Delete only the exact episodes THIS migration inserted, and only
  // now that nothing can still reference them.
  const episodesDeleted = episodesInsertedIds.length > 0 ? (await tx.episode.deleteMany({ where: { id: { in: episodesInsertedIds } } })).count : 0;

  // 3. Restore ExternalIds to the prior state — a null providerBefore
  // means no confirmed match existed before this migration, so rollback
  // deletes the row entirely rather than upserting a fabricated "empty"
  // one; a non-null providerBefore restores exactly those field values.
  const providerBefore = history.providerBefore as { provider: string | null; providerId: string | null; tmdbId: string | null } | null;
  let providerRestored = false;
  if (providerBefore === null) {
    await tx.externalIds.deleteMany({ where: { seriesId: history.seriesId } });
    providerRestored = true;
  } else {
    await tx.externalIds.upsert({
      where: { seriesId: history.seriesId },
      create: { seriesId: history.seriesId, provider: providerBefore.provider, providerId: providerBefore.providerId, tmdbId: providerBefore.tmdbId },
      update: { provider: providerBefore.provider, providerId: providerBefore.providerId, tmdbId: providerBefore.tmdbId },
    });
    providerRestored = true;
  }

  // 4. Restore Series.releaseStatus if this migration changed it — mirrors
  // the same before/after restoration pattern as provider/progress above.
  // releaseStatusBefore is nullable (an ENUM column can't literally be
  // null in the DB, but the MigrationHistory snapshot type allows it for
  // older/edge-case rows) — only restore when we actually have a concrete
  // prior value to restore to.
  if (history.releaseStatusBefore !== null && history.releaseStatusBefore !== history.releaseStatusAfter) {
    await tx.series.update({ where: { id: history.seriesId }, data: { releaseStatus: history.releaseStatusBefore as ReleaseStatus } });
  }

  await tx.migrationHistory.update({ where: { id: history.id }, data: { rolledBackAt: new Date(), rollbackReason: 'Rolled back via Migration Workbench.' } });

  return { migrationId: history.id, episodesDeleted, providerRestored, progressRestored };
}
