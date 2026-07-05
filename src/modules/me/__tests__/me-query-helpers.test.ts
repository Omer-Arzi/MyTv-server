import { filterReleasedNextEpisodes, ProgressWithNextEpisode } from '../me-query-helpers';

const PAST = new Date('2000-01-01');
const FUTURE = new Date('2999-01-01');

interface FakeProgress extends ProgressWithNextEpisode {
  id: string;
  nextEpisode: { airDate: Date | null } | null;
}

function progress(id: string, airDate: Date | null): FakeProgress {
  return { id, nextEpisode: { airDate } };
}

describe('filterReleasedNextEpisodes', () => {
  it('keeps rows whose nextEpisode airDate is in the past', () => {
    const result = filterReleasedNextEpisodes([progress('a', PAST)]);
    expect(result.map((p) => p.id)).toEqual(['a']);
  });

  it('excludes rows whose nextEpisode airDate is in the future', () => {
    const result = filterReleasedNextEpisodes([progress('a', FUTURE)]);
    expect(result).toEqual([]);
  });

  it('excludes rows with a null nextEpisode airDate', () => {
    const result = filterReleasedNextEpisodes([progress('a', null)]);
    expect(result).toEqual([]);
  });

  it('excludes rows with no nextEpisode at all', () => {
    const result = filterReleasedNextEpisodes([{ id: 'a', nextEpisode: null }]);
    expect(result).toEqual([]);
  });

  it('filters a mixed list down to only past-and-released episodes', () => {
    const result = filterReleasedNextEpisodes([
      progress('past', PAST),
      progress('future', FUTURE),
      progress('null-date', null),
      { id: 'no-episode', nextEpisode: null },
    ]);
    expect(result.map((p) => p.id)).toEqual(['past']);
  });

  it('treats an airDate exactly equal to "now" as released', () => {
    const now = new Date('2026-07-04T00:00:00.000Z');
    const result = filterReleasedNextEpisodes([progress('a', now)], now);
    expect(result.map((p) => p.id)).toEqual(['a']);
  });
});
