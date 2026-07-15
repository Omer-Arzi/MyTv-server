import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { computeSmartRefreshIntervalMs } from '../smart-scheduling-policy';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const now = new Date('2026-07-13T12:00:00Z');

function hoursFromNow(h: number): Date {
  return new Date(now.getTime() + h * HOUR_MS);
}

describe('computeSmartRefreshIntervalMs — WATCHING', () => {
  it('overdue known episode (already past its air date, still not present) -> ~1h', () => {
    const result = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.WATCHING, releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: hoursFromNow(-2), now });
    expect(result.intervalMs).toBe(1 * HOUR_MS);
    expect(result.urgency).toBe('OVERDUE_OR_DUE_TODAY');
  });

  it('known episode due exactly now -> ~1h (boundary is inclusive of "due")', () => {
    const result = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.WATCHING, releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: now, now });
    expect(result.intervalMs).toBe(1 * HOUR_MS);
  });

  it('known episode due within 48h -> ~2h', () => {
    const result = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.WATCHING, releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: hoursFromNow(30), now });
    expect(result.intervalMs).toBe(2 * HOUR_MS);
    expect(result.urgency).toBe('DUE_WITHIN_48H');
  });

  it('active season, no near episode known -> ~8h', () => {
    const result = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.WATCHING, releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: null, now });
    expect(result.intervalMs).toBe(8 * HOUR_MS);
    expect(result.urgency).toBe('ACTIVE_NO_NEAR_EPISODE');
  });

  it('no known active release window (ended, nothing known) -> 12-24h range', () => {
    const result = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.WATCHING, releaseStatus: ReleaseStatus.ENDED, nextKnownUpcomingAirDate: null, now });
    expect(result.intervalMs).toBeGreaterThanOrEqual(12 * HOUR_MS);
    expect(result.intervalMs).toBeLessThanOrEqual(24 * HOUR_MS);
    expect(result.urgency).toBe('BETWEEN_SEASONS_OR_UNKNOWN');
  });

  it('a known episode more than 48h away does not accelerate below the active-season interval', () => {
    const result = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.WATCHING, releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: hoursFromNow(72), now });
    expect(result.intervalMs).toBe(8 * HOUR_MS); // ACTIVE_NO_NEAR_EPISODE tier, not DUE_WITHIN_48H
  });
});

describe('computeSmartRefreshIntervalMs — CAUGHT_UP is never lower priority than WATCHING', () => {
  it('overdue/due-today -> ~1h, identical to WATCHING', () => {
    const watching = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.WATCHING, releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: hoursFromNow(-1), now });
    const caughtUp = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.CAUGHT_UP, releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: hoursFromNow(-1), now });
    expect(caughtUp.intervalMs).toBe(watching.intervalMs);
    expect(caughtUp.intervalMs).toBe(1 * HOUR_MS);
  });

  it('due within 48h -> ~2h, identical to WATCHING', () => {
    const caughtUp = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.CAUGHT_UP, releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: hoursFromNow(10), now });
    expect(caughtUp.intervalMs).toBe(2 * HOUR_MS);
  });

  it('currently airing, no near episode -> 6-8h range', () => {
    const result = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.CAUGHT_UP, releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: null, now });
    expect(result.intervalMs).toBeGreaterThanOrEqual(6 * HOUR_MS);
    expect(result.intervalMs).toBeLessThanOrEqual(8 * HOUR_MS);
  });

  it('between seasons -> ~24h', () => {
    const result = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.CAUGHT_UP, releaseStatus: ReleaseStatus.ENDED, nextKnownUpcomingAirDate: null, now });
    expect(result.intervalMs).toBe(24 * HOUR_MS);
  });

  it('CAUGHT_UP is never LESS frequent than WATCHING for the same urgency, across every tier', () => {
    const urgencyInputs: { releaseStatus: ReleaseStatus; nextKnownUpcomingAirDate: Date | null }[] = [
      { releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: hoursFromNow(-1) },
      { releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: hoursFromNow(10) },
      { releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: null },
      { releaseStatus: ReleaseStatus.ENDED, nextKnownUpcomingAirDate: null },
    ];
    for (const ctx of urgencyInputs) {
      const watching = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.WATCHING, ...ctx, now });
      const caughtUp = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.CAUGHT_UP, ...ctx, now });
      expect(caughtUp.intervalMs).toBeLessThanOrEqual(watching.intervalMs);
    }
  });
});

describe('computeSmartRefreshIntervalMs — PAUSED (ON_HOLD)', () => {
  it('active show -> 1-3 day range', () => {
    const result = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.PAUSED, releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: null, now });
    expect(result.intervalMs).toBeGreaterThanOrEqual(1 * DAY_MS);
    expect(result.intervalMs).toBeLessThanOrEqual(3 * DAY_MS);
  });

  it('between seasons -> ~weekly', () => {
    const result = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.PAUSED, releaseStatus: ReleaseStatus.ENDED, nextKnownUpcomingAirDate: null, now });
    expect(result.intervalMs).toBe(7 * DAY_MS);
  });
});

describe('computeSmartRefreshIntervalMs — DROPPED', () => {
  it('flat 2-4 week interval regardless of urgency or release status', () => {
    const a = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.DROPPED, releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: hoursFromNow(-5), now });
    const b = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.DROPPED, releaseStatus: ReleaseStatus.ENDED, nextKnownUpcomingAirDate: null, now });
    expect(a.intervalMs).toBe(b.intervalMs);
    expect(a.intervalMs).toBeGreaterThanOrEqual(14 * DAY_MS);
    expect(a.intervalMs).toBeLessThanOrEqual(28 * DAY_MS);
  });
});

describe('computeSmartRefreshIntervalMs — COMPLETED', () => {
  it('user completed but provider still airing -> treated like CAUGHT_UP (near-episode-aware)', () => {
    const completed = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.COMPLETED, releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: hoursFromNow(-1), now });
    const caughtUp = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.CAUGHT_UP, releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: hoursFromNow(-1), now });
    expect(completed.intervalMs).toBe(caughtUp.intervalMs);
  });

  it('provider show has officially ended -> very low frequency (30 days)', () => {
    const result = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.COMPLETED, releaseStatus: ReleaseStatus.ENDED, nextKnownUpcomingAirDate: null, now });
    expect(result.intervalMs).toBe(30 * DAY_MS);
  });

  it('provider show cancelled is treated the same as ended — low frequency', () => {
    const result = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.COMPLETED, releaseStatus: ReleaseStatus.CANCELLED, nextKnownUpcomingAirDate: null, now });
    expect(result.intervalMs).toBe(30 * DAY_MS);
  });
});

describe('computeSmartRefreshIntervalMs — WATCHLIST (unwatched)', () => {
  it('active airing show -> ~daily', () => {
    const result = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.WATCHLIST, releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: null, now });
    expect(result.intervalMs).toBe(1 * DAY_MS);
  });

  it('between seasons -> lower frequency (weekly)', () => {
    const result = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.WATCHLIST, releaseStatus: ReleaseStatus.ENDED, nextKnownUpcomingAirDate: null, now });
    expect(result.intervalMs).toBe(7 * DAY_MS);
  });
});

describe('computeSmartRefreshIntervalMs — retry/backoff integration', () => {
  it('is deterministic given the same inputs (no hidden randomness)', () => {
    const a = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.WATCHING, releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: hoursFromNow(10), now });
    const b = computeSmartRefreshIntervalMs({ userStatus: UserSeriesStatus.WATCHING, releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: hoursFromNow(10), now });
    expect(a).toEqual(b);
  });
});
