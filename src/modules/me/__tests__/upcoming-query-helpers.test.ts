import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import {
  buildUpcomingDayBuckets,
  compareUpcomingItemsWithinDay,
  deriveUpcomingBadges,
  hasKnownReleaseTimeOfDay,
  toAirDateOnlyString,
  toUpcomingItem,
  UPCOMING_ELIGIBLE_STATUSES,
  UpcomingItem,
  validateUpcomingWindow,
} from '../upcoming-query-helpers';

function makeItem(overrides: Partial<UpcomingItem> = {}): UpcomingItem {
  return {
    seriesId: 's1',
    seriesTitle: 'Alpha Show',
    posterUrl: null,
    episodeId: 'e1',
    seasonId: 'se1',
    seasonNumber: 1,
    episodeNumber: 1,
    episodeTitle: null,
    airDateOnly: '2026-07-15',
    airDateInstant: new Date('2026-07-15T00:00:00.000Z'),
    hasKnownReleaseTime: false,
    isReleased: true,
    isWatched: false,
    episodeWatchId: null,
    seriesUserStatus: UserSeriesStatus.WATCHING,
    seriesReleaseStatus: ReleaseStatus.RETURNING,
    badges: { seasonPremiere: false, seriesPremiere: false },
    ...overrides,
  };
}

describe('UPCOMING_ELIGIBLE_STATUSES', () => {
  it('includes WATCHING, CAUGHT_UP, WATCHLIST, PAUSED, COMPLETED — excludes DROPPED and UNKNOWN', () => {
    expect(UPCOMING_ELIGIBLE_STATUSES).toEqual([
      UserSeriesStatus.WATCHING,
      UserSeriesStatus.CAUGHT_UP,
      UserSeriesStatus.WATCHLIST,
      UserSeriesStatus.PAUSED,
      UserSeriesStatus.COMPLETED,
    ]);
    expect(UPCOMING_ELIGIBLE_STATUSES).not.toContain(UserSeriesStatus.DROPPED);
    expect(UPCOMING_ELIGIBLE_STATUSES).not.toContain(UserSeriesStatus.UNKNOWN);
  });
});

describe('validateUpcomingWindow', () => {
  it('accepts a valid window', () => {
    const result = validateUpcomingWindow('2026-07-01', '2026-07-31');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
      expect(result.to.toISOString()).toBe('2026-07-31T00:00:00.000Z');
    }
  });

  it('rejects an invalid "from" date', () => {
    const result = validateUpcomingWindow('not-a-date', '2026-07-31');
    expect(result.valid).toBe(false);
  });

  it('rejects an invalid "to" date', () => {
    const result = validateUpcomingWindow('2026-07-01', 'nope');
    expect(result.valid).toBe(false);
  });

  it('rejects to <= from', () => {
    expect(validateUpcomingWindow('2026-07-31', '2026-07-01').valid).toBe(false);
    expect(validateUpcomingWindow('2026-07-01', '2026-07-01').valid).toBe(false);
  });

  it('rejects a window spanning more than 45 days', () => {
    const result = validateUpcomingWindow('2026-01-01', '2026-12-31');
    expect(result.valid).toBe(false);
  });

  it('accepts a 1-day window (the minimum)', () => {
    expect(validateUpcomingWindow('2026-07-01', '2026-07-02').valid).toBe(true);
  });
});

describe('toAirDateOnlyString', () => {
  it('round-trips a UTC-midnight-parsed date exactly', () => {
    expect(toAirDateOnlyString(new Date('2026-07-05T00:00:00.000Z'))).toBe('2026-07-05');
  });

  it('uses UTC getters regardless of host timezone (never local getters)', () => {
    // A near-midnight-UTC instant that would shift to the adjacent calendar
    // day under local-getter formatting in many timezones — must still
    // format as its real UTC calendar date.
    expect(toAirDateOnlyString(new Date('2026-07-05T23:59:00.000Z'))).toBe('2026-07-05');
  });
});

