import { buildSeasonShape, sameTotalEpisodeCountTieBreaker, scoreCandidateSeasonStructure, TieBreakCandidateInput } from '../../tmdb-enrichment/season-structure-tiebreak';
import { classifyMissingProviderSeries, ClassifyMissingProviderSeriesInput, MissingProviderCandidateSummary } from '../missing-provider-candidates-logic';

function candidate(overrides: Partial<MissingProviderCandidateSummary> & Pick<MissingProviderCandidateSummary, 'tmdbId'>): MissingProviderCandidateSummary {
  return {
    provider: 'tmdb',
    title: overrides.tmdbId,
    year: 2020,
    confidenceScore: 90,
    titleMatchType: 'exact',
    yearMatchType: 'exact',
    resultPosition: 0,
    providerSeasonShape: null,
    totalEpisodeCount: null,
    seasonStructureScore: null,
    seasonStructureReason: null,
    collapsePatternDetected: null,
    animeNumberingRiskDetected: false,
    warnings: [],
    ...overrides,
  };
}

function baseInput(overrides: Partial<ClassifyMissingProviderSeriesInput> = {}): ClassifyMissingProviderSeriesInput {
  return {
    localTitle: 'Some Ordinary Show',
    localSeasonShape: buildSeasonShape([12, 12]),
    watchedEpisodeCount: 20,
    topTier: 'AUTO_MATCH',
    candidates: [],
    closeCompetitorDetected: false,
    tieBreak: null,
    ...overrides,
  };
}

describe('classifyMissingProviderSeries — safety net: local risk-listed title', () => {
  it('classifies PROVIDER_STRUCTURE_RISK regardless of any candidate data', () => {
    const result = classifyMissingProviderSeries(
      baseInput({
        localTitle: 'Jujutsu Kaisen',
        candidates: [candidate({ tmdbId: 'a', providerSeasonShape: buildSeasonShape([12, 12]), seasonStructureScore: 100 })],
      }),
    );
    expect(result.classification).toBe('PROVIDER_STRUCTURE_RISK');
    expect(result.recommendedNextAction).toBe('MARK_AS_RISK');
    expect(result.recommendedCandidateTmdbId).toBeNull();
  });
});

describe('classifyMissingProviderSeries — no candidates / low confidence', () => {
  it('classifies NO_GOOD_MATCH when there are zero candidates', () => {
    const result = classifyMissingProviderSeries(baseInput({ candidates: [] }));
    expect(result.classification).toBe('NO_GOOD_MATCH');
    expect(result.recommendedNextAction).toBe('RUN_TARGETED_PROVIDER_AUDIT');
  });

  it('classifies SKIP_LOW_CONFIDENCE when the top tier is NO_MATCH', () => {
    const result = classifyMissingProviderSeries(
      baseInput({ topTier: 'NO_MATCH', candidates: [candidate({ tmdbId: 'a', confidenceScore: 20 })] }),
    );
    expect(result.classification).toBe('SKIP_LOW_CONFIDENCE');
    expect(result.recommendedNextAction).toBe('NO_ACTION');
  });
});

describe('classifyMissingProviderSeries — close competitor safety net', () => {
  it('classifies NEEDS_MANUAL_CONFIRMATION when a close competitor is detected, even with strong season structure', () => {
    const result = classifyMissingProviderSeries(
      baseInput({
        candidates: [
          candidate({ tmdbId: 'a', providerSeasonShape: buildSeasonShape([12, 12]), seasonStructureScore: 100 }),
          candidate({ tmdbId: 'b', providerSeasonShape: buildSeasonShape([12, 12]), seasonStructureScore: 100 }),
        ],
        closeCompetitorDetected: true,
      }),
    );
    expect(result.classification).toBe('NEEDS_MANUAL_CONFIRMATION');
    expect(result.recommendedNextAction).toBe('REVIEW_CANDIDATES_MANUALLY');
    expect(result.recommendedCandidateTmdbId).toBeNull();
  });
});

