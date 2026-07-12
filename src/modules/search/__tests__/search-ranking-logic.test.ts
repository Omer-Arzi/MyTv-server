import { UserSeriesStatus } from '@prisma/client';
import { computeRelevanceScore, rankSearchResults } from '../search-ranking-logic';
import { SeriesSearchResult } from '../search-types';

function result(overrides: Partial<SeriesSearchResult> = {}): SeriesSearchResult {
  return {
    resultKey: overrides.resultKey ?? overrides.title ?? 'k',
    title: 'Frieren',
    year: 2023,
    posterUrl: null,
    providers: [{ provider: 'tmdb', providerId: '1' }],
    libraryMatch: { type: 'NONE' },
    primaryAction: 'ADD_TO_WATCHLIST',
    relevanceScore: 0,
    ...overrides,
  };
}

describe('computeRelevanceScore', () => {
  it('scores an exact title match higher than a prefix match', () => {
    const exact = computeRelevanceScore(result({ title: 'Naruto' }), 'naruto');
    const prefix = computeRelevanceScore(result({ title: 'Naruto Shippuden' }), 'naruto');
    expect(exact).toBeGreaterThan(prefix);
  });

  it('an exact local library match outranks an equivalent-relevance new external result', () => {
    const local = computeRelevanceScore(result({ title: 'Naruto', libraryMatch: { type: 'EXACT', seriesId: 's1', userStatus: UserSeriesStatus.WATCHING, nextEpisode: null, needsAttention: false, attentionReasonCode: null } }), 'naruto');
    const external = computeRelevanceScore(result({ title: 'Naruto', libraryMatch: { type: 'NONE' } }), 'naruto');
    expect(local).toBeGreaterThan(external);
  });

  it('an irrelevant local result does not outrank a highly relevant new external match', () => {
    const irrelevantLocal = computeRelevanceScore(
      result({ title: 'Some Unrelated Show', libraryMatch: { type: 'EXACT', seriesId: 's1', userStatus: UserSeriesStatus.WATCHING, nextEpisode: null, needsAttention: false, attentionReasonCode: null } }),
      'naruto',
    );
    const relevantExternal = computeRelevanceScore(result({ title: 'Naruto', libraryMatch: { type: 'NONE' } }), 'naruto');
    expect(relevantExternal).toBeGreaterThan(irrelevantLocal);
  });
});

describe('rankSearchResults', () => {
  it('sorts by relevanceScore descending', () => {
    const ranked = rankSearchResults([result({ resultKey: 'a', relevanceScore: 10 }), result({ resultKey: 'b', relevanceScore: 90 }), result({ resultKey: 'c', relevanceScore: 50 })]);
    expect(ranked.map((r) => r.resultKey)).toEqual(['b', 'c', 'a']);
  });

  it('breaks a relevanceScore tie deterministically by shorter title, then lexical order — never insertion order', () => {
    const input = [
      result({ resultKey: 'a', title: 'Zzz', relevanceScore: 50 }),
      result({ resultKey: 'b', title: 'Ab', relevanceScore: 50 }),
      result({ resultKey: 'c', title: 'Aa', relevanceScore: 50 }),
    ];
    const ranked = rankSearchResults(input);
    expect(ranked.map((r) => r.resultKey)).toEqual(['c', 'b', 'a']);
    // Re-running on a shuffled copy of the same input must produce the same order.
    const reranked = rankSearchResults([input[2], input[0], input[1]]);
    expect(reranked.map((r) => r.resultKey)).toEqual(['c', 'b', 'a']);
  });
});
