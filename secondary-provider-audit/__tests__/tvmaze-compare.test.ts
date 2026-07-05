import { categorizeComparison, ComparisonInput, computeNextEpisodeComparison, TvMazeEpisodeForPositionLookup } from '../tvmaze-compare';

function baseInput(overrides: Partial<ComparisonInput> = {}): ComparisonInput {
  return {
    hasTmdbMatch: true,
    mytvKnownEpisodeCount: 20,
    watchedEpisodeCount: 10,
    tvmazeTier: 'AUTO_MATCH',
    tvmazeRegularEpisodeCount: 20,
    tvmazeEpisodeCountIncludingSpecials: 20,
    animeNumberingRiskDetected: false,
    closeCompetitorDetected: false,
    isDuplicateTitleGroupMember: false,
    structuralAutoMatchProposed: false,
    ...overrides,
  };
}

describe('categorizeComparison', () => {
  it('is NO_GOOD_MATCH when neither provider has a confident match', () => {
    const result = categorizeComparison(baseInput({ hasTmdbMatch: false, tvmazeTier: 'NO_MATCH' }));
    expect(result.category).toBe('NO_GOOD_MATCH');
  });

  it('is POSSIBLE_REMAKE_COLLISION when a close competitor is detected', () => {
    const result = categorizeComparison(baseInput({ closeCompetitorDetected: true }));
    expect(result.category).toBe('POSSIBLE_REMAKE_COLLISION');
  });

  it('is POSSIBLE_REMAKE_COLLISION when the series is a duplicate-title group member', () => {
    const result = categorizeComparison(baseInput({ isDuplicateTitleGroupMember: true }));
    expect(result.category).toBe('POSSIBLE_REMAKE_COLLISION');
  });

  it('is WATCHED_COUNT_EXCEEDS_PROVIDER_CATALOG when watched exceeds TVmaze regular count', () => {
    const result = categorizeComparison(baseInput({ watchedEpisodeCount: 25, tvmazeRegularEpisodeCount: 20 }));
    expect(result.category).toBe('WATCHED_COUNT_EXCEEDS_PROVIDER_CATALOG');
  });

  it('is POSSIBLE_ANIME_NUMBERING_MISMATCH when anime risk is detected', () => {
    const result = categorizeComparison(baseInput({ animeNumberingRiskDetected: true }));
    expect(result.category).toBe('POSSIBLE_ANIME_NUMBERING_MISMATCH');
  });

  it('is POSSIBLE_SPECIALS_MISMATCH when specials meaningfully exceed the regular count', () => {
    const result = categorizeComparison(baseInput({ tvmazeRegularEpisodeCount: 20, tvmazeEpisodeCountIncludingSpecials: 25 }));
    expect(result.category).toBe('POSSIBLE_SPECIALS_MISMATCH');
  });

  it('does not flag a small specials delta below the threshold', () => {
    const result = categorizeComparison(baseInput({ tvmazeRegularEpisodeCount: 20, tvmazeEpisodeCountIncludingSpecials: 21 }));
    expect(result.category).not.toBe('POSSIBLE_SPECIALS_MISMATCH');
  });

  it('is TVMAZE_LOOKS_BETTER when TMDb has no match but TVmaze matched confidently', () => {
    const result = categorizeComparison(baseInput({ hasTmdbMatch: false, tvmazeTier: 'AUTO_MATCH' }));
    expect(result.category).toBe('TVMAZE_LOOKS_BETTER');
  });

  it('is TMDB_LOOKS_CORRECT when TMDb has a match but TVmaze is inconclusive', () => {
    const result = categorizeComparison(baseInput({ hasTmdbMatch: true, tvmazeTier: 'NEEDS_REVIEW' }));
    expect(result.category).toBe('TMDB_LOOKS_CORRECT');
  });

  it('is BOTH_AGREE when both match confidently and episode counts are close', () => {
    const result = categorizeComparison(baseInput({ mytvKnownEpisodeCount: 20, tvmazeRegularEpisodeCount: 21 }));
    expect(result.category).toBe('BOTH_AGREE');
  });

  it('is BOTH_UNCERTAIN when both match confidently but episode counts disagree', () => {
    const result = categorizeComparison(baseInput({ mytvKnownEpisodeCount: 20, tvmazeRegularEpisodeCount: 30 }));
    expect(result.category).toBe('BOTH_UNCERTAIN');
  });

  it('is BOTH_UNCERTAIN when neither source is confident but TVmaze is not NO_MATCH', () => {
    const result = categorizeComparison(baseInput({ hasTmdbMatch: false, tvmazeTier: 'NEEDS_REVIEW' }));
    expect(result.category).toBe('BOTH_UNCERTAIN');
  });

  it('prioritizes remake collision over anime numbering risk', () => {
    const result = categorizeComparison(baseInput({ closeCompetitorDetected: true, animeNumberingRiskDetected: true }));
    expect(result.category).toBe('POSSIBLE_REMAKE_COLLISION');
  });

  it('treats a structurally-proposed match as confident for TVMAZE_LOOKS_BETTER even when the real tier is NEEDS_REVIEW', () => {
    const result = categorizeComparison(baseInput({ hasTmdbMatch: false, tvmazeTier: 'NEEDS_REVIEW', structuralAutoMatchProposed: true }));
    expect(result.category).toBe('TVMAZE_LOOKS_BETTER');
  });

  it('treats a structurally-proposed match as confident for BOTH_AGREE even when the real tier is NEEDS_REVIEW', () => {
    const result = categorizeComparison(baseInput({ hasTmdbMatch: true, tvmazeTier: 'NEEDS_REVIEW', structuralAutoMatchProposed: true, mytvKnownEpisodeCount: 20, tvmazeRegularEpisodeCount: 20 }));
    expect(result.category).toBe('BOTH_AGREE');
  });

  it('does not treat NEEDS_REVIEW as confident when the structural rule was not proposed', () => {
    const result = categorizeComparison(baseInput({ hasTmdbMatch: false, tvmazeTier: 'NEEDS_REVIEW', structuralAutoMatchProposed: false }));
    expect(result.category).toBe('BOTH_UNCERTAIN');
  });
});

