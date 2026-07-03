import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { buildLibraryWhere, groupEpisodesBySeason, RawEpisodeForGrouping } from '../series-query-helpers';

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

  it('marks an episode watched, with watchedAt and note, when present in the watch-info map', () => {
    const watchedAt = new Date('2026-06-30T21:14:00.000Z');
    const episodes = [ep({ id: 'e1' })];
    const watchInfo = new Map([['e1', { watchedAt, note: 'Great episode!' }]]);

    const seasons = groupEpisodesBySeason(episodes, watchInfo);

    expect(seasons[0].episodes[0].watched).toBe(true);
    expect(seasons[0].episodes[0].watchedAt).toBe(watchedAt);
    expect(seasons[0].episodes[0].note).toBe('Great episode!');
  });

  it('marks an episode unwatched, with null watchedAt/note, when absent from the watch-info map', () => {
    const episodes = [ep({ id: 'e1' })];
    const seasons = groupEpisodesBySeason(episodes, new Map());

    expect(seasons[0].episodes[0].watched).toBe(false);
    expect(seasons[0].episodes[0].watchedAt).toBeNull();
    expect(seasons[0].episodes[0].note).toBeNull();
  });

  it('reports watched=true with a null note when the episode was watched but no note was left', () => {
    const watchedAt = new Date('2026-06-30T21:14:00.000Z');
    const episodes = [ep({ id: 'e1' })];
    const watchInfo = new Map([['e1', { watchedAt, note: null }]]);

    const seasons = groupEpisodesBySeason(episodes, watchInfo);
    expect(seasons[0].episodes[0].watched).toBe(true);
    expect(seasons[0].episodes[0].note).toBeNull();
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
