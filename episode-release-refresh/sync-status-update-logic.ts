// Pure decision logic for what to write to SeriesSyncStatus after one
// refreshOneSeries attempt — no I/O, no Prisma. Kept separate from the
// scheduler service itself (src/modules/sync-scheduler) so this can be
// unit-tested without a database or a mocked provider client, same
// separation-of-concerns convention as every other *-logic.ts file in this
// project.

import { UserSeriesStatus } from '@prisma/client';
import { computeNextEligibleRefreshAt } from './sync-frequency-policy';

// A genuine provider/write failure is the only outcome that should back
// off future attempts — a safety-blocked classification (season shift,
// suspicious bulk insert, etc.) means the provider call itself succeeded
// and this system correctly declined to act on it. That's not a failure of
// THIS system, so it must not accumulate failure count or trigger backoff
// — the series stays on its normal per-status interval, just flagged with
// a distinct status for visibility (Part 5/6 of the scheduler-architecture
// task: manual review protection + sync metadata).
export type SyncAttemptOutcome = { kind: 'success' } | { kind: 'blocked-manual-review' } | { kind: 'failure'; errorMessage: string };

export interface ComputeSyncStatusUpdateInput {
  status: UserSeriesStatus;
  outcome: SyncAttemptOutcome;
  previousNumberOfFailures: number;
  previousLastSuccessfulRefreshAt: Date | null;
  durationMs: number;
  now: Date;
}

export interface SyncStatusUpdate {
  lastEpisodeRefreshAt: Date;
  lastEpisodeRefreshStatus: 'SUCCESS' | 'FAILURE' | 'BLOCKED_MANUAL_REVIEW';
  lastEpisodeRefreshError: string | null;
  lastSuccessfulRefreshAt: Date | null;
  lastProviderCheckAt: Date;
  numberOfFailures: number;
  lastSyncDurationMs: number;
  nextEligibleRefreshAt: Date | null;
}

export function computeSyncStatusUpdate(input: ComputeSyncStatusUpdateInput): SyncStatusUpdate {
  const { status, outcome, previousNumberOfFailures, previousLastSuccessfulRefreshAt, durationMs, now } = input;

  if (outcome.kind === 'failure') {
    const numberOfFailures = previousNumberOfFailures + 1;
    return {
      lastEpisodeRefreshAt: now,
      lastEpisodeRefreshStatus: 'FAILURE',
      lastEpisodeRefreshError: outcome.errorMessage,
      // Left exactly as it was — a failed attempt never counts as a
      // success, but it also must never erase the record of the last time
      // this series' catalog genuinely WAS refreshed successfully.
      lastSuccessfulRefreshAt: previousLastSuccessfulRefreshAt,
      lastProviderCheckAt: now,
      numberOfFailures,
      lastSyncDurationMs: durationMs,
      nextEligibleRefreshAt: computeNextEligibleRefreshAt({ status, outcome: 'failure', numberOfFailuresAfterThisAttempt: numberOfFailures, now }),
    };
  }

  return {
    lastEpisodeRefreshAt: now,
    lastEpisodeRefreshStatus: outcome.kind === 'success' ? 'SUCCESS' : 'BLOCKED_MANUAL_REVIEW',
    lastEpisodeRefreshError: null,
    lastSuccessfulRefreshAt: now,
    lastProviderCheckAt: now,
    numberOfFailures: 0,
    lastSyncDurationMs: durationMs,
    nextEligibleRefreshAt: computeNextEligibleRefreshAt({ status, outcome: 'success', numberOfFailuresAfterThisAttempt: 0, now }),
  };
}
