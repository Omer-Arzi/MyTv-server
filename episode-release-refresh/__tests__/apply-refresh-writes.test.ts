import { UserSeriesStatus } from '@prisma/client';
import { checkLiveWriteEligibility, decideProgressRecompute } from '../apply-refresh-writes';

describe('checkLiveWriteEligibility', () => {
  it('is eligible for WATCHING/CAUGHT_UP/COMPLETED', () => {
    for (const userStatus of [UserSeriesStatus.WATCHING, UserSeriesStatus.CAUGHT_UP, UserSeriesStatus.COMPLETED]) {
      expect(checkLiveWriteEligibility({ userStatus })).toEqual({ eligible: true, reason: null });
    }
  });

  it.each([UserSeriesStatus.DROPPED, UserSeriesStatus.PAUSED, UserSeriesStatus.WATCHLIST, UserSeriesStatus.UNKNOWN])(
    'is not eligible for live status %s',
    (userStatus) => {
      const result = checkLiveWriteEligibility({ userStatus });
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain(userStatus);
    },
  );

  it('is not eligible when no live progress row exists at all', () => {
    const result = checkLiveWriteEligibility(null);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('no UserSeriesProgress row found');
  });
});

describe('decideProgressRecompute', () => {
  it('does not recompute when zero episodes were inserted, regardless of userStatus', () => {
    expect(decideProgressRecompute(0, UserSeriesStatus.WATCHING).shouldRecompute).toBe(false);
    expect(decideProgressRecompute(0, UserSeriesStatus.COMPLETED).shouldRecompute).toBe(false);
  });

  // This is the concrete guarantee behind "never move COMPLETED back to
  // WATCHING merely because releaseStatus changed" — a releaseStatus-only
  // change never inserts an episode, so it can never reach this function
  // with a non-zero count in the first place.
  it.each([UserSeriesStatus.WATCHING, UserSeriesStatus.CAUGHT_UP, UserSeriesStatus.COMPLETED])(
    'recomputes for %s when at least one episode was inserted',
    (liveUserStatus) => {
      expect(decideProgressRecompute(1, liveUserStatus)).toEqual({
        shouldRecompute: true,
        reason: expect.stringContaining('1 episode(s) inserted'),
      });
    },
  );

  it.each([UserSeriesStatus.DROPPED, UserSeriesStatus.PAUSED, UserSeriesStatus.WATCHLIST, UserSeriesStatus.UNKNOWN])(
    'refuses to recompute for a not-tracked live status %s even when episodes were inserted',
    (liveUserStatus) => {
      expect(decideProgressRecompute(3, liveUserStatus)).toEqual({
        shouldRecompute: false,
        reason: expect.stringContaining('not tracked'),
      });
    },
  );

  it('zero-inserted takes priority over a not-tracked status in the reported reason', () => {
    const decision = decideProgressRecompute(0, UserSeriesStatus.DROPPED);
    expect(decision.shouldRecompute).toBe(false);
    expect(decision.reason).toContain('no episodes were actually inserted');
  });
});
