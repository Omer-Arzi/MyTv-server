import { classifyForConfirmation, ClassifyForConfirmationInput, explainCandidateLikelihood, ProviderCandidateComparisonEntry } from '../provider-confirmation-logic';

function candidate(overrides: Partial<ProviderCandidateComparisonEntry> & Pick<ProviderCandidateComparisonEntry, 'provider' | 'id'>): ProviderCandidateComparisonEntry {
  return {
    title: overrides.id,
    yearOrPremiereDate: '2010-01-01',
    network: null,
    status: 'Ended',
    totalEpisodeCount: 100,
    seasonCount: 5,
    episodesPerSeason: [20, 20, 20, 20, 20],
    hasPoster: true,
    confidenceScore: 80,
    titleMatchType: 'exact',
    yearMatchType: 'unknown',
    seasonStructureScore: 80,
    seasonStructureReason: 'season structure looks fine',
    collapsePatternDetected: false,
    animeNumberingRiskDetected: false,
    watchedVsTotalGap: 0,
    warnings: [],
    likelyCorrectReason: 'exact title match',
    ...overrides,
  };
}

function baseInput(overrides: Partial<ClassifyForConfirmationInput> = {}): ClassifyForConfirmationInput {
  return {
    localTitle: 'Some Ordinary Show',
    isPriorityScope: true,
    watchedEpisodeCount: 100,
    tmdbCandidates: [],
    tvmazeCandidates: [],
    tmdbCloseCompetitorDetected: false,
    tvmazeCloseCompetitorDetected: false,
    ...overrides,
  };
}

describe('classifyForConfirmation — deferred / risk-listed safety nets', () => {
  it('classifies DEFER for a title outside the priority scope, regardless of candidate quality', () => {
    const result = classifyForConfirmation(
      baseInput({ isPriorityScope: false, tmdbCandidates: [candidate({ provider: 'tmdb', id: 'a', watchedVsTotalGap: 0 })] }),
    );
    expect(result.classification).toBe('DEFER');
    expect(result.recommendedNextAction).toBe('DEFER_HIGH_RISK');
    expect(result.recommendedCandidate).toBeNull();
  });

  it('classifies NEEDS_SPECIAL_PROVIDER_HANDLING for a risk-listed local title even with clean candidates', () => {
    const result = classifyForConfirmation(
      baseInput({ localTitle: 'Rurouni Kenshin', tmdbCandidates: [candidate({ provider: 'tmdb', id: 'a', watchedVsTotalGap: 0 })] }),
    );
    expect(result.classification).toBe('NEEDS_SPECIAL_PROVIDER_HANDLING');
    expect(result.recommendedNextAction).toBe('DEFER_HIGH_RISK');
  });
});

describe('classifyForConfirmation — no candidates', () => {
  it('classifies STILL_AMBIGUOUS with NO_GOOD_MATCH when neither provider found anything', () => {
    const result = classifyForConfirmation(baseInput());
    expect(result.classification).toBe('STILL_AMBIGUOUS');
    expect(result.recommendedNextAction).toBe('NO_GOOD_MATCH');
    expect(result.recommendedCandidate).toBeNull();
  });
});

describe('classifyForConfirmation — READY_FOR_HUMAN_CONFIRMATION', () => {
  it('recommends the TMDb candidate when it is clean and within the episode-count gap tolerance', () => {
    const result = classifyForConfirmation(
      baseInput({
        watchedEpisodeCount: 280,
        tmdbCandidates: [candidate({ provider: 'tmdb', id: 'a', watchedVsTotalGap: 1 })], // small gap, within tolerance
      }),
    );
    expect(result.classification).toBe('READY_FOR_HUMAN_CONFIRMATION');
    expect(result.recommendedNextAction).toBe('CONFIRM_TMDB_CANDIDATE');
    expect(result.recommendedCandidate).toEqual({ provider: 'tmdb', id: 'a' });
  });

  it('does not mark ready when the episode-count gap is large relative to watched count', () => {
    const result = classifyForConfirmation(
      baseInput({
        watchedEpisodeCount: 195,
        tmdbCandidates: [candidate({ provider: 'tmdb', id: 'a', watchedVsTotalGap: 9 })], // ~4.6%, over the ~3% tolerance
      }),
    );
    expect(result.classification).not.toBe('READY_FOR_HUMAN_CONFIRMATION');
  });

  it('does not mark ready when the title match is not exact', () => {
    const result = classifyForConfirmation(
      baseInput({ tmdbCandidates: [candidate({ provider: 'tmdb', id: 'a', titleMatchType: 'substring', watchedVsTotalGap: 0 })] }),
    );
    expect(result.classification).not.toBe('READY_FOR_HUMAN_CONFIRMATION');
  });
});

