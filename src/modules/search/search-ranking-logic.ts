// Pure ranking logic — no I/O. Computes one deterministic relevanceScore
// per result and sorts by it. Reuses titleSimilarity (trakt-enrichment/
// scoring.ts) for the fuzzy tier rather than a new distance metric.
//
// Tier order (highest first), per the approved UX plan's Phase 5: exact
// title match already in the library > exact title match not yet in the
// library > prefix match > fuzzy match. Implemented as a title-relevance
// score (independent of library state) plus a local-match bonus large
// enough to break a tie WITHIN the same title tier, but never large enough
// to let a barely-related library result outrank a much more relevant new
// result — an irrelevant library item must never outrank a highly relevant
// external match, per this feature's explicit constraint.

import { normalizeTitle, titleSimilarity } from '../../../trakt-enrichment/scoring';
import { SeriesSearchResult } from './search-types';

const EXACT_TITLE_SCORE = 100;
const PREFIX_TITLE_SCORE = 75;
const SUBSTRING_TITLE_SCORE = 50;
const FUZZY_TITLE_SCORE_CEILING = 40;

const LOCAL_EXACT_BONUS = 10;
const LOCAL_POSSIBLE_BONUS = 5;

function titleRelevanceScore(query: string, title: string): number {
  const q = normalizeTitle(query);
  const t = normalizeTitle(title);
  if (q === t) return EXACT_TITLE_SCORE;
  if (t.startsWith(q)) return PREFIX_TITLE_SCORE;
  if (t.includes(q)) return SUBSTRING_TITLE_SCORE;
  return Math.round(titleSimilarity(query, title) * FUZZY_TITLE_SCORE_CEILING);
}

function localMatchBonus(result: SeriesSearchResult): number {
  if (result.libraryMatch.type === 'EXACT') return LOCAL_EXACT_BONUS;
  if (result.libraryMatch.type === 'POSSIBLE') return LOCAL_POSSIBLE_BONUS;
  return 0;
}

export function computeRelevanceScore(result: Pick<SeriesSearchResult, 'title' | 'libraryMatch'>, query: string): number {
  return titleRelevanceScore(query, result.title) + localMatchBonus(result as SeriesSearchResult);
}

// Deterministic tie-break: shorter title first (a closer match to a short
// query tends to be the more likely intent), then plain lexical order —
// never left to object-insertion order, which could reshuffle results
// across otherwise-identical requests.
export function rankSearchResults(results: SeriesSearchResult[]): SeriesSearchResult[] {
  return [...results].sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
    if (a.title.length !== b.title.length) return a.title.length - b.title.length;
    return a.title.localeCompare(b.title);
  });
}
