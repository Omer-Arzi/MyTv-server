import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { computeSyncStatusUpdate } from '../sync-status-update-logic';
import { computeNextEligibleRefreshAt } from '../sync-frequency-policy';

const now = new Date('2026-07-12T12:00:00Z');
const HOUR_MS = 60 * 60 * 1000;
// See sync-frequency-policy.test.ts's noNearEpisode — same fixed, stable
// urgency, isolating the mechanics this file actually owns.
const noNearEpisode = { releaseStatus: ReleaseStatus.ENDED, nextKnownUpcomingAirDate: null };

describe('computeSyncStatusUpdate', () => {
  it('on success: sets SUCCESS, clears error, resets failures, bumps lastSuccessfulRefreshAt to now', () => {
    const result = computeSyncStatusUpdate({
      status: UserSeriesStatus.WATCHING,
      outcome: { kind: 'success' },
      previousNumberOfFailures: 2,
      previousLastSuccessfulRefreshAt: new Date(now.getTime() - HOUR_MS),
      durationMs: 500,
      ...noNearEpisode,
      now,
    });

    expect(result.lastEpisodeRefreshStatus).toBe('SUCCESS');
    expect(result.lastEpisodeRefreshError).toBeNull();
    expect(result.numberOfFailures).toBe(0);
    expect(result.lastSuccessfulRefreshAt).toEqual(now);
    expect(result.lastProviderCheckAt).toEqual(now);
    expect(result.lastSyncDurationMs).toBe(500);
    expect(result.nextEligibleRefreshAt).toEqual(computeNextEligibleRefreshAt({ status: UserSeriesStatus.WATCHING, outcome: 'success', numberOfFailuresAfterThisAttempt: 0, ...noNearEpisode, now }));
  });

  it('on blocked-manual-review: distinct status label, but treated like success for backoff purposes (resets failures, normal interval)', () => {
    const result = computeSyncStatusUpdate({
      status: UserSeriesStatus.WATCHING,
      outcome: { kind: 'blocked-manual-review' },
      previousNumberOfFailures: 3,
      previousLastSuccessfulRefreshAt: null,
      durationMs: 200,
      ...noNearEpisode,
      now,
    });

    expect(result.lastEpisodeRefreshStatus).toBe('BLOCKED_MANUAL_REVIEW');
    expect(result.lastEpisodeRefreshError).toBeNull();
    expect(result.numberOfFailures).toBe(0);
    expect(result.lastSuccessfulRefreshAt).toEqual(now);
    expect(result.nextEligibleRefreshAt).toEqual(computeNextEligibleRefreshAt({ status: UserSeriesStatus.WATCHING, outcome: 'success', numberOfFailuresAfterThisAttempt: 0, ...noNearEpisode, now }));
  });

  it('on failure: sets FAILURE, records the error, increments numberOfFailures, applies backoff, leaves lastSuccessfulRefreshAt untouched', () => {
    const previousSuccess = new Date(now.getTime() - 3 * HOUR_MS);
    const result = computeSyncStatusUpdate({
      status: UserSeriesStatus.WATCHING,
      outcome: { kind: 'failure', errorMessage: 'TMDb 500' },
      previousNumberOfFailures: 1,
      previousLastSuccessfulRefreshAt: previousSuccess,
      durationMs: 100,
      ...noNearEpisode,
      now,
    });

    expect(result.lastEpisodeRefreshStatus).toBe('FAILURE');
    expect(result.lastEpisodeRefreshError).toBe('TMDb 500');
    expect(result.numberOfFailures).toBe(2);
    expect(result.lastSuccessfulRefreshAt).toEqual(previousSuccess); // untouched
    expect(result.nextEligibleRefreshAt).toEqual(computeNextEligibleRefreshAt({ status: UserSeriesStatus.WATCHING, outcome: 'failure', numberOfFailuresAfterThisAttempt: 2, ...noNearEpisode, now }));
  });

  it('a failure after zero prior failures starts the count at 1', () => {
    const result = computeSyncStatusUpdate({
      status: UserSeriesStatus.CAUGHT_UP,
      outcome: { kind: 'failure', errorMessage: 'network error' },
      previousNumberOfFailures: 0,
      previousLastSuccessfulRefreshAt: null,
      durationMs: 50,
      ...noNearEpisode,
      now,
    });
    expect(result.numberOfFailures).toBe(1);
  });

  it('always updates lastEpisodeRefreshAt and lastProviderCheckAt to now, regardless of outcome', () => {
    for (const outcome of [{ kind: 'success' as const }, { kind: 'blocked-manual-review' as const }, { kind: 'failure' as const, errorMessage: 'x' }]) {
      const result = computeSyncStatusUpdate({ status: UserSeriesStatus.DROPPED, outcome, previousNumberOfFailures: 0, previousLastSuccessfulRefreshAt: null, durationMs: 1, ...noNearEpisode, now });
      expect(result.lastEpisodeRefreshAt).toEqual(now);
      expect(result.lastProviderCheckAt).toEqual(now);
    }
  });
});