describe('classifyMissingProviderSeries — season-structure tie-break integration', () => {
  it('recommends the tie-break-preferred candidate when it is also a clean title/year match', () => {
    const local = buildSeasonShape([12, 12]);
    const a = candidate({ tmdbId: 'A', providerSeasonShape: buildSeasonShape([24]) });
    const b = candidate({ tmdbId: 'B', providerSeasonShape: buildSeasonShape([12, 12]) });
    const tieBreakInputs: TieBreakCandidateInput[] = [a, b].map((c) => ({
      candidateId: c.tmdbId,
      candidateLabel: c.title,
      candidateTitle: c.title,
      shape: c.providerSeasonShape!,
      hasStrongTitleYearNetworkMismatch: false,
      animeNumberingRiskDetected: false,
      baseConfidenceScore: c.confidenceScore,
    }));
    const tieBreak = sameTotalEpisodeCountTieBreaker(local, tieBreakInputs);
    expect(tieBreak.classification).toBe('SAFE_CANDIDATE_HIGH_CONFIDENCE'); // sanity check on the module under test's own behavior

    const result = classifyMissingProviderSeries(baseInput({ localSeasonShape: local, candidates: [b, a], tieBreak }));
    expect(result.classification).toBe('SAFE_CANDIDATE_HIGH_CONFIDENCE');
    expect(result.recommendedCandidateTmdbId).toBe('B');
    expect(result.recommendedNextAction).toBe('CONFIRM_PROVIDER_MATCH');
  });

  it('does not promote the tie-break winner when its title/year match is not clean', () => {
    const local = buildSeasonShape([12, 12]);
    const a = candidate({ tmdbId: 'A', providerSeasonShape: buildSeasonShape([24]) });
    const b = candidate({ tmdbId: 'B', providerSeasonShape: buildSeasonShape([12, 12]), titleMatchType: 'fuzzy' });
    const tieBreakInputs: TieBreakCandidateInput[] = [a, b].map((c) => ({
      candidateId: c.tmdbId,
      candidateLabel: c.title,
      candidateTitle: c.title,
      shape: c.providerSeasonShape!,
      hasStrongTitleYearNetworkMismatch: false,
      animeNumberingRiskDetected: false,
      baseConfidenceScore: c.confidenceScore,
    }));
    const tieBreak = sameTotalEpisodeCountTieBreaker(local, tieBreakInputs);
    expect(tieBreak.preferredCandidateId).toBe('B');

    const result = classifyMissingProviderSeries(baseInput({ localSeasonShape: local, candidates: [b, a], tieBreak }));
    expect(result.classification).toBe('NEEDS_MANUAL_CONFIRMATION');
    expect(result.recommendedCandidateTmdbId).toBeNull();
  });

  it('recommends NEEDS_ABSOLUTE_NUMBERING_PROVIDER when the tie-break is inconclusive and an anime/collapse signal is present', () => {
    const local = buildSeasonShape([10, 10, 10]);
    const a = candidate({ tmdbId: 'A', providerSeasonShape: buildSeasonShape([30]), animeNumberingRiskDetected: true, collapsePatternDetected: true });
    const b = candidate({ tmdbId: 'B', providerSeasonShape: buildSeasonShape([15, 15]) });
    const tieBreakInputs: TieBreakCandidateInput[] = [a, b].map((c) => ({
      candidateId: c.tmdbId,
      candidateLabel: c.title,
      candidateTitle: c.title,
      shape: c.providerSeasonShape!,
      hasStrongTitleYearNetworkMismatch: false,
      animeNumberingRiskDetected: c.animeNumberingRiskDetected,
      baseConfidenceScore: c.confidenceScore,
    }));
    const tieBreak = sameTotalEpisodeCountTieBreaker(local, tieBreakInputs);
    expect(tieBreak.classification).toBe('NEEDS_MANUAL_CONFIRMATION'); // neither clears the exact-match bar

    const result = classifyMissingProviderSeries(baseInput({ localSeasonShape: local, candidates: [a, b], tieBreak }));
    expect(result.classification).toBe('NEEDS_ABSOLUTE_NUMBERING_PROVIDER');
    expect(result.recommendedNextAction).toBe('WAIT_FOR_THETVDB');
  });
});

