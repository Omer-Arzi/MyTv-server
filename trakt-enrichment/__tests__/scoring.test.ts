import { decideTier, extractTitleYearHint, scoreCandidates, titleSimilarity } from '../scoring';
import { TraktSearchResult } from '../trakt-types';

function result(title: string, year: number | null, score: number, trakt = 1): TraktSearchResult {
  return { score, type: 'show', show: { title, year, ids: { trakt, slug: title.toLowerCase(), tvdb: null, imdb: null, tmdb: null } } };
}

describe('extractTitleYearHint', () => {
  it('extracts a trailing (YYYY) as a year hint', () => {
    expect(extractTitleYearHint('Doctor Who (2005)')).toEqual({ bareTitle: 'Doctor Who', titleYear: 2005 });
  });

  it('leaves titles without a year suffix untouched', () => {
    expect(extractTitleYearHint('Futurama')).toEqual({ bareTitle: 'Futurama', titleYear: null });
  });
});

describe('titleSimilarity', () => {
  it('is 1 for identical (normalized) strings', () => {
    expect(titleSimilarity('One Piece', 'one   piece')).toBe(1);
  });

  it('is lower for very different strings', () => {
    expect(titleSimilarity('One Piece', 'Naruto')).toBeLessThan(0.5);
  });
});

describe('scoreCandidates', () => {
  it('gives an exact title + exact year match the maximum score', () => {
    const [best] = scoreCandidates({ bareTitle: 'Doctor Who', titleYear: 2005 }, [result('Doctor Who', 2005, 1000)]);

    expect(best.breakdown.titleMatchType).toBe('exact');
    expect(best.breakdown.titleScore).toBe(50);
    expect(best.breakdown.yearMatchType).toBe('exact');
    expect(best.breakdown.yearScore).toBe(30);
    expect(best.breakdown.traktRelevanceScore).toBe(20);
    expect(best.breakdown.totalScore).toBe(100);
  });

  it('does not penalize a missing year hint', () => {
    const [best] = scoreCandidates({ bareTitle: 'Futurama', titleYear: null }, [result('Futurama', 1999, 1000)]);

    expect(best.breakdown.yearMatchType).toBe('unknown');
    expect(best.breakdown.yearScore).toBe(10);
  });

  it('penalizes a year that is known and clearly wrong', () => {
    const [best] = scoreCandidates({ bareTitle: 'Doctor Who', titleYear: 2005 }, [result('Doctor Who', 2023, 1000)]);

    expect(best.breakdown.yearMatchType).toBe('mismatch');
    expect(best.breakdown.yearScore).toBe(0);
  });

  it('gives partial credit for a year off by one', () => {
    const [best] = scoreCandidates({ bareTitle: 'Some Show', titleYear: 2020 }, [result('Some Show', 2021, 1000)]);

    expect(best.breakdown.yearMatchType).toBe('close');
    expect(best.breakdown.yearScore).toBe(15);
  });

  it('ranks candidates by total score, highest first', () => {
    const scored = scoreCandidates({ bareTitle: 'Doctor Who', titleYear: 2005 }, [
      result('Doctor Who', 2023, 900, 1),
      result('Doctor Who', 2005, 1000, 2),
    ]);

    expect(scored[0].result.show.ids.trakt).toBe(2);
    expect(scored[0].breakdown.totalScore).toBeGreaterThan(scored[1].breakdown.totalScore);
  });

  it('normalizes trakt relevance to the top score within the result set, not an absolute scale', () => {
    const scored = scoreCandidates({ bareTitle: 'X', titleYear: null }, [result('X', null, 50), result('X', null, 25)]);

    expect(scored[0].breakdown.traktRelevanceScore).toBe(20);
    expect(scored[1].breakdown.traktRelevanceScore).toBe(10);
  });
});

describe('decideTier', () => {
  it('is NO_MATCH when there are no candidates', () => {
    expect(decideTier([]).tier).toBe('NO_MATCH');
  });

  it('is AUTO_MATCH for a high score with a clear gap to the runner-up', () => {
    const scored = scoreCandidates({ bareTitle: 'Doctor Who', titleYear: 2005 }, [
      result('Doctor Who', 2005, 1000, 1),
      result('Something Else', 1990, 100, 2),
    ]);

    expect(decideTier(scored).tier).toBe('AUTO_MATCH');
  });

  it('is NEEDS_REVIEW when the top score is high but a close second makes it ambiguous', () => {
    const scored = scoreCandidates({ bareTitle: 'Doctor Who', titleYear: null }, [
      result('Doctor Who', 2005, 1000, 1),
      result('Doctor Who', 2023, 999, 2),
    ]);

    expect(decideTier(scored).tier).toBe('NEEDS_REVIEW');
  });

  it('is NEEDS_REVIEW for a moderate, non-ambiguous score', () => {
    const scored = scoreCandidates({ bareTitle: 'Some Show', titleYear: null }, [result('Some Show Special Edition', null, 500)]);

    const decision = decideTier(scored);
    expect(decision.tier === 'NEEDS_REVIEW' || decision.tier === 'NO_MATCH').toBe(true);
  });

  it('is NO_MATCH for a very poor top score', () => {
    const scored = scoreCandidates({ bareTitle: 'One Piece', titleYear: 2023 }, [result('Completely Different Show', 1980, 1000)]);

    expect(decideTier(scored).tier).toBe('NO_MATCH');
  });
});
