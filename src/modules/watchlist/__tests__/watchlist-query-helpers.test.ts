import { UserSeriesStatus } from '@prisma/client';
import { buildWatchlistTabWhere, isWatchlistTabEligible, WATCHLIST_TAB_STATUSES } from '../watchlist-query-helpers';

describe('WATCHLIST_TAB_STATUSES', () => {
  it('contains exactly WATCHING, CAUGHT_UP, WATCHLIST — no more, no less', () => {
    expect(WATCHLIST_TAB_STATUSES).toEqual([UserSeriesStatus.WATCHING, UserSeriesStatus.CAUGHT_UP, UserSeriesStatus.WATCHLIST]);
  });

  it.each([UserSeriesStatus.PAUSED, UserSeriesStatus.DROPPED, UserSeriesStatus.COMPLETED, UserSeriesStatus.UNKNOWN])(
    'excludes %s',
    (status) => {
      expect(WATCHLIST_TAB_STATUSES).not.toContain(status);
    },
  );
});

describe('buildWatchlistTabWhere', () => {
  it('scopes to the given user and the three active-library statuses', () => {
    const where = buildWatchlistTabWhere('user-1');
    expect(where).toEqual({
      userId: 'user-1',
      userStatus: { in: [UserSeriesStatus.WATCHING, UserSeriesStatus.CAUGHT_UP, UserSeriesStatus.WATCHLIST] },
    });
  });
});

describe('isWatchlistTabEligible', () => {
  const confirmed = { tmdbId: '1418', traktId: null, imdbId: null };
  const unconfirmed = { tmdbId: null, traktId: null, imdbId: null };

  it.each([UserSeriesStatus.WATCHING, UserSeriesStatus.CAUGHT_UP])(
    '%s is eligible when the series has a confirmed provider match',
    (userStatus) => {
      expect(isWatchlistTabEligible({ userStatus, externalIds: confirmed })).toBe(true);
    },
  );

  it.each([UserSeriesStatus.WATCHING, UserSeriesStatus.CAUGHT_UP])(
    '%s is NOT eligible when the series has no confirmed provider match — unverified import-time status',
    (userStatus) => {
      expect(isWatchlistTabEligible({ userStatus, externalIds: unconfirmed })).toBe(false);
    },
  );

  it.each([UserSeriesStatus.WATCHING, UserSeriesStatus.CAUGHT_UP])('%s is NOT eligible when externalIds is null', (userStatus) => {
    expect(isWatchlistTabEligible({ userStatus, externalIds: null })).toBe(false);
  });

  it('WATCHLIST is always eligible regardless of provider confirmation — it makes no derived catalog claim', () => {
    expect(isWatchlistTabEligible({ userStatus: UserSeriesStatus.WATCHLIST, externalIds: unconfirmed })).toBe(true);
    expect(isWatchlistTabEligible({ userStatus: UserSeriesStatus.WATCHLIST, externalIds: null })).toBe(true);
    expect(isWatchlistTabEligible({ userStatus: UserSeriesStatus.WATCHLIST, externalIds: confirmed })).toBe(true);
  });
});
