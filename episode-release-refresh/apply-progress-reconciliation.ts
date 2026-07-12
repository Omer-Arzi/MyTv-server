// The write path for progress-only reconciliation — the fix for
// docs/progress-reconciliation-architecture-todo.md's confirmed bug: a
// series whose local catalog already has every episode the provider has
// (nothing to insert) can still need UserSeriesProgress recomputed, purely
// because time passed and an already-local future episode became released.
//
// Deliberately separate from applySeriesInsertPlan (apply-refresh-transaction.ts)
// rather than folded into it — this function NEVER touches Season/Episode,
// only ever UserSeriesProgress, and is meant to be callable independently
// of any catalog-insert decision (see run-apply-refresh.ts and
// run-progress-reconciliation.ts, its two callers). Mirrors
// applySeriesInsertPlan's existing conventions exactly: one transaction,
// everything read live inside it (never trusts a pre-transaction candidate
// snapshot), same result shape, so callers don't need to special-case which
// path produced a given report entry.

import { PrismaClient } from '@prisma/client';
import { OrderedEpisodeForNextLookup } from '../src/modules/series/series-query-helpers';
import { hasProgressChanged, reconcileSeriesProgress } from './progress-reconciliation-logic';
import { ApplyProgressChange } from './apply-refresh-transaction';

export interface ApplyProgressReconciliationInput {
  userId: string;
  seriesId: string;
}

export interface ApplyProgressReconciliationResult {
  progressRecomputed: boolean;
  progressChange: ApplyProgressChange | null;
  // Populated when a progress row was found and live-eligible but no write
  // was needed (protected, not tracked, or computed already matches
  // stored) — mutually exclusive with progressChange being non-null.
  progressSkippedReason: string | null;
  // Populated when nothing was even attempted (no progress row at all).
  writeSkippedReason: string | null;
}

// Never call this speculatively for every series in the library inside a
// hot loop without first checking (via the same reconcileSeriesProgress
// logic, read-only) that there's actually a reasonable chance of a change —
// callers (run-apply-refresh.ts, run-progress-reconciliation.ts) already do
// a dry-run compute first and only call this when apply mode is on AND a
// mismatch was found, so this function itself doesn't re-decide "should I
// even bother," only "given that we're here, is the live state still
// eligible and does it still need a write."
export async function applyProgressReconciliation(prisma: PrismaClient, input: ApplyProgressReconciliationInput): Promise<ApplyProgressReconciliationResult> {
  return prisma.$transaction(async (tx) => {
    const liveProgress = await tx.userSeriesProgress.findUnique({
      where: { userId_seriesId: { userId: input.userId, seriesId: input.seriesId } },
    });
    if (!liveProgress) {
      return {
        progressRecomputed: false,
        progressChange: null,
        progressSkippedReason: null,
        writeSkippedReason: 'no UserSeriesProgress row found for this user/series at write time — skipped without writing anything',
      };
    }

    const liveSeries = await tx.series.findUnique({ where: { id: input.seriesId }, select: { releaseStatus: true } });
    if (!liveSeries) {
      // Defensive only — Series -> UserSeriesProgress cascades on delete
      // (schema.prisma), and liveProgress was just confirmed non-null
      // above in this same transaction, so this should not be reachable
      // today. Same posture as apply-refresh-transaction.ts's identical
      // defensive check.
      return {
        progressRecomputed: false,
        progressChange: null,
        progressSkippedReason: null,
        writeSkippedReason: 'series row not found at reconciliation time — progress left untouched',
      };
    }

    const episodes = await tx.episode.findMany({
      where: { season: { seriesId: input.seriesId } },
      select: { id: true, episodeNumber: true, airDate: true, season: { select: { seasonNumber: true } } },
    });
    episodes.sort((a, b) => a.season.seasonNumber - b.season.seasonNumber || a.episodeNumber - b.episodeNumber);
    const orderedEpisodes: OrderedEpisodeForNextLookup[] = episodes.map((e) => ({ id: e.id, airDate: e.airDate, seasonNumber: e.season.seasonNumber }));

    const watches = await tx.episodeWatch.findMany({
      where: { userId: input.userId, episode: { season: { seriesId: input.seriesId } } },
      select: { episodeId: true },
    });
    const watchedEpisodeIds = new Set(watches.map((w) => w.episodeId));

    const outcome = reconcileSeriesProgress({
      currentUserStatus: liveProgress.userStatus,
      currentNextEpisodeId: liveProgress.nextEpisodeId,
      orderedEpisodes,
      watchedEpisodeIds,
      releaseStatus: liveSeries.releaseStatus,
    });

    if (outcome.kind === 'protected' || outcome.kind === 'not-tracked') {
      return { progressRecomputed: false, progressChange: null, progressSkippedReason: outcome.reason, writeSkippedReason: null };
    }

    if (outcome.kind === 'unchanged') {
      return {
        progressRecomputed: false,
        progressChange: null,
        progressSkippedReason: 'computed progress already matches stored progress — no write needed',
        writeSkippedReason: null,
      };
    }

    // outcome.kind === 'changed'. Re-verify with the shared comparison
    // helper against the LIVE values read in this transaction (not
    // whatever a caller's earlier dry-run snapshot said) before writing —
    // belt-and-suspenders against a race between this function being
    // called and the transaction actually starting.
    const from = { userStatus: liveProgress.userStatus, nextEpisodeId: liveProgress.nextEpisodeId };
    if (!hasProgressChanged(from, outcome.to)) {
      return {
        progressRecomputed: false,
        progressChange: null,
        progressSkippedReason: 'computed progress already matches stored progress — no write needed',
        writeSkippedReason: null,
      };
    }

    await tx.userSeriesProgress.update({
      where: { userId_seriesId: { userId: input.userId, seriesId: input.seriesId } },
      data: { userStatus: outcome.to.userStatus, nextEpisodeId: outcome.to.nextEpisodeId },
    });

    const progressChange: ApplyProgressChange = {
      userStatusFrom: from.userStatus,
      userStatusTo: outcome.to.userStatus,
      nextEpisodeIdFrom: from.nextEpisodeId,
      nextEpisodeIdTo: outcome.to.nextEpisodeId,
    };

    return { progressRecomputed: true, progressChange, progressSkippedReason: null, writeSkippedReason: null };
  });
}
