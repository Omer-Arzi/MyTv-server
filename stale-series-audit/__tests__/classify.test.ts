import { classifyStaleSeries, ClassifyStaleSeriesInput } from '../classify';

function baseInput(overrides: Partial<ClassifyStaleSeriesInput> = {}): ClassifyStaleSeriesInput {
  return {
    isOnRiskList: false,
    userStatusIsCaughtUp: false,
    hasNextEpisode: true,
    hasTmdbMatch: true,
    nextEpisodeDataIncomplete: false,
    hasKnownSeasonShiftOrphan: false,
    nextEpisodeTitleDuplicatesLastWatched: false,
    hasSeasonZeroOrEpisodeZero: false,
    ...overrides,
  };
}

describe('classifyStaleSeries', () => {
  it('flags risk-list series above everything else, even if also CAUGHT_UP', () => {
    const result = classifyStaleSeries(baseInput({ isOnRiskList: true, userStatusIsCaughtUp: true }));
    expect(result.category).toBe('RISK_LIST_DO_NOT_TRUST');
    expect(result.recommendedAction).toBe('needs_manual_mapping');
  });

  it('classifies an already-CAUGHT_UP row as SHOULD_BE_CAUGHT_UP with an exclude action, not a mutation', () => {
    const result = classifyStaleSeries(baseInput({ userStatusIsCaughtUp: true }));
    expect(result.category).toBe('SHOULD_BE_CAUGHT_UP');
    expect(result.recommendedAction).toBe('exclude_from_stale_until_mapped');
  });

  it('classifies a WATCHING row with no nextEpisode and no catalog match as DATA_INCOMPLETE', () => {
    const result = classifyStaleSeries(baseInput({ hasNextEpisode: false, hasTmdbMatch: false }));
    expect(result.category).toBe('DATA_INCOMPLETE');
    expect(result.recommendedAction).toBe('enrich_catalog_first');
  });

  it('classifies a WATCHING row with no nextEpisode but a confirmed catalog match as SHOULD_BE_CAUGHT_UP with a mark_caught_up action', () => {
    const result = classifyStaleSeries(baseInput({ hasNextEpisode: false, hasTmdbMatch: true }));
    expect(result.category).toBe('SHOULD_BE_CAUGHT_UP');
    expect(result.recommendedAction).toBe('mark_caught_up');
  });

  it('classifies incomplete next-episode data as NEEDS_USER_CONFIRMATION', () => {
    const result = classifyStaleSeries(baseInput({ nextEpisodeDataIncomplete: true }));
    expect(result.category).toBe('NEEDS_USER_CONFIRMATION');
    expect(result.recommendedAction).toBe('needs_user_confirmation');
  });

  it('classifies a known season-shift orphan as POSSIBLE_SEASON_SHIFT', () => {
    const result = classifyStaleSeries(baseInput({ hasKnownSeasonShiftOrphan: true }));
    expect(result.category).toBe('POSSIBLE_SEASON_SHIFT');
    expect(result.recommendedAction).toBe('needs_manual_mapping');
  });

  it('classifies a title-duplicate signal as POSSIBLE_DUPLICATE_EPISODES', () => {
    const result = classifyStaleSeries(baseInput({ nextEpisodeTitleDuplicatesLastWatched: true }));
    expect(result.category).toBe('POSSIBLE_DUPLICATE_EPISODES');
    expect(result.recommendedAction).toBe('needs_manual_mapping');
  });

  it('classifies a season-0/episode-0 presence as POSSIBLE_SPECIALS_MISMATCH', () => {
    const result = classifyStaleSeries(baseInput({ hasSeasonZeroOrEpisodeZero: true }));
    expect(result.category).toBe('POSSIBLE_SPECIALS_MISMATCH');
    expect(result.recommendedAction).toBe('needs_manual_mapping');
  });

  it('classifies a clean, trusted, released next episode as TRUE_STALE_WATCHING', () => {
    const result = classifyStaleSeries(baseInput());
    expect(result.category).toBe('TRUE_STALE_WATCHING');
    expect(result.recommendedAction).toBe('keep_in_stale');
  });

  it('prioritizes season-shift over duplicate-title and specials signals when several apply at once', () => {
    const result = classifyStaleSeries(
      baseInput({ hasKnownSeasonShiftOrphan: true, nextEpisodeTitleDuplicatesLastWatched: true, hasSeasonZeroOrEpisodeZero: true }),
    );
    expect(result.category).toBe('POSSIBLE_SEASON_SHIFT');
  });

  it('prioritizes duplicate-title over specials when both apply', () => {
    const result = classifyStaleSeries(baseInput({ nextEpisodeTitleDuplicatesLastWatched: true, hasSeasonZeroOrEpisodeZero: true }));
    expect(result.category).toBe('POSSIBLE_DUPLICATE_EPISODES');
  });
});