describe('classifyForConfirmation — TVmaze preferred over TMDb', () => {
  it('recommends TVmaze when its candidate is clean but TMDb is not', () => {
    const result = classifyForConfirmation(
      baseInput({
        tmdbCandidates: [candidate({ provider: 'tmdb', id: 'tmdb-a', titleMatchType: 'fuzzy', watchedVsTotalGap: 0 })],
        tvmazeCandidates: [candidate({ provider: 'tvmaze', id: 'tvmaze-a', titleMatchType: 'exact', watchedVsTotalGap: 0 })],
      }),
    );
    expect(result.classification).toBe('NEEDS_TVMAZE_OVER_TMDB');
    expect(result.recommendedNextAction).toBe('CONFIRM_TVMAZE_CANDIDATE');
    expect(result.recommendedCandidate).toEqual({ provider: 'tvmaze', id: 'tvmaze-a' });
  });

  it('still prefers TMDb when both are clean (TMDb checked first)', () => {
    const result = classifyForConfirmation(
      baseInput({
        tmdbCandidates: [candidate({ provider: 'tmdb', id: 'tmdb-a', watchedVsTotalGap: 0 })],
        tvmazeCandidates: [candidate({ provider: 'tvmaze', id: 'tvmaze-a', watchedVsTotalGap: 0 })],
      }),
    );
    expect(result.classification).toBe('READY_FOR_HUMAN_CONFIRMATION');
    expect(result.recommendedCandidate).toEqual({ provider: 'tmdb', id: 'tmdb-a' });
  });
});

describe('classifyForConfirmation — anime/collapse safety net', () => {
  it('classifies NEEDS_SPECIAL_PROVIDER_HANDLING when the TOP candidate on a provider shows a collapse pattern', () => {
    const result = classifyForConfirmation(baseInput({ tmdbCandidates: [candidate({ provider: 'tmdb', id: 'a', collapsePatternDetected: true })] }));
    expect(result.classification).toBe('NEEDS_SPECIAL_PROVIDER_HANDLING');
    expect(result.recommendedNextAction).toBe('DEFER_HIGH_RISK');
  });

  it('does NOT trigger special handling when only a lower-ranked, irrelevant candidate shows a collapse pattern — a real, unrelated same-titled show should not veto a clean top match', () => {
    // Real finding this test reproduces: TVmaze's 2nd-ranked "Friends"
    // (1979, an unrelated 5-episode show) collapses trivially against
    // local, while the 1st-ranked "Friends" (1994) was a perfect gap-0
    // match. The collapse on the irrelevant candidate must not mislabel the
    // clean top match as an anime/absolute-numbering risk.
    const result = classifyForConfirmation(
      baseInput({
        tmdbCandidates: [
          candidate({ provider: 'tmdb', id: 'a', watchedVsTotalGap: 0 }), // clean top candidate
          candidate({ provider: 'tmdb', id: 'b', collapsePatternDetected: true }), // irrelevant, lower-ranked
        ],
      }),
    );
    expect(result.classification).toBe('READY_FOR_HUMAN_CONFIRMATION');
    expect(result.recommendedCandidate).toEqual({ provider: 'tmdb', id: 'a' });
  });

  it('never promotes a candidate flagged for anime-numbering risk to READY_FOR_HUMAN_CONFIRMATION', () => {
    const result = classifyForConfirmation(
      baseInput({ tmdbCandidates: [candidate({ provider: 'tmdb', id: 'a', animeNumberingRiskDetected: true, watchedVsTotalGap: 0 })] }),
    );
    expect(result.classification).not.toBe('READY_FOR_HUMAN_CONFIRMATION');
  });
});

describe('classifyForConfirmation — close competitor', () => {
  it('classifies STILL_AMBIGUOUS with CHOOSE_BETWEEN_CANDIDATES when a close competitor is detected', () => {
    const result = classifyForConfirmation(
      baseInput({
        tmdbCandidates: [candidate({ provider: 'tmdb', id: 'a', watchedVsTotalGap: 0 }), candidate({ provider: 'tmdb', id: 'b', watchedVsTotalGap: 0 })],
        tmdbCloseCompetitorDetected: true,
      }),
    );
    expect(result.classification).toBe('STILL_AMBIGUOUS');
    expect(result.recommendedNextAction).toBe('CHOOSE_BETWEEN_CANDIDATES');
    expect(result.recommendedCandidate).toBeNull();
  });
});

describe('classifyForConfirmation — single imperfect candidate fallback', () => {
  it('still recommends the best single candidate under STILL_AMBIGUOUS when nothing clears every gate', () => {
    const result = classifyForConfirmation(
      baseInput({ watchedEpisodeCount: 195, tmdbCandidates: [candidate({ provider: 'tmdb', id: 'only', watchedVsTotalGap: 9 })] }),
    );
    expect(result.classification).toBe('STILL_AMBIGUOUS');
    expect(result.recommendedNextAction).toBe('CONFIRM_TMDB_CANDIDATE');
    expect(result.recommendedCandidate).toEqual({ provider: 'tmdb', id: 'only' });
  });
});

describe('explainCandidateLikelihood', () => {
  it('describes an exact, clean match concisely', () => {
    const text = explainCandidateLikelihood({ titleMatchType: 'exact', yearMatchType: 'exact', watchedVsTotalGap: 0, collapsePatternDetected: false, animeNumberingRiskDetected: false });
    expect(text).toMatch(/exact title match/);
    expect(text).toMatch(/covers everything watched/);
  });

  it('flags a positive gap and a collapse pattern', () => {
    const text = explainCandidateLikelihood({ titleMatchType: 'fuzzy', yearMatchType: 'mismatch', watchedVsTotalGap: 5, collapsePatternDetected: true, animeNumberingRiskDetected: true });
    expect(text).toMatch(/fuzzy title match/);
    expect(text).toMatch(/year does not match/);
    expect(text).toMatch(/5 more episode/);
    expect(text).toMatch(/collapse pattern/);
    expect(text).toMatch(/anime\/absolute-numbering/);
  });
});