describe('hasKnownReleaseTimeOfDay', () => {
  it('is false for a date-only (UTC-midnight) value — the only kind this app currently produces', () => {
    expect(hasKnownReleaseTimeOfDay(new Date('2026-07-15T00:00:00.000Z'))).toBe(false);
  });

  it('is true when a non-midnight time-of-day is present (architecturally supported, not reachable with current providers)', () => {
    expect(hasKnownReleaseTimeOfDay(new Date('2026-07-15T21:30:00.000Z'))).toBe(true);
    expect(hasKnownReleaseTimeOfDay(new Date('2026-07-15T00:00:01.000Z'))).toBe(true);
    expect(hasKnownReleaseTimeOfDay(new Date('2026-07-15T00:00:00.500Z'))).toBe(true);
  });
});

describe('deriveUpcomingBadges', () => {
  it('flags a season premiere: episodeNumber 1 in a canonical season', () => {
    expect(deriveUpcomingBadges(2, 1)).toEqual({ seasonPremiere: true, seriesPremiere: false });
  });

  it('flags a series premiere: season 1 episode 1 (implies seasonPremiere)', () => {
    expect(deriveUpcomingBadges(1, 1)).toEqual({ seasonPremiere: true, seriesPremiere: true });
  });

  it('never flags season 0 (Specials) as a premiere, even at episode 1', () => {
    expect(deriveUpcomingBadges(0, 1)).toEqual({ seasonPremiere: false, seriesPremiere: false });
  });

  it('flags neither for a non-first episode', () => {
    expect(deriveUpcomingBadges(2, 5)).toEqual({ seasonPremiere: false, seriesPremiere: false });
  });
});

describe('toUpcomingItem', () => {
  const now = new Date('2026-07-15T12:00:00.000Z');

  it('builds a fully-populated item from a raw episode row', () => {
    const item = toUpcomingItem(
      {
        id: 'ep1',
        seasonId: 'se1',
        episodeNumber: 3,
        title: 'Into the Dark',
        airDate: new Date('2026-07-10T00:00:00.000Z'),
        seasonNumber: 2,
        seriesId: 'ser1',
        seriesTitle: 'The Great Voyage',
        posterUrl: 'https://example.com/poster.jpg',
        seriesReleaseStatus: ReleaseStatus.RETURNING,
        seriesUserStatus: UserSeriesStatus.WATCHING,
      },
      'watch1',
      now,
    );

    expect(item).toMatchObject({
      seriesId: 'ser1',
      seriesTitle: 'The Great Voyage',
      episodeId: 'ep1',
      airDateOnly: '2026-07-10',
      hasKnownReleaseTime: false,
      isReleased: true,
      isWatched: true,
      episodeWatchId: 'watch1',
      badges: { seasonPremiere: false, seriesPremiere: false },
    });
  });

  it('marks a future episode as not released and not watched when no watch id is given', () => {
    const item = toUpcomingItem(
      {
        id: 'ep2',
        seasonId: 'se1',
        episodeNumber: 1,
        title: null,
        airDate: new Date('2026-08-01T00:00:00.000Z'),
        seasonNumber: 3,
        seriesId: 'ser1',
        seriesTitle: 'The Great Voyage',
        posterUrl: null,
        seriesReleaseStatus: ReleaseStatus.RETURNING,
        seriesUserStatus: UserSeriesStatus.WATCHING,
      },
      null,
      now,
    );

    expect(item.isReleased).toBe(false);
    expect(item.isWatched).toBe(false);
    expect(item.badges).toEqual({ seasonPremiere: true, seriesPremiere: false });
  });
});

