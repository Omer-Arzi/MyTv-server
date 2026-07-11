// Pure decision logic for Phase 1 apply's write-time safety gates — no I/O.
// Split out from run-apply-refresh.ts/apply-refresh-transaction.ts for the
// same reason build-episode-insert-plan.ts is: these are the safety-critical
// decisions, unit-testable without a database, same pattern as
// tmdb-enrichment/apply-plan-writes.ts's decideUserStatusUpdate.

import { UserSeriesStatus } from '@prisma/client';
import { TRACKED_USER_STATUSES } from './refresh-logic';

export interface LiveWriteEligibilityCheck {
  eligible: boolean;
  reason: string | null;
}

// The gate that must run BEFORE any Season/Episode write, not only before
// the progress recompute — the candidate list a run works from is only a
// snapshot read once at the very start, and for a large library a full
// sequential run can take long enough that a live user action (dropping
// the series, removing it from tracking entirely) between then and this
// specific series' transaction is a real possibility, not a theoretical
// one. Reuses refresh-logic.ts's TRACKED_USER_STATUSES directly (rather
// than maintaining a second list) so candidate-selection-time and
// write-time eligibility can never silently drift apart.
export function checkLiveWriteEligibility(liveProgress: { userStatus: UserSeriesStatus } | null): LiveWriteEligibilityCheck {
  if (!liveProgress) {
    return { eligible: false, reason: 'no UserSeriesProgress row found for this user/series at write time — skipped without writing anything' };
  }
  if (!TRACKED_USER_STATUSES.includes(liveProgress.userStatus)) {
    return {
      eligible: false,
      reason: `live userStatus is ${liveProgress.userStatus} — no longer eligible (raced since candidate selection) — skipped without writing anything`,
    };
  }
  return { eligible: true, reason: null };
}

export interface ProgressRecomputeDecision {
  shouldRecompute: boolean;
  reason: string;
}

// The gate that makes "never move COMPLETED back to WATCHING merely
// because releaseStatus changed" true by construction: this is only ever
// called when insertedEpisodeCount > 0 (an actual, committed Episode
// insert), never from a releaseStatus/field diff alone — apply-refresh-transaction.ts
// never calls this function at all for a series where nothing was
// inserted. The live-status check here is redundant with
// checkLiveWriteEligibility's gate at the top of the same transaction in
// normal operation (both read the same already-validated liveUserStatus),
// but kept as an independent, still-correct safety net in its own right
// rather than assumed away — this function's contract should hold
// regardless of what already ran before it in a given caller.
export function decideProgressRecompute(insertedEpisodeCount: number, liveUserStatus: UserSeriesStatus): ProgressRecomputeDecision {
  if (insertedEpisodeCount === 0) {
    return { shouldRecompute: false, reason: 'no episodes were actually inserted — nothing to recompute progress for' };
  }
  if (!TRACKED_USER_STATUSES.includes(liveUserStatus)) {
    return {
      shouldRecompute: false,
      reason: `live userStatus is ${liveUserStatus} (not tracked) — a race changed it since eligibility was checked; episodes were still inserted, but progress is left untouched`,
    };
  }
  return {
    shouldRecompute: true,
    reason: `${insertedEpisodeCount} episode(s) inserted and live userStatus (${liveUserStatus}) is still tracked — recomputing nextEpisodeId/userStatus`,
  };
}
