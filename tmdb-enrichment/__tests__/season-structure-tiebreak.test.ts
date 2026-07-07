import {
  buildSeasonShape,
  isSeasonCollapsePattern,
  sameTotalEpisodeCountTieBreaker,
  scoreCandidateSeasonStructure,
  seasonCountDistance,
  seasonDistributionSimilarity,
  TieBreakCandidateInput,
  totalEpisodeCountMatch,
} from '../season-structure-tiebreak';

function candidate(overrides: Partial<TieBreakCandidateInput> & Pick<TieBreakCandidateInput, 'candidateId' | 'shape'>): TieBreakCandidateInput {
  return {
    candidateLabel: overrides.candidateId,
    candidateTitle: 'Some Show',
    hasStrongTitleYearNetworkMismatch: false,
    animeNumberingRiskDetected: false,
    baseConfidenceScore: 80,
    ...overrides,
  };
}

describe('totalEpisodeCountMatch', () => {
  it('is true only when totals are exactly equal', () => {
    expect(totalEpisodeCountMatch(24, 24)).toBe(true);
    expect(totalEpisodeCountMatch(24, 23)).toBe(false);
  });
});

describe('seasonCountDistance', () => {
  it('returns the absolute difference', () => {
    expect(seasonCountDistance(3, 1)).toBe(2);
    expect(seasonCountDistance(1, 3)).toBe(2);
    expect(seasonCountDistance(2, 2)).toBe(0);
  });
});

describe('seasonDistributionSimilarity', () => {
  it('is 1 for an identical distribution', () => {
    expect(seasonDistributionSimilarity([12, 12], [12, 12])).toBe(1);
  });

  it('is lower for a collapsed single-season candidate covering the same total', () => {
    const similarity = seasonDistributionSimilarity([12, 12], [24]);
    expect(similarity).toBeLessThan(1);
    expect(similarity).toBeGreaterThanOrEqual(0);
  });

  it('is 1 for two empty/equal-length-zero distributions', () => {
    expect(seasonDistributionSimilarity([], [])).toBe(1);
  });

  it('is bounded within [0, 1]', () => {
    const similarity = seasonDistributionSimilarity([1], [1000]);
    expect(similarity).toBeGreaterThanOrEqual(0);
    expect(similarity).toBeLessThanOrEqual(1);
  });
});

describe('isSeasonCollapsePattern', () => {
  it('detects a many-local-seasons-into-one-or-zero-candidate-seasons collapse', () => {
    expect(isSeasonCollapsePattern(3, 1)).toBe(true);
    expect(isSeasonCollapsePattern(2, 1)).toBe(true);
  });

  it('does not flag when candidate has more than one season', () => {
    expect(isSeasonCollapsePattern(3, 2)).toBe(false);
  });

  it('does not flag when local itself only has one season', () => {
    expect(isSeasonCollapsePattern(1, 1)).toBe(false);
  });
});

describe('scoreCandidateSeasonStructure', () => {
  it('gives the maximum score for an exact match on every dimension', () => {
    const local = buildSeasonShape([12, 12]);
    const result = scoreCandidateSeasonStructure(local, buildSeasonShape([12, 12]));
    expect(result.totalEpisodeCountMatches).toBe(true);
    expect(result.seasonCountDistance).toBe(0);
    expect(result.seasonDistributionSimilarity).toBe(1);
    expect(result.collapsePatternDetected).toBe(false);
    expect(result.seasonStructureScore).toBe(100);
  });

  it('scores lower and flags collapse for a single-season candidate matching only the total', () => {
    const local = buildSeasonShape([12, 12]);
    const result = scoreCandidateSeasonStructure(local, buildSeasonShape([24]));
    expect(result.totalEpisodeCountMatches).toBe(true);
    expect(result.seasonCountDistance).toBe(1);
    expect(result.collapsePatternDetected).toBe(true);
    expect(result.seasonStructureScore).toBeLessThan(100);
    expect(result.seasonStructureReason).toMatch(/collapses/);
  });

  it('scores 0 for the total-match component when totals differ', () => {
    const local = buildSeasonShape([12, 12]);
    const result = scoreCandidateSeasonStructure(local, buildSeasonShape([10, 10]));
    expect(result.totalEpisodeCountMatches).toBe(false);
    expect(result.seasonStructureScore).toBeLessThan(60);
  });
});

