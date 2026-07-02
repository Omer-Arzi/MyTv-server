// Pure confidence-scoring logic implementing docs/trakt-enrichment-plan.md
// §3.2/§3.3 exactly: title match (0-50) + year match (0-30) + Trakt's own
// relevance score normalized within the result set (0-20) = 0-100, then a
// tier decision (auto-apply / needs-review / no-match) from the sorted
// candidate scores. No I/O — kept separate from trakt-client.ts and
// enrichment-dry-run.ts so it's unit-testable without a network or a
// database, same pattern as import-tvtime/parse-tracking-v2.ts.

import { TraktSearchResult } from './trakt-types';

export interface TitleYearHint {
  bareTitle: string;
  titleYear: number | null;
}

const YEAR_SUFFIX_PATTERN = /^(.*?)\s*\((\d{4})\)$/;

export function extractTitleYearHint(title: string): TitleYearHint {
  const match = title.match(YEAR_SUFFIX_PATTERN);
  if (match) {
    return { bareTitle: match[1].trim(), titleYear: Number(match[2]) };
  }
  return { bareTitle: title.trim(), titleYear: null };
}

export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Levenshtein distance, normalized to a 0..1 similarity ratio (1 = identical).
export function titleSimilarity(a: string, b: string): number {
  const s1 = normalizeTitle(a);
  const s2 = normalizeTitle(b);
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const rows = s1.length + 1;
  const cols = s2.length + 1;
  const dist: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i++) dist[i][0] = i;
  for (let j = 0; j < cols; j++) dist[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dist[i][j] = Math.min(dist[i - 1][j] + 1, dist[i][j - 1] + 1, dist[i - 1][j - 1] + cost);
    }
  }

  const maxLen = Math.max(s1.length, s2.length);
  return 1 - dist[rows - 1][cols - 1] / maxLen;
}

export type TitleMatchType = 'exact' | 'substring' | 'fuzzy';
export type YearMatchType = 'exact' | 'close' | 'unknown' | 'mismatch';

export interface ScoreBreakdown {
  titleScore: number;
  titleMatchType: TitleMatchType;
  yearScore: number;
  yearMatchType: YearMatchType;
  traktRelevanceScore: number;
  traktRawScore: number;
  totalScore: number;
}

export interface ScoredCandidate {
  result: TraktSearchResult;
  breakdown: ScoreBreakdown;
}

function scoreTitle(bareTitle: string, candidateTitle: string): { score: number; type: TitleMatchType } {
  const a = normalizeTitle(bareTitle);
  const b = normalizeTitle(candidateTitle);

  if (a === b) return { score: 50, type: 'exact' };
  if (a.includes(b) || b.includes(a)) return { score: 30, type: 'substring' };

  const similarity = titleSimilarity(bareTitle, candidateTitle);
  return { score: Math.round(similarity * 25), type: 'fuzzy' };
}

function scoreYear(titleYear: number | null, candidateYear: number | null): { score: number; type: YearMatchType } {
  if (titleYear === null) return { score: 10, type: 'unknown' };
  if (candidateYear === null) return { score: 0, type: 'mismatch' };

  const diff = Math.abs(titleYear - candidateYear);
  if (diff === 0) return { score: 30, type: 'exact' };
  if (diff === 1) return { score: 15, type: 'close' };
  return { score: 0, type: 'mismatch' };
}

// traktRelevanceScore is normalized RELATIVE to the top raw score in this
// search's result set (docs/trakt-enrichment-plan.md §3.2) — Trakt's score
// is a generic text-relevance number with no fixed scale, so what matters is
// "how much better is this candidate than the alternatives," not its
// absolute value.
export function scoreCandidates(hint: TitleYearHint, results: TraktSearchResult[]): ScoredCandidate[] {
  if (results.length === 0) return [];

  const topRawScore = Math.max(...results.map((r) => r.score), 0);

  return results
    .map((result) => {
      const title = scoreTitle(hint.bareTitle, result.show.title);
      const year = scoreYear(hint.titleYear, result.show.year);
      const traktRelevanceScore = topRawScore > 0 ? Math.round((result.score / topRawScore) * 20) : 0;

      const breakdown: ScoreBreakdown = {
        titleScore: title.score,
        titleMatchType: title.type,
        yearScore: year.score,
        yearMatchType: year.type,
        traktRelevanceScore,
        traktRawScore: result.score,
        totalScore: title.score + year.score + traktRelevanceScore,
      };

      return { result, breakdown };
    })
    .sort((a, b) => b.breakdown.totalScore - a.breakdown.totalScore);
}

export type MatchTier = 'AUTO_MATCH' | 'NEEDS_REVIEW' | 'NO_MATCH';

const AUTO_MATCH_MIN_SCORE = 85;
const NEEDS_REVIEW_MIN_SCORE = 50;
const AMBIGUITY_GAP = 15;

export interface TierDecision {
  tier: MatchTier;
  top: ScoredCandidate | null;
  second: ScoredCandidate | null;
  reason: string;
}

export function decideTier(sortedCandidates: ScoredCandidate[]): TierDecision {
  const [top, second] = sortedCandidates;

  if (!top) {
    return { tier: 'NO_MATCH', top: null, second: null, reason: 'search returned zero results' };
  }

  if (top.breakdown.totalScore >= AUTO_MATCH_MIN_SCORE) {
    const gap = second ? top.breakdown.totalScore - second.breakdown.totalScore : Infinity;
    if (gap >= AMBIGUITY_GAP) {
      return { tier: 'AUTO_MATCH', top, second: second ?? null, reason: `top score ${top.breakdown.totalScore} with a clear gap to the next candidate` };
    }
    return {
      tier: 'NEEDS_REVIEW',
      top,
      second: second ?? null,
      reason: `top score ${top.breakdown.totalScore} is high but only ${gap} points ahead of the next candidate (${second?.breakdown.totalScore}) — ambiguous`,
    };
  }

  if (top.breakdown.totalScore >= NEEDS_REVIEW_MIN_SCORE) {
    return { tier: 'NEEDS_REVIEW', top, second: second ?? null, reason: `top score ${top.breakdown.totalScore} is below the auto-apply threshold (${AUTO_MATCH_MIN_SCORE})` };
  }

  return { tier: 'NO_MATCH', top, second: second ?? null, reason: `top score ${top.breakdown.totalScore} is below the needs-review threshold (${NEEDS_REVIEW_MIN_SCORE})` };
}
