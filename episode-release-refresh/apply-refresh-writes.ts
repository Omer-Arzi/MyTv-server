// Pure decision logic for Phase 1 apply's write-time safety gates — no I/O.
// Split out from run-apply-refresh.ts/apply-refresh-transaction.ts for the
// same reason build-episode-insert-plan.ts is: these are the safety-critical
// decisions, unit-testable without a database, same pattern as
// tmdb-enrichment/apply-plan-writes.ts's decideUserStatusUpdate.

import { UserSeriesStatus } from '@prisma/client';
import { isCatalogEligibleStatus, TRACKED_USER_STATUSES } from './refresh-logic';

export interface LiveWriteEligibilityCheck {
  eligible: boolean;
  reason: string | null;
}

// The gate that must run BEFORE any Season/Episode write, not only before
// the progress recompute — the candidate list a run works from is only a
// snapshot read once at the very start, and for a large library a full
// sequential run can take long enough that a live user action (removing the
// series from tracking entirely) between then and this specific series'
// transaction is a real possibility, not a theoretical one. This is now a
// pure CATALOG-write gate: it only re-checks that a UserSeriesProgress row
// still exists and that the live status is still catalog-eligible
// (isCatalogEligibleStatus — i.e. not UNKNOWN), reusing refresh-logic.ts's
// exact same check candidate-selection used, so the two can never silently
// drift apart. It deliberately no longer checks TRACKED_USER_STATUSES —
// that's decideProgressRecompute's job below, which independently gates
// only the nextEpisodeId/userStatus write, not the Season/Episode insert.
// A WATCHLIST/PAUSED/DROPPED series' episodes are still inserted here.
export function checkLiveWriteEligibility(liveProgress: { userStatus: UserSeriesStatus } | null): LiveWriteEligibilityCheck {
  if (!liveProgress) {
    return { eligible: false, reason: 'no UserSeriesProgress row found for this user/series at write time — skipped without writing anything' };
  }
  if (!isCatalogEligibleStatus(liveProgress.userStatus)) {
    return {
      eligible: false,
      reason: `live userStatus is ${liveProgress.userStatus} — no longer catalog-eligible (raced since candidate selection) — skipped without writing anything`,
    };
  }
  return { eligible: true, reason: null };
}

export interface ProgressRecomputeDecision {
  shouldRecompute: boolean;
  reason: string;
}

// The gate that makes "never move COMPLETED back to WATCHING merely
// because releaseStatus changed" true by construction, AND the one place
// (along with reconcileSeriesProgress's own copy) that still enforces the
// catalog-freshness / status-logic separation: a WATCHLIST/PAUSED/DROPPED
// series can and does reach this function with insertedEpisodeCount > 0
// (checkLiveWriteEligibility above no longer excludes those statuses from
// the insert itself) — this is the check that stops the insert from also
// silently changing nextEpisodeId/userStatus for a series the user isn't
// actively tracking progress on. Only ever called when
// insertedEpisodeCount > 0 (an actual, committed Episode insert), never
// from a releaseStatus/field diff alone — apply-refresh-transaction.ts
// never calls this function at all for a series where nothing was
// inserted.
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
