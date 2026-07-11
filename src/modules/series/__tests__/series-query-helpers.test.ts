import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import {
  buildLibraryWhere,
  deriveManualStatusUpdate,
  findFirstUnwatchedEpisodeId,
  groupEpisodesBySeason,
  OrderedEpisodeForNextLookup,
  RawEpisodeForGrouping,
} from '../series-query-helpers';
import { ManualUserStatus } from '../dto/update-series-status.dto';

// Fixed, unambiguously-past/future reference dates rather than relying on
// the real current time — keeps these tests deterministic regardless of
// when they run.
const PAST = new Date('2000-01-01');
const FUTURE = new Date('2999-01-01');

function nextEp(id: string, airDate: Date | null = PAST): OrderedEpisodeForNextLookup {
  return { id, airDate };
}

describe('buildLibraryWhere', () => {
  it('always scopes to the current user\'s own UserSeriesProgress relationship', () => {
    const where = buildLibraryWhere({ userId: 'user-1' });
    expect(where).toEqual({
      progress: { some: { userId: 'user-1' } },
    });
  });

  it('adds a userStatus filter when status is provided', () => {
    const where = buildLibraryWhere({ userId: 'user-1', status: UserSeriesStatus.WATCHING });
    expect(where.progress).toEqual({ some: { userId: 'user-1', userStatus: UserSeriesStatus.WATCHING } });
  });

  it('adds a releaseStatus filter when provided', () => {
    const where = buildLibraryWhere({ userId: 'user-1', releaseStatus: ReleaseStatus.ENDED });
    expect(where.releaseStatus).toBe(ReleaseStatus.ENDED);
  });

  it('adds a case-insensitive title search when q is provided', () => {
    const where = buildLibraryWhere({ userId: 'user-1', q: 'dragon' });
    expect(where.title).toEqual({ contains: 'dragon', mode: 'insensitive' });
  });

  it('does not add releaseStatus/title clauses when not requested', () => {
    const where = buildLibraryWhere({ userId: 'user-1' });
    expect(where.releaseStatus).toBeUndefined();
    expect(where.title).toBeUndefined();
  });

  it('combines all filters together', () => {
    const where = buildLibraryWhere({ userId: 'user-1', status: UserSeriesStatus.CAUGHT_UP, releaseStatus: ReleaseStatus.RETURNING, q: 'kenshin' });
    expect(where).toEqual({
      progress: { some: { userId: 'user-1', userStatus: UserSeriesStatus.CAUGHT_UP } },
      releaseStatus: ReleaseStatus.RETURNING,
      title: { contains: 'kenshin', mode: 'insensitive' },
    });
  });
});

