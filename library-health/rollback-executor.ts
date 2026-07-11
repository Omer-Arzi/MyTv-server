// Gated rollback executor — Phase 8. Not invoked by any run-*.ts script in
// this task (wiring a real rollback CLI command is Phase 11 rollout work).
// Exists so the refusal rules are real, tested code rather than a promise:
// executeRollback THROWS instead of writing anything when eligibility says
// no, and re-verifies the two live conditions itself (defense in depth —
// never trusts a caller-supplied eligibility result blindly).

import { Prisma } from '@prisma/client';
import { RollbackManifestEntry, RollbackEligibility } from './rollback-logic';

export class RollbackRefusedError extends Error {
  constructor(seriesId: string, reasons: string[]) {
    super(`Refusing to roll back series ${seriesId}: ${reasons.join(', ')}`);
    this.name = 'RollbackRefusedError';
  }
}

export interface RollbackExecutionResult {
  seriesId: string;
  episodesDeleted: number;
  seasonsDeleted: number;
  progressRestored: boolean;
}

// Runs inside a caller-supplied transaction (same one-series-per-transaction
// convention as run-provider-confirmation-pipeline.ts's apply step) so a
// refusal or failure on one series never touches any other.
export async function executeRollback(tx: Prisma.TransactionClient, userId: string, entry: RollbackManifestEntry, eligibility: RollbackEligibility): Promise<RollbackExecutionResult> {
  if (!eligibility.eligible) {
    throw new RollbackRefusedError(entry.seriesId, eligibility.refusalReasons);
  }

  // Re-verify live, inside the transaction — the eligibility check the
  // caller passed in may have been computed moments earlier; re-reading
  // here closes the gap between "checked eligible" and "about to delete."
  const createdEpisodes = await tx.episode.findMany({
    where: { importBatchId: entry.importBatchId, season: { seriesId: entry.seriesId } },
    select: { id: true },
  });
  const createdEpisodeIds = createdEpisodes.map((e) => e.id);
  if (createdEpisodeIds.length > 0) {
    const liveWatches = await tx.episodeWatch.count({ where: { episodeId: { in: createdEpisodeIds } } });
    if (liveWatches > 0) {
      throw new RollbackRefusedError(entry.seriesId, ['CREATED_EPISODE_HAS_BEEN_WATCHED (live re-check)']);
    }
  }

  const liveProgress = await tx.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId, seriesId: entry.seriesId } } });
  const liveStatus = liveProgress?.userStatus ?? 'UNKNOWN';
  const liveNextEpisodeId = liveProgress?.nextEpisodeId ?? null;
  if (liveStatus !== entry.appliedUserStatus || liveNextEpisodeId !== entry.appliedNextEpisodeId) {
    throw new RollbackRefusedError(entry.seriesId, ['PROGRESS_HAS_DRIFTED_SINCE_APPLY (live re-check)']);
  }

  // Delete only rows this batch created, never anything pre-existing —
  // matches the CATALOG_RECONCILIATION_IMPORT_BATCH_ID provenance marker
  // exactly, same identification mechanism verification-logic.ts uses.
  const episodesDeleted = createdEpisodeIds.length > 0 ? (await tx.episode.deleteMany({ where: { id: { in: createdEpisodeIds } } })).count : 0;
  const seasonsDeleted = (await tx.season.deleteMany({ where: { seriesId: entry.seriesId, importBatchId: entry.importBatchId } })).count;

  let progressRestored = false;
  if (entry.priorUserStatus !== entry.appliedUserStatus || entry.priorNextEpisodeId !== entry.appliedNextEpisodeId) {
    await tx.userSeriesProgress.update({
      where: { userId_seriesId: { userId, seriesId: entry.seriesId } },
      data: { userStatus: entry.priorUserStatus as Prisma.UserSeriesProgressUpdateInput['userStatus'], nextEpisodeId: entry.priorNextEpisodeId },
    });
    progressRestored = true;
  }

  return { seriesId: entry.seriesId, episodesDeleted, seasonsDeleted, progressRestored };
}