describe('compareUpcomingItemsWithinDay', () => {
  it('sorts known-time items before unknown-time items regardless of clock value', () => {
    const known = makeItem({ episodeId: 'known', hasKnownReleaseTime: true, airDateInstant: new Date('2026-07-15T23:59:00.000Z') });
    const unknown = makeItem({ episodeId: 'unknown', hasKnownReleaseTime: false, seriesTitle: 'Aardvark Show' });
    const sorted = [unknown, known].sort(compareUpcomingItemsWithinDay);
    expect(sorted.map((i) => i.episodeId)).toEqual(['known', 'unknown']);
  });

  it('sorts known-time items by instant ascending', () => {
    const early = makeItem({ episodeId: 'early', hasKnownReleaseTime: true, airDateInstant: new Date('2026-07-15T09:00:00.000Z') });
    const late = makeItem({ episodeId: 'late', hasKnownReleaseTime: true, airDateInstant: new Date('2026-07-15T21:00:00.000Z') });
    const sorted = [late, early].sort(compareUpcomingItemsWithinDay);
    expect(sorted.map((i) => i.episodeId)).toEqual(['early', 'late']);
  });

  it('sorts unknown-time items alphabetically by series title (case-insensitive)', () => {
    const zebra = makeItem({ episodeId: 'zebra', seriesTitle: 'Zebra Show' });
    const apple = makeItem({ episodeId: 'apple', seriesTitle: 'apple show' });
    const sorted = [zebra, apple].sort(compareUpcomingItemsWithinDay);
    expect(sorted.map((i) => i.episodeId)).toEqual(['apple', 'zebra']);
  });

  it('tie-breaks same-title items by (seasonNumber, episodeNumber), then episodeId', () => {
    const s1e2 = makeItem({ episodeId: 'b', seasonNumber: 1, episodeNumber: 2 });
    const s1e1 = makeItem({ episodeId: 'a', seasonNumber: 1, episodeNumber: 1 });
    const s2e1 = makeItem({ episodeId: 'c', seasonNumber: 2, episodeNumber: 1 });
    const sorted = [s2e1, s1e2, s1e1].sort(compareUpcomingItemsWithinDay);
    expect(sorted.map((i) => i.episodeId)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to episodeId for full determinism when everything else ties', () => {
    const b = makeItem({ episodeId: 'b' });
    const a = makeItem({ episodeId: 'a' });
    const sorted = [b, a].sort(compareUpcomingItemsWithinDay);
    expect(sorted.map((i) => i.episodeId)).toEqual(['a', 'b']);
  });
});

describe('buildUpcomingDayBuckets', () => {
  it('groups items by airDateOnly and sorts the groups chronologically', () => {
    const day1 = makeItem({ episodeId: 'e1', airDateOnly: '2026-07-16' });
    const day0 = makeItem({ episodeId: 'e2', airDateOnly: '2026-07-15' });
    const buckets = buildUpcomingDayBuckets([day1, day0]);
    expect(buckets.map((b) => b.date)).toEqual(['2026-07-15', '2026-07-16']);
  });

  it('is sparse — a date with zero items never appears (nothing to group in the first place)', () => {
    const buckets = buildUpcomingDayBuckets([]);
    expect(buckets).toEqual([]);
  });

  it('sorts items within each date per compareUpcomingItemsWithinDay', () => {
    const zebra = makeItem({ episodeId: 'zebra', airDateOnly: '2026-07-15', seriesTitle: 'Zebra' });
    const apple = makeItem({ episodeId: 'apple', airDateOnly: '2026-07-15', seriesTitle: 'Apple' });
    const buckets = buildUpcomingDayBuckets([zebra, apple]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].items.map((i) => i.episodeId)).toEqual(['apple', 'zebra']);
  });

  it('never duplicates or drops items across separately-built buckets for adjacent windows', () => {
    const before = buildUpcomingDayBuckets([makeItem({ episodeId: 'e1', airDateOnly: '2026-07-14' })]);
    const after = buildUpcomingDayBuckets([makeItem({ episodeId: 'e2', airDateOnly: '2026-07-15' })]);
    const allIds = [...before, ...after].flatMap((b) => b.items.map((i) => i.episodeId));
    expect(allIds).toEqual(['e1', 'e2']);
  });
});