describe('classifyMissingProviderSeries — single-candidate fallback (no tie-break to run)', () => {
  it('classifies SAFE_CANDIDATE_HIGH_CONFIDENCE for a solo candidate with exact title/year, AUTO_MATCH tier, and a strong season structure score', () => {
    const local = buildSeasonShape([12, 12]);
    const shape = buildSeasonShape([12, 12]);
    const score = scoreCandidateSeasonStructure(local, shape);
    const result = classifyMissingProviderSeries(
      baseInput({
        localSeasonShape: local,
        topTier: 'AUTO_MATCH',
        candidates: [
          candidate({
            tmdbId: 'solo',
            providerSeasonShape: shape,
            seasonStructureScore: score.seasonStructureScore,
            seasonStructureReason: score.seasonStructureReason,
            collapsePatternDetected: score.collapsePatternDetected,
          }),
        ],
      }),
    );
    expect(result.classification).toBe('SAFE_CANDIDATE_HIGH_CONFIDENCE');
    expect(result.recommendedCandidateTmdbId).toBe('solo');
  });

  it('never auto-promotes a solo anime-numbering-flagged candidate, even with a perfect season-structure score', () => {
    const local = buildSeasonShape([12, 12]);
    const shape = buildSeasonShape([12, 12]);
    const result = classifyMissingProviderSeries(
      baseInput({
        localSeasonShape: local,
        candidates: [candidate({ tmdbId: 'solo', providerSeasonShape: shape, seasonStructureScore: 100, animeNumberingRiskDetected: true })],
      }),
    );
    expect(result.classification).toBe('NEEDS_ABSOLUTE_NUMBERING_PROVIDER');
    expect(result.recommendedNextAction).toBe('WAIT_FOR_THETVDB');
    expect(result.recommendedCandidateTmdbId).toBeNull();
  });

  it('never auto-promotes a solo candidate showing a collapse pattern', () => {
    const local = buildSeasonShape([12, 12]);
    const result = classifyMissingProviderSeries(
      baseInput({
        localSeasonShape: local,
        candidates: [candidate({ tmdbId: 'solo', providerSeasonShape: buildSeasonShape([24]), seasonStructureScore: 70, collapsePatternDetected: true })],
      }),
    );
    expect(result.classification).toBe('NEEDS_ABSOLUTE_NUMBERING_PROVIDER');
  });

  it('classifies NEEDS_MANUAL_CONFIRMATION for a solo candidate with only a NEEDS_REVIEW tier even if season structure looks fine', () => {
    const local = buildSeasonShape([12, 12]);
    const shape = buildSeasonShape([12, 12]);
    const result = classifyMissingProviderSeries(
      baseInput({
        localSeasonShape: local,
        topTier: 'NEEDS_REVIEW',
        candidates: [candidate({ tmdbId: 'solo', providerSeasonShape: shape, seasonStructureScore: 100 })],
      }),
    );
    expect(result.classification).toBe('NEEDS_MANUAL_CONFIRMATION');
  });

  it('classifies NEEDS_MANUAL_CONFIRMATION when no season data could be fetched for the top candidate', () => {
    const result = classifyMissingProviderSeries(baseInput({ candidates: [candidate({ tmdbId: 'solo', providerSeasonShape: null })] }));
    expect(result.classification).toBe('NEEDS_MANUAL_CONFIRMATION');
    expect(result.recommendedNextAction).toBe('REVIEW_CANDIDATES_MANUALLY');
  });
});
