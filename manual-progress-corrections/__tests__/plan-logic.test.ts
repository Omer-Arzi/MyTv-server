import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import {
  computeUnwatchedKnownEpisodes,
  deriveStatusAfterMarkAllWatched,
  EpisodeRef,
  findEpisodeByAbsolutePosition,
  findEpisodeByExactTitle,
  findEpisodeBySeasonEpisode,
} from '../plan-logic';

function episode(id: string, seasonNumber: number, episodeNumber: number, title: string | null = null): EpisodeRef {
  return { id, seasonNumber, episodeNumber, title, airDate: null };
}

describe('findEpisodeBySeasonEpisode', () => {
  const episodes = [episode('s1e1', 1, 1), episode('s1e2', 1, 2), episode('s2e1', 2, 1)];

  it('finds an existing season/episode combination', () => {
    expect(findEpisodeBySeasonEpisode(episodes, 2, 1)?.id).toBe('s2e1');
  });

  it('returns null when the season/episode does not exist', () => {
    expect(findEpisodeBySeasonEpisode(episodes, 5, 14)).toBeNull();
  });
});

describe('findEpisodeByExactTitle', () => {
  const episodes = [episode('a', 3, 1, 'Tokyo Colony No. 1 - Part 1'), episode('b', 3, 2, null)];

  it('matches an exact title case-insensitively and trims whitespace', () => {
    expect(findEpisodeByExactTitle(episodes, '  tokyo colony no. 1 - part 1  ')?.id).toBe('a');
  });

  it('does not fuzzy-match a similar-but-different title', () => {
    expect(findEpisodeByExactTitle(episodes, 'Tokyo Colony No. 1 - Part 2')).toBeNull();
  });

  it('returns null when episodes have no title at all', () => {
    expect(findEpisodeByExactTitle(episodes, '')).toBeNull();
  });
});

describe('findEpisodeByAbsolutePosition', () => {
  const ordered = [episode('a', 1, 1), episode('b', 1, 2), episode('c', 2, 1)];

  it('returns the episode at the given 1-based absolute position', () => {
    expect(findEpisodeByAbsolutePosition(ordered, 3)?.id).toBe('c');
  });

  it('returns null when the position is beyond the known catalog', () => {
    expect(findEpisodeByAbsolutePosition(ordered, 1158)).toBeNull();
  });

  it('returns null for a position less than 1', () => {
    expect(findEpisodeByAbsolutePosition(ordered, 0)).toBeNull();
  });
});

describe('computeUnwatchedKnownEpisodes', () => {
  it('returns episodes not present in the watched set', () => {
    const episodes = [episode('a', 1, 1), episode('b', 1, 2), episode('c', 1, 3)];
    const result = computeUnwatchedKnownEpisodes(episodes, new Set(['a', 'c']));
    expect(result.map((e) => e.id)).toEqual(['b']);
  });

  it('returns an empty array when every known episode is already watched', () => {
    const episodes = [episode('a', 1, 1), episode('b', 1, 2)];
    const result = computeUnwatchedKnownEpisodes(episodes, new Set(['a', 'b']));
    expect(result).toEqual([]);
  });
});

describe('deriveStatusAfterMarkAllWatched', () => {
  it('resolves to CAUGHT_UP when releaseStatus is UNKNOWN (unenriched)', () => {
    expect(deriveStatusAfterMarkAllWatched(ReleaseStatus.UNKNOWN)).toBe(UserSeriesStatus.CAUGHT_UP);
  });

  it('resolves to CAUGHT_UP when releaseStatus is RETURNING', () => {
    expect(deriveStatusAfterMarkAllWatched(ReleaseStatus.RETURNING)).toBe(UserSeriesStatus.CAUGHT_UP);
  });

  it('resolves to COMPLETED when releaseStatus is ENDED', () => {
    expect(deriveStatusAfterMarkAllWatched(ReleaseStatus.ENDED)).toBe(UserSeriesStatus.COMPLETED);
  });

  it('resolves to COMPLETED when releaseStatus is CANCELLED', () => {
    expect(deriveStatusAfterMarkAllWatched(ReleaseStatus.CANCELLED)).toBe(UserSeriesStatus.COMPLETED);
  });
});