describe('groupEpisodesBySeason', () => {
  function ep(overrides: Partial<RawEpisodeForGrouping>): RawEpisodeForGrouping {
    return {
      id: 'ep-1',
      seasonId: 'season-1',
      seasonNumber: 1,
      seasonTitle: 'Season 1',
      episodeNumber: 1,
      title: 'Pilot',
      overview: 'The beginning.',
      airDate: new Date('2024-01-01'),
      runtimeMinutes: 42,
      imageUrl: 'https://image.tmdb.org/t/p/original/ep1.jpg',
      ...overrides,
    };
  }

  it('groups episodes by seasonNumber, in season order', () => {
    const episodes = [
      ep({ id: 'e1', seasonNumber: 1, episodeNumber: 1 }),
      ep({ id: 'e2', seasonNumber: 1, episodeNumber: 2 }),
      ep({ id: 'e3', seasonNumber: 2, seasonId: 'season-2', seasonTitle: 'Season 2', episodeNumber: 1 }),
    ];

    const seasons = groupEpisodesBySeason(episodes, new Map());

    expect(seasons).toHaveLength(2);
    expect(seasons[0].seasonNumber).toBe(1);
    expect(seasons[0].episodes).toHaveLength(2);
    expect(seasons[1].seasonNumber).toBe(2);
    expect(seasons[1].episodes).toHaveLength(1);
  });

  it('sorts season buckets by seasonNumber even if input episodes arrive out of season order', () => {
    const episodes = [
      ep({ id: 'e3', seasonNumber: 3, episodeNumber: 1 }),
      ep({ id: 'e1', seasonNumber: 1, episodeNumber: 1 }),
      ep({ id: 'e2', seasonNumber: 2, episodeNumber: 1 }),
    ];

    const seasons = groupEpisodesBySeason(episodes, new Map());
    expect(seasons.map((s) => s.seasonNumber)).toEqual([1, 2, 3]);
  });

  it('marks an episode watched, with watchedAt, note, and episodeWatchId, when present in the watch-info map', () => {
    const watchedAt = new Date('2026-06-30T21:14:00.000Z');
    const episodes = [ep({ id: 'e1' })];
    const watchInfo = new Map([['e1', { episodeWatchId: 'watch-1', watchedAt, note: 'Great episode!' }]]);

    const seasons = groupEpisodesBySeason(episodes, watchInfo);

    expect(seasons[0].episodes[0].watched).toBe(true);
    expect(seasons[0].episodes[0].watchedAt).toBe(watchedAt);
    expect(seasons[0].episodes[0].note).toBe('Great episode!');
    expect(seasons[0].episodes[0].episodeWatchId).toBe('watch-1');
  });

  it('marks an episode unwatched, with null watchedAt/note/episodeWatchId, when absent from the watch-info map', () => {
    const episodes = [ep({ id: 'e1' })];
    const seasons = groupEpisodesBySeason(episodes, new Map());

    expect(seasons[0].episodes[0].watched).toBe(false);
    expect(seasons[0].episodes[0].watchedAt).toBeNull();
    expect(seasons[0].episodes[0].note).toBeNull();
    expect(seasons[0].episodes[0].episodeWatchId).toBeNull();
  });

  it('reports watched=true with a null note when the episode was watched but no note was left', () => {
    const watchedAt = new Date('2026-06-30T21:14:00.000Z');
    const episodes = [ep({ id: 'e1' })];
    const watchInfo = new Map([['e1', { episodeWatchId: 'watch-1', watchedAt, note: null }]]);

    const seasons = groupEpisodesBySeason(episodes, watchInfo);
    expect(seasons[0].episodes[0].watched).toBe(true);
    expect(seasons[0].episodes[0].note).toBeNull();
    expect(seasons[0].episodes[0].episodeWatchId).toBe('watch-1');
  });

  it('carries imageUrl through into the grouped episode', () => {
    const episodes = [ep({ id: 'e1', imageUrl: 'https://image.tmdb.org/t/p/original/still.jpg' })];
    const seasons = groupEpisodesBySeason(episodes, new Map());
    expect(seasons[0].episodes[0].imageUrl).toBe('https://image.tmdb.org/t/p/original/still.jpg');
  });

  it('returns an empty array for a series with no episodes', () => {
    expect(groupEpisodesBySeason([], new Map())).toEqual([]);
  });
});

describe('findFirstUnwatchedEpisodeId', () => {
  it('returns the first id not present in the watched set', () => {
    expect(findFirstUnwatchedEpisodeId([nextEp('e1'), nextEp('e2'), nextEp('e3')], new Set(['e1']))).toBe('e2');
  });

  it('finds the first gap even if a later episode was watched out of order', () => {
    expect(findFirstUnwatchedEpisodeId([nextEp('e1'), nextEp('e2'), nextEp('e3')], new Set(['e1', 'e3']))).toBe('e2');
  });

  it('returns the first episode when nothing has been watched', () => {
    expect(findFirstUnwatchedEpisodeId([nextEp('e1'), nextEp('e2')], new Set())).toBe('e1');
  });

  it('returns null when everything is watched', () => {
    expect(findFirstUnwatchedEpisodeId([nextEp('e1'), nextEp('e2')], new Set(['e1', 'e2']))).toBeNull();
  });

  it('returns null for an empty episode list', () => {
    expect(findFirstUnwatchedEpisodeId([], new Set())).toBeNull();
  });

  it('skips an unwatched episode with a future airDate — it is not a valid "next episode" yet', () => {
    expect(findFirstUnwatchedEpisodeId([nextEp('e1'), nextEp('e2', FUTURE)], new Set(['e1']))).toBeNull();
  });

  it('skips an unwatched episode with a null airDate (conservative default)', () => {
    expect(findFirstUnwatchedEpisodeId([nextEp('e1'), nextEp('e2', null)], new Set(['e1']))).toBeNull();
  });

  it('finds a later already-released unwatched episode past an unreleased gap', () => {
    expect(findFirstUnwatchedEpisodeId([nextEp('e1'), nextEp('e2', FUTURE), nextEp('e3')], new Set(['e1']))).toBe('e3');
  });
});

