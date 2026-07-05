import { classifyWatchNextItem, ClassifyWatchNextItemInput } from '../classify';

function baseInput(overrides: Partial<ClassifyWatchNextItemInput> = {}): ClassifyWatchNextItemInput {
  return {
    hasTmdbMatch: true,
    hasSecondaryProviderMatch: true,
    isRemakeCollision: false,
    tvmazeThinksCaughtUpByPosition: false,
    tvmazeNextEpisodeIsTBA: false,
    mytvKnownEpisodeCount: 20,
    tvmazeKnownEpisodeCount: 20,
    ...overrides,
  };
}

describe('classifyWatchNextItem', () => {
  it('is NO_SECONDARY_PROVIDER_MATCH when TVmaze has no candidate at all', () => {
    const result = classifyWatchNextItem(baseInput({ hasSecondaryProviderMatch: false, tvmazeKnownEpisodeCount: null }));
    expect(result.category).toBe('NO_SECONDARY_PROVIDER_MATCH');
  });

  it('is REMAKE_COLLISION when a title collision is flagged, even with a secondary match', () => {
    const result = classifyWatchNextItem(baseInput({ isRemakeCollision: true }));
    expect(result.category).toBe('REMAKE_COLLISION');
  });

  it('is TVMAZE_NEXT_IS_TBA when TVmaze proposes a placeholder next episode', () => {
    const result = classifyWatchNextItem(baseInput({ tvmazeNextEpisodeIsTBA: true }));
    expect(result.category).toBe('TVMAZE_NEXT_IS_TBA');
  });

  it('is TVMAZE_SAYS_CAUGHT_UP when TVmaze thinks the user has watched everything it knows', () => {
    const result = classifyWatchNextItem(baseInput({ tvmazeThinksCaughtUpByPosition: true, mytvKnownEpisodeCount: 76, tvmazeKnownEpisodeCount: 50 }));
    expect(result.category).toBe('TVMAZE_SAYS_CAUGHT_UP');
  });

  it('is PROVIDER_EPISODE_COUNT_DISAGREEMENT when episode counts differ beyond tolerance with no other signal', () => {
    const result = classifyWatchNextItem(baseInput({ mytvKnownEpisodeCount: 48, tvmazeKnownEpisodeCount: 38 }));
    expect(result.category).toBe('PROVIDER_EPISODE_COUNT_DISAGREEMENT');
  });

  it('is KEEP_IN_WATCH_NEXT_CONFIDENT when TMDb matched and TVmaze agrees on episode count', () => {
    const result = classifyWatchNextItem(baseInput({ mytvKnownEpisodeCount: 20, tvmazeKnownEpisodeCount: 21 }));
    expect(result.category).toBe('KEEP_IN_WATCH_NEXT_CONFIDENT');
  });

  it('does not flag a small episode-count delta within tolerance as a disagreement', () => {
    const result = classifyWatchNextItem(baseInput({ mytvKnownEpisodeCount: 20, tvmazeKnownEpisodeCount: 22 }));
    expect(result.category).not.toBe('PROVIDER_EPISODE_COUNT_DISAGREEMENT');
  });

  it('is NEEDS_MANUAL_DECISION when there is no TMDb match but TVmaze agrees with MyTv on count', () => {
    const result = classifyWatchNextItem(baseInput({ hasTmdbMatch: false, mytvKnownEpisodeCount: 20, tvmazeKnownEpisodeCount: 20 }));
    expect(result.category).toBe('NEEDS_MANUAL_DECISION');
  });

  it('prioritizes remake collision over a TBA next episode', () => {
    const result = classifyWatchNextItem(baseInput({ isRemakeCollision: true, tvmazeNextEpisodeIsTBA: true }));
    expect(result.category).toBe('REMAKE_COLLISION');
  });

  it('prioritizes TBA over caught-up-by-position', () => {
    const result = classifyWatchNextItem(baseInput({ tvmazeNextEpisodeIsTBA: true, tvmazeThinksCaughtUpByPosition: true }));
    expect(result.category).toBe('TVMAZE_NEXT_IS_TBA');
  });

  it('prioritizes caught-up-by-position over a plain count disagreement', () => {
    const result = classifyWatchNextItem(baseInput({ tvmazeThinksCaughtUpByPosition: true, mytvKnownEpisodeCount: 100, tvmazeKnownEpisodeCount: 50 }));
    expect(result.category).toBe('TVMAZE_SAYS_CAUGHT_UP');
  });
});