describe('sameTotalEpisodeCountTieBreaker — applicability', () => {
  it('is NOT_APPLICABLE with fewer than 2 same-total candidates', () => {
    const local = buildSeasonShape([12, 12]);
    const result = sameTotalEpisodeCountTieBreaker(local, [candidate({ candidateId: 'a', shape: buildSeasonShape([12, 12]) })]);
    expect(result.applicable).toBe(false);
    expect(result.classification).toBe('NOT_APPLICABLE');
    expect(result.preferredCandidateId).toBeNull();
  });

  it('ignores candidates whose total episode count does not match local when counting applicability', () => {
    const local = buildSeasonShape([12, 12]);
    const result = sameTotalEpisodeCountTieBreaker(local, [
      candidate({ candidateId: 'right-total', shape: buildSeasonShape([12, 12]) }),
      candidate({ candidateId: 'wrong-total', shape: buildSeasonShape([10, 10]) }),
    ]);
    expect(result.applicable).toBe(false);
    expect(result.classification).toBe('NOT_APPLICABLE');
  });
});

// Task's three worked examples, reproduced as-is.
describe('sameTotalEpisodeCountTieBreaker — worked examples from the task', () => {
  it('example 1: local 2 seasons/24 episodes — prefers the 2-season candidate over the 1-season candidate', () => {
    const local = buildSeasonShape([12, 12]);
    const result = sameTotalEpisodeCountTieBreaker(local, [
      candidate({ candidateId: 'A', candidateLabel: 'Candidate A (1 season)', shape: buildSeasonShape([24]) }),
      candidate({ candidateId: 'B', candidateLabel: 'Candidate B (2 seasons)', shape: buildSeasonShape([12, 12]) }),
    ]);
    expect(result.classification).toBe('SAFE_CANDIDATE_HIGH_CONFIDENCE');
    expect(result.preferredCandidateId).toBe('B');
  });

  it('example 2: local 3 seasons/64 episodes — prefers the 3-season candidate over the 1-season candidate', () => {
    const local = buildSeasonShape([24, 23, 17]);
    const result = sameTotalEpisodeCountTieBreaker(local, [
      candidate({ candidateId: 'A', shape: buildSeasonShape([64]) }),
      candidate({ candidateId: 'B', shape: buildSeasonShape([24, 23, 17]) }),
    ]);
    expect(result.classification).toBe('SAFE_CANDIDATE_HIGH_CONFIDENCE');
    expect(result.preferredCandidateId).toBe('B');
  });

  it('example 3: does not blindly choose the better-structured candidate when it has a title/year/network mismatch — flags for manual confirmation instead', () => {
    const local = buildSeasonShape([12, 12]);
    const result = sameTotalEpisodeCountTieBreaker(local, [
      candidate({ candidateId: 'A', shape: buildSeasonShape([12, 12]), hasStrongTitleYearNetworkMismatch: true }),
      candidate({ candidateId: 'B', shape: buildSeasonShape([24]) }), // exact title/year/network (clean), but worse season structure
    ]);
    expect(result.classification).toBe('NEEDS_MANUAL_CONFIRMATION');
    expect(result.preferredCandidateId).toBeNull();
    const a = result.candidates.find((c) => c.candidateId === 'A')!;
    expect(a.eligibleForPreference).toBe(false);
    expect(a.ineligibilityReason).toMatch(/mismatch/);
  });
});

