import { validateSingleSeriesCandidate, SingleSeriesCandidateInput } from '../single-series-safety';

function baseInput(overrides: Partial<SingleSeriesCandidateInput> = {}): SingleSeriesCandidateInput {
  return {
    tier: 'NEEDS_REVIEW',
    closeCompetitorDetected: false,
    animeNumberingRiskDetected: false,
    isDataQualityFlagged: false,
    watchedEpisodeCount: 4,
    providerTotalEpisodeCount: 10,
    ...overrides,
  };
}

describe('validateSingleSeriesCandidate', () => {
  it('is safe for an in-progress series (watched < total) with no other red flags', () => {
    const result = validateSingleSeriesCandidate(baseInput());
    expect(result.safe).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('is safe for a fully-watched series too (watched === total)', () => {
    const result = validateSingleSeriesCandidate(baseInput({ watchedEpisodeCount: 10, providerTotalEpisodeCount: 10 }));
    expect(result.safe).toBe(true);
  });

  it('rejects a NO_MATCH tier', () => {
    const result = validateSingleSeriesCandidate(baseInput({ tier: 'NO_MATCH' }));
    expect(result.safe).toBe(false);
    expect(result.violations[0]).toMatch(/NO_MATCH/);
  });

  it('rejects a close competitor', () => {
    const result = validateSingleSeriesCandidate(baseInput({ closeCompetitorDetected: true }));
    expect(result.safe).toBe(false);
  });

  it('rejects anime numbering risk', () => {
    const result = validateSingleSeriesCandidate(baseInput({ animeNumberingRiskDetected: true }));
    expect(result.safe).toBe(false);
  });

  it('rejects a data-quality flagged candidate', () => {
    const result = validateSingleSeriesCandidate(baseInput({ isDataQualityFlagged: true }));
    expect(result.safe).toBe(false);
  });

  it('rejects an over-watched candidate (watched > total)', () => {
    const result = validateSingleSeriesCandidate(baseInput({ watchedEpisodeCount: 12, providerTotalEpisodeCount: 10 }));
    expect(result.safe).toBe(false);
    expect(result.violations[0]).toMatch(/exceeds/);
  });

  it('accumulates multiple violations rather than stopping at the first', () => {
    const result = validateSingleSeriesCandidate(baseInput({ tier: 'NO_MATCH', closeCompetitorDetected: true }));
    expect(result.violations.length).toBe(2);
  });
});
