// Pure decision logic for the automatic sync scheduler's "when" question —
// no I/O, no Prisma, no TMDb. Deliberately separate from refresh-logic.ts's
// checkSeriesEligibility ("should this series' catalog ever be refreshed at
// all") — this file only ever answers "given that it's eligible, is right
// now the right time." See docs for the scheduler-architecture task: Part 2
// (refresh frequency by user status) and Part 7 (failure/retry handling).

import { UserSeriesStatus } from '@prisma/client';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// One interval per tracked status, chosen from the ranges given in the
// scheduler-architecture task. UNKNOWN is deliberately absent (not a `null`
// value keyed in the map) — see isCatalogEligibleStatus in refresh-logic.ts,
// which already excludes UNKNOWN from catalog eligibility entirely; a
// series with no meaningful status yet never reaches this policy table at
// all, so there's nothing to represent "UNKNOWN's interval" with.
const REFRESH_INTERVAL_MS: Partial<Record<UserSeriesStatus, number>> = {
  [UserSeriesStatus.WATCHING]: 8 * HOUR_MS,
  [UserSeriesStatus.CAUGHT_UP]: 1 * DAY_MS,
  [UserSeriesStatus.WATCHLIST]: 7 * DAY_MS,
  [UserSeriesStatus.PAUSED]: 30 * DAY_MS, // "ON_HOLD" in the task spec — PAUSED is this app's existing enum member for it.
  [UserSeriesStatus.COMPLETED]: 30 * DAY_MS,
  [UserSeriesStatus.DROPPED]: 60 * DAY_MS,
};

// Returns null for UNKNOWN (and, defensively, any future enum member this
// table hasn't been taught yet) — a null interval means "never scheduled",
// not "scheduled with a zero/default interval". Callers must treat null as
// excluded from the sync schedule entirely, same as a genuinely
// catalog-ineligible series.
export function getRefreshIntervalMs(status: UserSeriesStatus): number | null {
  return REFRESH_INTERVAL_MS[status] ?? null;
}

export interface RefreshDueInput {
  status: UserSeriesStatus;
  // Denormalized on SeriesSyncStatus, set after every prior attempt
  // (success or failure) by computeNextEligibleRefreshAt below. null means
  // "never synced" — always due.
  nextEligibleRefreshAt: Date | null;
  now?: Date;
}

// The scheduler's single due/not-due decision. Deliberately reads only
// nextEligibleRefreshAt (never re-derives "now - lastEpisodeRefreshAt >=
// interval(status)" itself) so there is exactly one place — this file's
// computeNextEligibleRefreshAt — that ever decides when a series becomes
// due again, whether that's a normal interval or a failure backoff.
export function isRefreshDue(input: RefreshDueInput): boolean {
  if (getRefreshIntervalMs(input.status) === null) return false; // UNKNOWN (or an untaught future status) is never on a schedule.
  if (input.nextEligibleRefreshAt === null) return true; // Never synced.
  const now = input.now ?? new Date();
  return now.getTime() >= input.nextEligibleRefreshAt.getTime();
}

// --- Failure backoff (Part 7) -----------------------------------------
//
// Exponential, capped, based on the CONSECUTIVE failure count after this
// attempt (1 = first failure). One failing series must never block others
// — this only ever changes when THIS series' next attempt is eligible, is
// computed synchronously with no retry loop of its own, and every call site
// wraps a single series in its own try/catch (see sync-scheduler.service.ts).
const BACKOFF_BASE_MS = 15 * 60 * 1000; // 15 minutes after the 1st failure.
const BACKOFF_MAX_MS = 1 * DAY_MS; // never wait longer than a day between retries, even after many failures.

export function computeFailureBackoffMs(numberOfFailures: number): number {
  if (numberOfFailures <= 0) return 0;
  const exponential = BACKOFF_BASE_MS * 2 ** (numberOfFailures - 1);
  return Math.min(exponential, BACKOFF_MAX_MS);
}

export interface ComputeNextEligibleRefreshAtInput {
  status: UserSeriesStatus;
  outcome: 'success' | 'failure';
  // Total consecutive failures INCLUDING this attempt (i.e. already
  // incremented by the caller before calling this on a failure outcome).
  numberOfFailuresAfterThisAttempt: number;
  now?: Date;
}

// Single place that decides the next SeriesSyncStatus.nextEligibleRefreshAt
// value, for both a successful attempt (normal per-status interval, reset
// as if failures never happened) and a failed one (exponential backoff,
// independent of the status interval — a failing WATCHING series is
// retried sooner than its normal 8h cadence would suggest, not later).
// Returns null only when the status isn't on a schedule at all (defensive
// — a caller should never invoke this for an UNKNOWN-status series, since
// checkSeriesEligibility/isRefreshDue already exclude it earlier).
export function computeNextEligibleRefreshAt(input: ComputeNextEligibleRefreshAtInput): Date | null {
  const now = input.now ?? new Date();
  if (input.outcome === 'success') {
    const interval = getRefreshIntervalMs(input.status);
    return interval === null ? null : new Date(now.getTime() + interval);
  }
  return new Date(now.getTime() + computeFailureBackoffMs(input.numberOfFailuresAfterThisAttempt));
}
