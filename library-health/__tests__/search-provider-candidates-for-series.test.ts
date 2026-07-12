// Regression coverage for the confidence-contract bug: a candidate's
// tmdb-enrichment/scoring.ts score (SearchedProviderCandidate.confidenceScore)
// is a RAW 0-100 value, but every consumer outside this module
// (ProviderCandidateDto, the mobile app, POST :seriesId/confirm-identity,
// ProviderIdentityDecision) must only ever see normalizedConfidence, the
// normalized 0..1 value. Confirmed real bug this reproduces: a candidate
// displayed as "80% confidence" sent confidence: 80 back to
// confirm-identity, which rejected it ("confidence must not be greater
// than 1") because it expected 0.8 — traced to the DTO mapper reading the
// wrong (raw, 0-100) field.

import { TmdbClient } from '../../tmdb-enrichment/tmdb-client';
import { normalizeConfidenceScore, searchProviderCandidatesForSeries } from '../search-provider-candidates-for-series';

describe('normalizeConfidenceScore', () => {
  it('converts the exact reported bug value: a raw score of 80 becomes 0.8', () => {
    expect(normalizeConfidenceScore(80)).toBe(0.8);
  });

  it('converts 0 to 0 and 100 to 1 (the full range boundaries)', () => {
    expect(normalizeConfidenceScore(0)).toBe(0);
    expect(normalizeConfidenceScore(100)).toBe(1);
  });

  it('converts the maximum possible real score (title 50 + year 30 + rank 20 = 100) to exactly 1', () => {
    expect(normalizeConfidenceScore(50 + 30 + 20)).toBe(1);
  });

  it('clamps defensively above 100 and below 0, even though scoreCandidates should never produce those', () => {
    expect(normalizeConfidenceScore(150)).toBe(1);
    expect(normalizeConfidenceScore(-10)).toBe(0);
  });
});

describe('searchProviderCandidatesForSeries — confidence contract', () => {
  function buildMockTmdb(): TmdbClient {
    return {
      searchTv: jest.fn().mockResolvedValue([{ id: 604, name: 'Teen Titans', first_air_date: '2003-07-19', poster_path: '/poster.jpg' }]),
      getShowDetails: jest.fn().mockResolvedValue({ id: 604, name: 'Teen Titans', number_of_seasons: 1, genres: [], original_language: 'en', origin_country: ['US'] }),
      getSeasonsBatch: jest.fn().mockResolvedValue({ 'season/1': { id: 1, season_number: 1, episodes: [{ id: 1, season_number: 1, episode_number: 1 }] } }),
    } as unknown as TmdbClient;
  }

  it('normalizedConfidence is always within 0..1 — this is the exact field/value the app must send back to confirm-identity', async () => {
    const result = await searchProviderCandidatesForSeries({
      tmdb: buildMockTmdb(),
      localTitle: 'Teen Titans',
      localEpisodesPerSeason: [65],
      watchedEpisodeCount: 65,
    });

    expect(result.candidates).toHaveLength(1);
    for (const candidate of result.candidates) {
      expect(candidate.normalizedConfidence).toBeLessThanOrEqual(1);
      expect(candidate.normalizedConfidence).toBeGreaterThanOrEqual(0);
    }
  });

  it('reproduces the real "80%" case exactly: exact title match + unknown year + top search position -> raw 80, normalized 0.8', async () => {
    // Exact title match (50) + unknown year, since localTitle carries no
    // year suffix (10) + rank position 0 (20) = 80 raw -> 0.8 normalized.
    const result = await searchProviderCandidatesForSeries({
      tmdb: buildMockTmdb(),
      localTitle: 'Teen Titans',
      localEpisodesPerSeason: [65],
      watchedEpisodeCount: 65,
    });

    expect(result.candidates[0].confidenceScore).toBe(80);
    expect(result.candidates[0].normalizedConfidence).toBe(0.8);
  });

  it('normalizedConfidence is always exactly confidenceScore/100 for every candidate returned', async () => {
    const result = await searchProviderCandidatesForSeries({
      tmdb: buildMockTmdb(),
      localTitle: 'Teen Titans',
      localEpisodesPerSeason: [65],
      watchedEpisodeCount: 65,
    });

    for (const candidate of result.candidates) {
      expect(candidate.normalizedConfidence).toBeCloseTo(candidate.confidenceScore / 100);
    }
  });
});
