import { classifyParity, ClassifyParityInput } from '../classify';

function baseInput(overrides: Partial<ClassifyParityInput> = {}): ClassifyParityInput {
  return {
    hasDbMatch: true,
    isAmbiguousMultipleMatch: false,
    isPossibleProviderMismatch: false,
    userStatus: 'WATCHING',
    hasTmdbMatch: true,
    hasProviderCandidate: false,
    dbEpisodeCount: 10,
    providerKnownEpisodeCount: 10,
    nextEpisodeId: 'episode-1',
    nextEpisodeAirDateIsFuture: false,
    ...overrides,
  };
}

describe('classifyParity', () => {
  it('is NOT_IN_TVTIME_EXPORT when there is no DB match at all', () => {
    const result = classifyParity(baseInput({ hasDbMatch: false }));
    expect(result.category).toBe('NOT_IN_TVTIME_EXPORT');
    expect(result.recommendedAction).toBe('SEARCH_ADD_NEEDED');
  });

  it('is TITLE_MISMATCH when multiple ambiguous DB matches exist', () => {
    const result = classifyParity(baseInput({ isAmbiguousMultipleMatch: true }));
    expect(result.category).toBe('TITLE_MISMATCH');
  });

  it('is POSSIBLE_PROVIDER_MISMATCH when flagged, even with other conditions true', () => {
    const result = classifyParity(baseInput({ isPossibleProviderMismatch: true, hasTmdbMatch: false }));
    expect(result.category).toBe('POSSIBLE_PROVIDER_MISMATCH');
  });

  it('is FOUND_BUT_STATUS_BLOCKED for a DROPPED series', () => {
    const result = classifyParity(baseInput({ userStatus: 'DROPPED' }));
    expect(result.category).toBe('FOUND_BUT_STATUS_BLOCKED');
    expect(result.recommendedAction).toBe('LEAVE_UNTOUCHED');
  });

  it('is FOUND_BUT_STATUS_BLOCKED for WATCHLIST/PAUSED/COMPLETED too', () => {
    for (const status of ['WATCHLIST', 'PAUSED', 'COMPLETED']) {
      expect(classifyParity(baseInput({ userStatus: status })).category).toBe('FOUND_BUT_STATUS_BLOCKED');
    }
  });

  it('is FOUND_WITH_INCOMPLETE_CATALOG when the provider knows more episodes than the DB has', () => {
    const result = classifyParity(baseInput({ dbEpisodeCount: 4, providerKnownEpisodeCount: 10, hasTmdbMatch: false }));
    expect(result.category).toBe('FOUND_WITH_INCOMPLETE_CATALOG');
    expect(result.recommendedAction).toBe('SAFE_TARGETED_ENRICHMENT');
  });

  it('recommends manual mapping for incomplete catalog if already (wrongly?) enriched', () => {
    const result = classifyParity(baseInput({ dbEpisodeCount: 4, providerKnownEpisodeCount: 10, hasTmdbMatch: true }));
    expect(result.category).toBe('FOUND_WITH_INCOMPLETE_CATALOG');
    expect(result.recommendedAction).toBe('MANUAL_PROVIDER_MAPPING');
  });

  it('is NEEDS_PROVIDER_MATCH when unenriched but a candidate is on file', () => {
    const result = classifyParity(baseInput({ hasTmdbMatch: false, hasProviderCandidate: true, providerKnownEpisodeCount: 10, dbEpisodeCount: 10 }));
    expect(result.category).toBe('NEEDS_PROVIDER_MATCH');
  });

  it('is FOUND_UNENRICHED when unenriched with no candidate at all', () => {
    const result = classifyParity(baseInput({ hasTmdbMatch: false, hasProviderCandidate: false, providerKnownEpisodeCount: null }));
    expect(result.category).toBe('FOUND_UNENRICHED');
  });

  it('is FOUND_BUT_NO_NEXT_EPISODE when enriched but nextEpisodeId is null while active', () => {
    const result = classifyParity(baseInput({ nextEpisodeId: null }));
    expect(result.category).toBe('FOUND_BUT_NO_NEXT_EPISODE');
  });

  it('is FOUND_BUT_AIRDATE_FILTERED when the next episode has a future airDate', () => {
    const result = classifyParity(baseInput({ nextEpisodeAirDateIsFuture: true }));
    expect(result.category).toBe('FOUND_BUT_AIRDATE_FILTERED');
  });

  it('is FOUND_ENRICHED when everything resolves cleanly', () => {
    const result = classifyParity(baseInput());
    expect(result.category).toBe('FOUND_ENRICHED');
    expect(result.recommendedAction).toBe('ALREADY_OK');
  });

  it('prioritizes ambiguous-match over status-blocked', () => {
    const result = classifyParity(baseInput({ isAmbiguousMultipleMatch: true, userStatus: 'DROPPED' }));
    expect(result.category).toBe('TITLE_MISMATCH');
  });
});