describe('sameTotalEpisodeCountTieBreaker — task test scenario 1: closer season count wins', () => {
  it('prefers and auto-selects the candidate whose season count matches local exactly over one that is merely close, when both are otherwise eligible', () => {
    const local = buildSeasonShape([7, 7, 8, 8]); // 4 seasons, 30 total
    const result = sameTotalEpisodeCountTieBreaker(local, [
      candidate({ candidateId: 'close', shape: buildSeasonShape([10, 10, 10]) }), // 3 seasons, distance 1 — not a collapse (3 > 1)
      candidate({ candidateId: 'exact', shape: buildSeasonShape([7, 7, 8, 8]) }), // 4 seasons, distance 0
    ]);

    const close = result.candidates.find((c) => c.candidateId === 'close')!;
    const exact = result.candidates.find((c) => c.candidateId === 'exact')!;
    expect(close.eligibleForPreference).toBe(true); // both are legitimately in the running
    expect(exact.eligibleForPreference).toBe(true);
    expect(exact.seasonCountDistance).toBeLessThan(close.seasonCountDistance);

    expect(result.classification).toBe('SAFE_CANDIDATE_HIGH_CONFIDENCE');
    expect(result.preferredCandidateId).toBe('exact');
    expect(result.candidates[0].candidateId).toBe('exact');
  });

  it('leaves an unresolved-but-eligible near-miss candidate for manual confirmation when no candidate is an exact match', () => {
    const local = buildSeasonShape([10, 10, 10]); // 3 seasons, 30 total
    const result = sameTotalEpisodeCountTieBreaker(local, [
      candidate({ candidateId: 'far', shape: buildSeasonShape([30]) }), // 1 season, distance 2 — collapse
      candidate({ candidateId: 'close', shape: buildSeasonShape([15, 15]) }), // 2 seasons, distance 1
    ]);
    expect(result.candidates.find((c) => c.candidateId === 'far')!.eligibleForPreference).toBe(false);
    expect(result.classification).toBe('NEEDS_MANUAL_CONFIRMATION'); // "close" doesn't clear the exact-season-count bar
    const close = result.candidates.find((c) => c.candidateId === 'close')!;
    expect(close.eligibleForPreference).toBe(true);
    expect(close.seasonCountDistance).toBe(1);
  });
});

describe('sameTotalEpisodeCountTieBreaker — task test scenario 2: more seasons wins only as a tie-break', () => {
  it('ranks the candidate with more seasons first when both are equally close, but still requires manual confirmation (neither is an exact match)', () => {
    const local = buildSeasonShape([10, 10, 10]); // 3 seasons
    const result = sameTotalEpisodeCountTieBreaker(local, [
      candidate({ candidateId: 'fewer', shape: buildSeasonShape([15, 15]) }), // 2 seasons, distance 1
      candidate({ candidateId: 'more', shape: buildSeasonShape([7, 8, 7, 8]) }), // 4 seasons, distance 1
    ]);

    // Both are equally close (distance 1) — "more" wins the ranking via the season-count tie-break rule.
    expect(result.candidates[0].candidateId).toBe('more');
    // But an inexact season count never alone reaches high confidence.
    expect(result.classification).toBe('NEEDS_MANUAL_CONFIRMATION');
    expect(result.preferredCandidateId).toBeNull();
  });
});

describe('sameTotalEpisodeCountTieBreaker — wrong title/year is never overridden by season structure', () => {
  it('keeps a mismatched candidate ineligible even with a perfect season-structure match', () => {
    const local = buildSeasonShape([12, 12]);
    const result = sameTotalEpisodeCountTieBreaker(local, [
      candidate({ candidateId: 'perfect-structure-wrong-identity', shape: buildSeasonShape([12, 12]), hasStrongTitleYearNetworkMismatch: true }),
      candidate({ candidateId: 'clean-identity-ok-structure', shape: buildSeasonShape([13, 11]) }),
    ]);
    const mismatched = result.candidates.find((c) => c.candidateId === 'perfect-structure-wrong-identity')!;
    expect(mismatched.eligibleForPreference).toBe(false);
    expect(result.preferredCandidateId).not.toBe('perfect-structure-wrong-identity');
  });
});

