import { UserSeriesStatus } from '@prisma/client';
import { computeFailureBackoffMs, computeNextEligibleRefreshAt, getRefreshIntervalMs, isRefreshDue } from '../sync-frequency-policy';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('getRefreshIntervalMs', () => {
  it.each([
    [UserSeriesStatus.WATCHING, 8 * HOUR_MS],
    [UserSeriesStatus.CAUGHT_UP, 1 * DAY_MS],
    [UserSeriesStatus.WATCHLIST, 7 * DAY_MS],
    [UserSeriesStatus.PAUSED, 30 * DAY_MS],
    [UserSeriesStatus.COMPLETED, 30 * DAY_MS],
    [UserSeriesStatus.DROPPED, 60 * DAY_MS],
  ])('returns the policy interval for %s', (status, expected) => {
    expect(getRefreshIntervalMs(status)).toBe(expected);
  });

  it('returns null for UNKNOWN — never scheduled', () => {
    expect(getRefreshIntervalMs(UserSeriesStatus.UNKNOWN)).toBeNull();
  });
});

describe('isRefreshDue', () => {
  const now = new Date('2026-07-12T12:00:00Z');

  it('is always due when never synced (nextEligibleRefreshAt is null)', () => {
    expect(isRefreshDue({ status: UserSeriesStatus.WATCHLIST, nextEligibleRefreshAt: null, now })).toBe(true);
  });

  it('is not due when nextEligibleRefreshAt is in the future', () => {
    const future = new Date(now.getTime() + HOUR_MS);
    expect(isRefreshDue({ status: UserSeriesStatus.WATCHING, nextEligibleRefreshAt: future, now })).toBe(false);
  });

  it('is due when nextEligibleRefreshAt is exactly now', () => {
    expect(isRefreshDue({ status: UserSeriesStatus.WATCHING, nextEligibleRefreshAt: now, now })).toBe(true);
  });

  it('is due when nextEligibleRefreshAt is in the past', () => {
    const past = new Date(now.getTime() - HOUR_MS);
    expect(isRefreshDue({ status: UserSeriesStatus.CAUGHT_UP, nextEligibleRefreshAt: past, now })).toBe(true);
  });

  it('is never due for UNKNOWN, even with a null nextEligibleRefreshAt', () => {
    expect(isRefreshDue({ status: UserSeriesStatus.UNKNOWN, nextEligibleRefreshAt: null, now })).toBe(false);
  });
});

describe('computeFailureBackoffMs', () => {
  it('returns 0 for zero or negative failure counts', () => {
    expect(computeFailureBackoffMs(0)).toBe(0);
    expect(computeFailureBackoffMs(-1)).toBe(0);
  });

  it('doubles per additional consecutive failure', () => {
    const first = computeFailureBackoffMs(1);
    const second = computeFailureBackoffMs(2);
    const third = computeFailureBackoffMs(3);
    expect(second).toBe(first * 2);
    expect(third).toBe(first * 4);
  });

  it('caps at 24 hours no matter how many consecutive failures', () => {
    expect(computeFailureBackoffMs(100)).toBe(DAY_MS);
  });
});

describe('computeNextEligibleRefreshAt', () => {
  const now = new Date('2026-07-12T12:00:00Z');

  it('on success, adds the status interval to now, ignoring any failure count', () => {
    const result = computeNextEligibleRefreshAt({ status: UserSeriesStatus.CAUGHT_UP, outcome: 'success', numberOfFailuresAfterThisAttempt: 0, now });
    expect(result).toEqual(new Date(now.getTime() + DAY_MS));
  });

  it('on failure, adds the exponential backoff to now, independent of the status interval', () => {
    const result = computeNextEligibleRefreshAt({ status: UserSeriesStatus.WATCHING, outcome: 'failure', numberOfFailuresAfterThisAttempt: 1, now });
    expect(result).toEqual(new Date(now.getTime() + computeFailureBackoffMs(1)));
  });

  it('a failing WATCHING series is retried sooner than its normal 8h interval would suggest', () => {
    const result = computeNextEligibleRefreshAt({ status: UserSeriesStatus.WATCHING, outcome: 'failure', numberOfFailuresAfterThisAttempt: 1, now });
    expect(result!.getTime() - now.getTime()).toBeLessThan(8 * HOUR_MS);
  });

  it('returns null for UNKNOWN even on a reported success — defensive, should never actually be called this way', () => {
    const result = computeNextEligibleRefreshAt({ status: UserSeriesStatus.UNKNOWN, outcome: 'success', numberOfFailuresAfterThisAttempt: 0, now });
    expect(result).toBeNull();
  });
});