describe('computeNextEpisodeComparison', () => {
  const episodes: TvMazeEpisodeForPositionLookup[] = [
    { season: 1, number: 1, name: 'Pilot', airdate: '2020-01-01' },
    { season: 1, number: 2, name: 'Second', airdate: '2020-01-08' },
    { season: 1, number: 3, name: 'Third', airdate: '2020-01-15' },
  ];

  it('picks the episode at chronological position watchedEpisodeCount', () => {
    const result = computeNextEpisodeComparison(episodes, 1, null);
    expect(result.tvmazeProposedNextEpisodeLabel).toBe('S1E2');
    expect(result.tvmazeProposedNextEpisodeTitle).toBe('Second');
  });

  it('reports no proposal when watched count reaches the end of the known catalog', () => {
    const result = computeNextEpisodeComparison(episodes, 3, null);
    expect(result.tvmazeProposedNextEpisodeLabel).toBeNull();
    expect(result.titlesComparable).toBe(false);
  });

  it('is inconclusive when MyTv has no next-episode title to compare', () => {
    const result = computeNextEpisodeComparison(episodes, 0, null);
    expect(result.titlesComparable).toBe(false);
    expect(result.titlesMatch).toBeNull();
  });

  it('matches titles case/whitespace-insensitively when both are available', () => {
    const result = computeNextEpisodeComparison(episodes, 0, '  pilot  ');
    expect(result.titlesComparable).toBe(true);
    expect(result.titlesMatch).toBe(true);
  });

  it('flags a mismatch when both titles are available but differ', () => {
    const result = computeNextEpisodeComparison(episodes, 0, 'Completely Different Episode');
    expect(result.titlesComparable).toBe(true);
    expect(result.titlesMatch).toBe(false);
  });
});