describe('sameTotalEpisodeCountTieBreaker — known risk-list titles are never promoted', () => {
  it('keeps a risk-listed title ineligible even with a perfect season-structure match', () => {
    const local = buildSeasonShape([2, 34]); // arbitrary shape, unrelated to the real Kaiju No. 8 catalog — this test only cares about the risk-list gate
    const result = sameTotalEpisodeCountTieBreaker(local, [
      candidate({ candidateId: 'risky', candidateTitle: 'Kaiju No. 8', shape: buildSeasonShape([2, 34]) }), // real title from PROVIDER_STRUCTURE_MISMATCH_TITLES
      candidate({ candidateId: 'ordinary', shape: buildSeasonShape([10, 26]) }),
    ]);
    const risky = result.candidates.find((c) => c.candidateId === 'risky')!;
    expect(risky.isRiskListedTitle).toBe(true);
    expect(risky.eligibleForPreference).toBe(false);
    expect(risky.ineligibilityReason).toMatch(/risk list/);
    expect(result.preferredCandidateId).not.toBe('risky');
  });
});

describe('sameTotalEpisodeCountTieBreaker — season collapse pattern is flagged as risk/manual review', () => {
  it('flags a collapsing candidate as ineligible and requires manual confirmation when it is the only structurally-close option', () => {
    const local = buildSeasonShape([12, 12]); // 2 seasons
    const result = sameTotalEpisodeCountTieBreaker(local, [
      candidate({ candidateId: 'collapsed', shape: buildSeasonShape([24]) }), // 1 season — collapse
      candidate({ candidateId: 'other', shape: buildSeasonShape([20, 4]) }), // 2 seasons but lopsided distribution
    ]);
    const collapsed = result.candidates.find((c) => c.candidateId === 'collapsed')!;
    expect(collapsed.collapsePatternDetected).toBe(true);
    expect(collapsed.eligibleForPreference).toBe(false);
    expect(collapsed.ineligibilityReason).toMatch(/collapse/);
  });
});

describe('sameTotalEpisodeCountTieBreaker — anime-numbering risk requires an exact season-count match to be promoted', () => {
  it('does not promote an anime-flagged candidate whose season count is only close, not exact', () => {
    const local = buildSeasonShape([10, 10, 10]);
    const result = sameTotalEpisodeCountTieBreaker(local, [
      candidate({ candidateId: 'anime-close', shape: buildSeasonShape([15, 15]), animeNumberingRiskDetected: true }),
      candidate({ candidateId: 'padding', shape: buildSeasonShape([1, 1, 28]) }),
    ]);
    const animeClose = result.candidates.find((c) => c.candidateId === 'anime-close')!;
    expect(animeClose.eligibleForPreference).toBe(false);
    expect(animeClose.ineligibilityReason).toMatch(/anime\/absolute-numbering/);
  });

  it('promotes an anime-flagged candidate when the season count matches exactly and every other gate is clean', () => {
    const local = buildSeasonShape([12, 12]);
    const result = sameTotalEpisodeCountTieBreaker(local, [
      candidate({ candidateId: 'anime-exact', shape: buildSeasonShape([12, 12]), animeNumberingRiskDetected: true }),
      candidate({ candidateId: 'other', shape: buildSeasonShape([16, 8]) }),
    ]);
    const animeExact = result.candidates.find((c) => c.candidateId === 'anime-exact')!;
    expect(animeExact.eligibleForPreference).toBe(true);
    expect(result.classification).toBe('SAFE_CANDIDATE_HIGH_CONFIDENCE');
    expect(result.preferredCandidateId).toBe('anime-exact');
  });
});

describe('sameTotalEpisodeCountTieBreaker — report fields', () => {
  it('includes localSeasonCount/providerSeasonCount/localEpisodeCount/providerEpisodeCount/seasonStructureScore/seasonStructureReason per candidate', () => {
    const local = buildSeasonShape([12, 12]);
    const result = sameTotalEpisodeCountTieBreaker(local, [
      candidate({ candidateId: 'A', shape: buildSeasonShape([24]) }),
      candidate({ candidateId: 'B', shape: buildSeasonShape([12, 12]) }),
    ]);
    for (const c of result.candidates) {
      expect(c).toHaveProperty('localSeasonCount', 2);
      expect(c).toHaveProperty('providerSeasonCount');
      expect(c).toHaveProperty('localEpisodeCount', 24);
      expect(c).toHaveProperty('providerEpisodeCount', 24);
      expect(typeof c.seasonStructureScore).toBe('number');
      expect(typeof c.seasonStructureReason).toBe('string');
    }
  });
});
