import { categorizeWatchNextCandidate, classifyAirDate, WatchNextCandidateInput } from '../audit-logic';

const NOW = new Date('2026-07-04T12:00:00.000Z');

function baseInput(overrides: Partial<WatchNextCandidateInput> = {}): WatchNextCandidateInput {
  return {
    airDate: new Date('2026-01-01'),
    hasFullCatalog: true,
    watchedEpisodeCount: 10,
    knownEpisodeCount: 20,
    distinctKnownSeasonCount: 2,
    hasSeasonZeroEpisodes: false,
    isDuplicateTitleGroupMember: false,
    now: NOW,
    ...overrides,
  };
}

describe('classifyAirDate', () => {
  it('is PAST for a date before now', () => {
    expect(classifyAirDate(new Date('2026-01-01'), NOW)).toBe('PAST');
  });

  it('is FUTURE for a date after now', () => {
    expect(classifyAirDate(new Date('2026-12-31'), NOW)).toBe('FUTURE');
  });

  it('is TODAY for the same calendar day regardless of time-of-day', () => {
    expect(classifyAirDate(new Date('2026-07-04T23:59:00.000Z'), NOW)).toBe('TODAY');
  });

  it('is NULL for a null airDate', () => {
    expect(classifyAirDate(null, NOW)).toBe('NULL');
  });
});

describe('categorizeWatchNextCandidate', () => {
  it('flags a future airDate as FUTURE_EPISODE_IN_WATCH_NEXT', () => {
    const result = categorizeWatchNextCandidate(baseInput({ airDate: new Date('2026-12-31') }));
    expect(result.category).toBe('FUTURE_EPISODE_IN_WATCH_NEXT');
  });

  it('flags a null airDate as NULL_AIRDATE_IN_WATCH_NEXT', () => {
    const result = categorizeWatchNextCandidate(baseInput({ airDate: null }));
    expect(result.category).toBe('NULL_AIRDATE_IN_WATCH_NEXT');
  });

  it('flags no confirmed TMDb match as INCOMPLETE_CATALOG', () => {
    const result = categorizeWatchNextCandidate(baseInput({ hasFullCatalog: false }));
    expect(result.category).toBe('INCOMPLETE_CATALOG');
  });

  it('flags a duplicate-title group member as POSSIBLE_REMAKE_OR_DUPLICATE_TITLE', () => {
    const result = categorizeWatchNextCandidate(baseInput({ isDuplicateTitleGroupMember: true }));
    expect(result.category).toBe('POSSIBLE_REMAKE_OR_DUPLICATE_TITLE');
  });

  it('flags a meaningfully over-watched count (>1.3x known) as POSSIBLE_REMAKE_OR_DUPLICATE_TITLE', () => {
    const result = categorizeWatchNextCandidate(baseInput({ watchedEpisodeCount: 30, knownEpisodeCount: 20 }));
    expect(result.category).toBe('POSSIBLE_REMAKE_OR_DUPLICATE_TITLE');
  });

  it('flags a mild over-watch (just above known, below remake ratio) as WATCHED_COUNT_EXCEEDS_KNOWN_EPISODES', () => {
    const result = categorizeWatchNextCandidate(baseInput({ watchedEpisodeCount: 21, knownEpisodeCount: 20 }));
    expect(result.category).toBe('WATCHED_COUNT_EXCEEDS_KNOWN_EPISODES');
  });

  it('flags a single-season long-running catalog as POSSIBLE_SEASON_NUMBERING_MISMATCH', () => {
    const result = categorizeWatchNextCandidate(
      baseInput({ distinctKnownSeasonCount: 1, knownEpisodeCount: 150, watchedEpisodeCount: 100 }),
    );
    expect(result.category).toBe('POSSIBLE_SEASON_NUMBERING_MISMATCH');
  });

  it('does not flag a single-season catalog below the long-running threshold', () => {
    const result = categorizeWatchNextCandidate(
      baseInput({ distinctKnownSeasonCount: 1, knownEpisodeCount: 12, watchedEpisodeCount: 8 }),
    );
    expect(result.category).toBe('SAFE');
  });

  it('flags season-0 episodes as POSSIBLE_SPECIALS_OR_SEASON_ZERO_MISMATCH', () => {
    const result = categorizeWatchNextCandidate(baseInput({ hasSeasonZeroEpisodes: true }));
    expect(result.category).toBe('POSSIBLE_SPECIALS_OR_SEASON_ZERO_MISMATCH');
  });

  it('is SAFE when every check passes', () => {
    const result = categorizeWatchNextCandidate(baseInput());
    expect(result.category).toBe('SAFE');
  });

  it('prioritizes FUTURE_EPISODE over other simultaneously-true issues', () => {
    const result = categorizeWatchNextCandidate(
      baseInput({ airDate: new Date('2026-12-31'), hasFullCatalog: false, hasSeasonZeroEpisodes: true }),
    );
    expect(result.category).toBe('FUTURE_EPISODE_IN_WATCH_NEXT');
  });
});
