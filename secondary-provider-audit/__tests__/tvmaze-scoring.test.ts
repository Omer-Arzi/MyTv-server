import {
  decideTier,
  detectAnimeNumberingRisk,
  detectCloseCompetitor,
  evaluateStructuralAutoMatch,
  extractTitleYearHint,
  scoreCandidates,
  StructuralAutoMatchInput,
} from '../tvmaze-scoring';
import { TvMazeSearchResult } from '../tvmaze-types';

function result(id: number, name: string, premiered: string | null, score: number): TvMazeSearchResult {
  return { score, show: { id, name, premiered, ended: null, status: 'Ended', genres: [], language: 'English' } };
}

describe('scoreCandidates', () => {
  it('gives an exact title + exact year match the highest score', () => {
    const hint = extractTitleYearHint('Breaking Bad');
    const scored = scoreCandidates(hint, [result(1, 'Breaking Bad', '2008-01-20', 10)]);
    expect(scored[0].breakdown.titleMatchType).toBe('exact');
    expect(scored[0].breakdown.yearMatchType).toBe('unknown');
    expect(scored[0].breakdown.totalScore).toBeGreaterThanOrEqual(50);
  });

  it('scores a year hint match as exact when both years agree', () => {
    const hint = extractTitleYearHint('Doctor Who (2005)');
    const scored = scoreCandidates(hint, [result(1, 'Doctor Who', '2005-03-26', 10)]);
    expect(scored[0].breakdown.yearMatchType).toBe('exact');
  });

  it('normalizes tvmazeRelevanceScore relative to the top raw score in the result set', () => {
    const hint = extractTitleYearHint('Show');
    const scored = scoreCandidates(hint, [result(1, 'Show', null, 10), result(2, 'Show Two', null, 5)]);
    expect(scored[0].breakdown.tvmazeRelevanceScore).toBe(20);
    expect(scored[1].breakdown.tvmazeRelevanceScore).toBe(10);
  });

  it('treats a spacing-only difference as exact ("DAN DA DAN" vs "Dandadan")', () => {
    const hint = extractTitleYearHint('DAN DA DAN');
    const scored = scoreCandidates(hint, [result(1, 'Dandadan', '2024-10-04', 5)]);
    expect(scored[0].breakdown.titleMatchType).toBe('exact');
    expect(scored[0].breakdown.titleScore).toBe(50);
  });

  it('treats a colon/hyphen-only difference as exact', () => {
    const hint = extractTitleYearHint('Attack on Titan: Junior High');
    const scored = scoreCandidates(hint, [result(1, 'Attack on Titan - Junior High', null, 5)]);
    expect(scored[0].breakdown.titleMatchType).toBe('exact');
  });

  it('treats an apostrophe-only difference as exact', () => {
    const hint = extractTitleYearHint("Marvel's Daredevil");
    const scored = scoreCandidates(hint, [result(1, 'Marvels Daredevil', null, 5)]);
    expect(scored[0].breakdown.titleMatchType).toBe('exact');
  });

  it('does not treat a genuinely different title as exact just because it is short/similar', () => {
    const hint = extractTitleYearHint('One Piece');
    const scored = scoreCandidates(hint, [result(1, 'One Peace', null, 5)]);
    expect(scored[0].breakdown.titleMatchType).not.toBe('exact');
  });

  it('returns an empty array for zero results', () => {
    expect(scoreCandidates(extractTitleYearHint('Anything'), [])).toEqual([]);
  });
});

describe('decideTier', () => {
  it('is NO_MATCH when there are no candidates', () => {
    expect(decideTier([]).tier).toBe('NO_MATCH');
  });

  it('is AUTO_MATCH for a high score with a clear gap', () => {
    const hint = extractTitleYearHint('Breaking Bad (2008)');
    const scored = scoreCandidates(hint, [result(1, 'Breaking Bad', '2008-01-20', 10), result(2, 'Something Else', '1999-01-01', 1)]);
    expect(decideTier(scored).tier).toBe('AUTO_MATCH');
  });

  it('is NEEDS_REVIEW when the top score is high but ambiguous', () => {
    const hint = extractTitleYearHint('One Piece');
    const scored = scoreCandidates(hint, [result(1, 'One Piece', '2023-08-31', 10), result(2, 'One Piece', '1999-10-20', 9.9)]);
    expect(decideTier(scored).tier).toBe('NEEDS_REVIEW');
  });

  it('is NO_MATCH when the top score is too low', () => {
    const hint = extractTitleYearHint('Completely Unrelated Title');
    const scored = scoreCandidates(hint, [result(1, 'Nothing Alike', '1980-01-01', 1)]);
    expect(decideTier(scored).tier).toBe('NO_MATCH');
  });
});