describe('deriveManualStatusUpdate — status update rules', () => {
  // Default input for tests that don't care about releaseStatus/
  // currentNextEpisodeId, spread-overridden per test. userStatus is a
  // required positional arg (not part of the partial) so TS still narrows
  // it to ManualUserStatus rather than widening to `| undefined`.
  function baseInput(
    userStatus: ManualUserStatus,
    overrides: Partial<Omit<Parameters<typeof deriveManualStatusUpdate>[0], 'userStatus'>> = {},
  ): Parameters<typeof deriveManualStatusUpdate>[0] {
    return {
      userStatus,
      orderedEpisodes: [],
      watchedEpisodeIds: new Set<string>(),
      releaseStatus: ReleaseStatus.RETURNING,
      currentNextEpisodeId: null,
      ...overrides,
    };
  }

  it('WATCHING re-derives nextEpisodeId as the first unwatched episode, and userStatus stays WATCHING when one exists', () => {
    const result = deriveManualStatusUpdate(
      baseInput(UserSeriesStatus.WATCHING, {
        orderedEpisodes: [nextEp('e1'), nextEp('e2'), nextEp('e3')],
        watchedEpisodeIds: new Set(['e1']),
      }),
    );
    expect(result).toEqual({ userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: 'e2' });
  });

  // Regression test for the bug found in docs/on-hold-dropped-status-todo.md
  // Phase 4: resuming a series that's fully caught up used to always come
  // back as WATCHING regardless of whether CAUGHT_UP/COMPLETED was the
  // actually-correct derived status.
  it('WATCHING with everything currently known already watched derives CAUGHT_UP for a still-airing series (not blindly WATCHING)', () => {
    const result = deriveManualStatusUpdate(
      baseInput(UserSeriesStatus.WATCHING, {
        orderedEpisodes: [nextEp('e1'), nextEp('e2')],
        watchedEpisodeIds: new Set(['e1', 'e2']),
        releaseStatus: ReleaseStatus.RETURNING,
      }),
    );
    expect(result).toEqual({ userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null });
  });

  it('WATCHING with everything currently known already watched derives COMPLETED for an ended series', () => {
    const result = deriveManualStatusUpdate(
      baseInput(UserSeriesStatus.WATCHING, {
        orderedEpisodes: [nextEp('e1')],
        watchedEpisodeIds: new Set(['e1']),
        releaseStatus: ReleaseStatus.ENDED,
      }),
    );
    expect(result).toEqual({ userStatus: UserSeriesStatus.COMPLETED, nextEpisodeId: null });
  });

  it('WATCHING with an empty episode catalog derives CAUGHT_UP/COMPLETED per releaseStatus, not literal WATCHING', () => {
    const returning = deriveManualStatusUpdate(baseInput(UserSeriesStatus.WATCHING, { releaseStatus: ReleaseStatus.RETURNING }));
    expect(returning).toEqual({ userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null });

    const cancelled = deriveManualStatusUpdate(baseInput(UserSeriesStatus.WATCHING, { releaseStatus: ReleaseStatus.CANCELLED }));
    expect(cancelled).toEqual({ userStatus: UserSeriesStatus.COMPLETED, nextEpisodeId: null });
  });

  it('WATCHING with only an unreleased unwatched episode derives CAUGHT_UP/COMPLETED, not WATCHING (future episode never counts as "next")', () => {
    const result = deriveManualStatusUpdate(
      baseInput(UserSeriesStatus.WATCHING, {
        orderedEpisodes: [nextEp('e1'), nextEp('e2', FUTURE)],
        watchedEpisodeIds: new Set(['e1']),
        releaseStatus: ReleaseStatus.RETURNING,
      }),
    );
    expect(result).toEqual({ userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null });
  });

  // Regression tests for the bug found in docs/on-hold-dropped-status-todo.md
  // Phase 5: pausing/dropping used to always null nextEpisodeId instead of
  // preserving it.
  it.each([UserSeriesStatus.PAUSED, UserSeriesStatus.DROPPED])(
    '%s sets userStatus exactly as requested and PRESERVES the current nextEpisodeId, even if a different episode would be "next" if recomputed',
    (userStatus) => {
      const result = deriveManualStatusUpdate(
        baseInput(userStatus, {
          orderedEpisodes: [nextEp('e1'), nextEp('e2')],
          watchedEpisodeIds: new Set(),
          currentNextEpisodeId: 'e1',
        }),
      );
      expect(result).toEqual({ userStatus, nextEpisodeId: 'e1' });
    },
  );

  it.each([UserSeriesStatus.PAUSED, UserSeriesStatus.DROPPED])(
    '%s preserves a null nextEpisodeId as null (nothing invented)',
    (userStatus) => {
      const result = deriveManualStatusUpdate(baseInput(userStatus, { currentNextEpisodeId: null }));
      expect(result).toEqual({ userStatus, nextEpisodeId: null });
    },
  );

  it('WATCHLIST always clears nextEpisodeId, even if a currentNextEpisodeId was passed in', () => {
    const result = deriveManualStatusUpdate(
      baseInput(UserSeriesStatus.WATCHLIST, { currentNextEpisodeId: 'e1' }),
    );
    expect(result).toEqual({ userStatus: UserSeriesStatus.WATCHLIST, nextEpisodeId: null });
  });
});