describe('detectAnimeNumberingRisk', () => {
  it('is true for a long-running show tagged Anime', () => {
    expect(detectAnimeNumberingRisk({ watchedEpisodeCount: 220, tvmazeEpisodeCount: 220, genres: ['Action', 'Anime'] })).toBe(true);
  });

  it('is false for a long-running show not tagged Anime', () => {
    expect(detectAnimeNumberingRisk({ watchedEpisodeCount: 220, tvmazeEpisodeCount: 220, genres: ['Drama'] })).toBe(false);
  });

  it('is false for a short anime-tagged show (not long-running)', () => {
    expect(detectAnimeNumberingRisk({ watchedEpisodeCount: 12, tvmazeEpisodeCount: 12, genres: ['Anime'] })).toBe(false);
  });
});

describe('detectCloseCompetitor', () => {
  const top = { tvmazeId: 1, tvmazeTitle: 'One Piece', tvmazeYear: 2023, confidenceScore: 91 };

  it('detects a same-title-different-year competitor', () => {
    const other = { tvmazeId: 2, tvmazeTitle: 'One Piece', tvmazeYear: 1999, confidenceScore: 90 };
    const result = detectCloseCompetitor(top, [other]);
    expect(result.detected).toBe(true);
    expect(result.kind).toBe('same_title_different_year');
  });

  it('does not flag a clearly-lower-scoring, differently-titled competitor', () => {
    const other = { tvmazeId: 3, tvmazeTitle: 'Something Unrelated', tvmazeYear: 2010, confidenceScore: 40 };
    expect(detectCloseCompetitor(top, [other]).detected).toBe(false);
  });

  it('returns not-detected when there are no other candidates', () => {
    expect(detectCloseCompetitor(top, []).detected).toBe(false);
  });
});

function structuralInput(overrides: Partial<StructuralAutoMatchInput> = {}): StructuralAutoMatchInput {
  return {
    tier: 'NEEDS_REVIEW',
    titleMatchType: 'exact',
    resultPosition: 0,
    watchedEpisodeCount: 20,
    tvmazeEpisodeCount: 20,
    animeNumberingRiskDetected: false,
    closeCompetitorDetected: false,
    ...overrides,
  };
}

describe('evaluateStructuralAutoMatch', () => {
  it('proposes AUTO_MATCH when every structural signal qualifies', () => {
    expect(evaluateStructuralAutoMatch(structuralInput()).proposedTier).toBe('AUTO_MATCH');
  });

  it('does not propose promotion when the tier is not NEEDS_REVIEW', () => {
    expect(evaluateStructuralAutoMatch(structuralInput({ tier: 'AUTO_MATCH' })).proposedTier).toBe('NEEDS_REVIEW');
    expect(evaluateStructuralAutoMatch(structuralInput({ tier: 'NO_MATCH' })).proposedTier).toBe('NEEDS_REVIEW');
  });

  it('does not propose promotion for a non-exact title match', () => {
    expect(evaluateStructuralAutoMatch(structuralInput({ titleMatchType: 'fuzzy' })).proposedTier).toBe('NEEDS_REVIEW');
  });

  it('does not propose promotion when the top candidate is not the first search result', () => {
    expect(evaluateStructuralAutoMatch(structuralInput({ resultPosition: 1 })).proposedTier).toBe('NEEDS_REVIEW');
  });

  it('does not propose promotion when watched count exceeds the known total', () => {
    expect(evaluateStructuralAutoMatch(structuralInput({ watchedEpisodeCount: 25, tvmazeEpisodeCount: 20 })).proposedTier).toBe('NEEDS_REVIEW');
  });

  it('does not propose promotion when still in progress (watched below known total)', () => {
    expect(evaluateStructuralAutoMatch(structuralInput({ watchedEpisodeCount: 10, tvmazeEpisodeCount: 20 })).proposedTier).toBe('NEEDS_REVIEW');
  });

  it('does not propose promotion when anime numbering risk is detected', () => {
    expect(evaluateStructuralAutoMatch(structuralInput({ animeNumberingRiskDetected: true })).proposedTier).toBe('NEEDS_REVIEW');
  });

  it('does not propose promotion when a close competitor is detected', () => {
    expect(evaluateStructuralAutoMatch(structuralInput({ closeCompetitorDetected: true })).proposedTier).toBe('NEEDS_REVIEW');
  });
});
