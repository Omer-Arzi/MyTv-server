// Pure confidence-scoring logic for TVmaze candidates. Same title(0-50) +
// year(0-30) + relevance(0-20) = 0-100 shape and AUTO_MATCH/NEEDS_REVIEW/
// NO_MATCH thresholds as tmdb-enrichment/scoring.ts and
// trakt-enrichment/scoring.ts, kept deliberately identical
// (docs/tmdb-enrichment-plan.md §3.3's reasoning applies equally here:
// direct comparability between providers) — but its own independent
// implementation, not imported, so each provider's tiering stays
// independently modifiable.
//
// extractTitleYearHint/normalizeTitle/titleSimilarity are fully
// provider-agnostic, so they're imported from trakt-enrichment/scoring.ts
// rather than duplicated a third time — a read-only import, nothing in
// trakt-enrichment/ is modified.

import { extractTitleYearHint, normalizeTitle, titleSimilarity, TitleYearHint } from '../trakt-enrichment/scoring';
import { TvMazeSearchResult } from './tvmaze-types';

export { extractTitleYearHint, TitleYearHint };

export type TitleMatchType = 'exact' | 'substring' | 'fuzzy';
export type YearMatchType = 'exact' | 'close' | 'unknown' | 'mismatch';

export interface ScoreBreakdown {
  titleScore: number;
  titleMatchType: TitleMatchType;
  yearScore: number;
  yearMatchType: YearMatchType;
  tvmazeRelevanceScore: number;
  tvmazeRawScore: number;
  totalScore: number;
}

export interface ScoredCandidate {
  result: TvMazeSearchResult;
  breakdown: ScoreBreakdown;
}

// A stricter, TVmaze-scoring-local normalization used ONLY to detect
// "these are the same title once purely cosmetic noise is removed" — real
// finding from the full-library audit: MyTv/TV Time's "DAN DA DAN" vs
// TVmaze's "Dandadan" differ only in spacing, which plain normalizeTitle
// (lowercase + collapse whitespace runs, not remove them) doesn't bridge,
// so a genuinely correct match scored as merely 'fuzzy'. Deliberately kept
// separate from (never modifies) trakt-enrichment/scoring.ts's shared
// normalizeTitle — this only strengthens what would otherwise already be a
// same-title match to 'exact'; it never touches the Levenshtein
// titleSimilarity path below, so it cannot loosen fuzzy-match scoring or
// make two genuinely different, similarly-spelled titles look more alike
// than they already did. detectCloseCompetitor still runs downstream on
// every candidate regardless, so a coincidental cosmetic collision between
// two different shows is still caught as a competitor needing review, not
// silently auto-matched.
function normalizeForCosmeticComparison(title: string): string {
  return normalizeTitle(title)
    .replace(/['’‘´`]/g, '')
    .replace(/[:\-–—.,!?]/g, '')
    .replace(/\s+/g, '');
}

function scoreTitle(bareTitle: string, candidateName: string): { score: number; type: TitleMatchType } {
  const a = normalizeTitle(bareTitle);
  const b = normalizeTitle(candidateName);

  if (a === b) return { score: 50, type: 'exact' };
  if (normalizeForCosmeticComparison(bareTitle) === normalizeForCosmeticComparison(candidateName)) {
    return { score: 50, type: 'exact' };
  }
  if (a.includes(b) || b.includes(a)) return { score: 30, type: 'substring' };

  const similarity = titleSimilarity(bareTitle, candidateName);
  return { score: Math.round(similarity * 25), type: 'fuzzy' };
}

export function parseYearFromDate(dateString: string | null | undefined): number | null {
  if (!dateString) return null;
  const year = Number(dateString.slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
}

function scoreYear(titleYear: number | null, candidateYear: number | null): { score: number; type: YearMatchType } {
  if (titleYear === null) return { score: 10, type: 'unknown' };
  if (candidateYear === null) return { score: 0, type: 'mismatch' };

  const diff = Math.abs(titleYear - candidateYear);
  if (diff === 0) return { score: 30, type: 'exact' };
  if (diff === 1) return { score: 15, type: 'close' };
  return { score: 0, type: 'mismatch' };
}

// TVmaze's /search/shows exposes a real per-result relevance `score` (like
// Trakt, unlike TMDb) — normalized RELATIVE to the top raw score in this
// search's result set, same reasoning as trakt-enrichment/scoring.ts.
export function scoreCandidates(hint: TitleYearHint, results: TvMazeSearchResult[]): ScoredCandidate[] {
  if (results.length === 0) return [];

  const topRawScore = Math.max(...results.map((r) => r.score), 0);

  return results
    .map((result) => {
      const title = scoreTitle(hint.bareTitle, result.show.name);
      const year = scoreYear(hint.titleYear, parseYearFromDate(result.show.premiered));
      const tvmazeRelevanceScore = topRawScore > 0 ? Math.round((result.score / topRawScore) * 20) : 0;

      const breakdown: ScoreBreakdown = {
        titleScore: title.score,
        titleMatchType: title.type,
        yearScore: year.score,
        yearMatchType: year.type,
        tvmazeRelevanceScore,
        tvmazeRawScore: result.score,
        totalScore: title.score + year.score + tvmazeRelevanceScore,
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

// docs/tmdb-matching-tuning-notes.md §3.1's exact finding recurs here: an
// exact-title match against a series with no year hint (the overwhelming
// majority of this dataset — TV Time's own export carries no year-suffixed
// titles except the rare manual-disambiguation case) can score at most
// 50 (title) + 10 (year unknown) + 20 (relevance) = 80, structurally below
// AUTO_MATCH_MIN_SCORE (85) no matter how obviously correct the match is.
// This is a preview-only, parallel structural path to AUTO_MATCH that
// doesn't route through the absolute score at all — mirrors
// tmdb-enrichment/scoring.ts's evaluateStructuralAutoMatch exactly (see its
// comment for the full rationale). Only ever a *proposal*; nothing calls
// this as part of the real decideTier path, so decideTier's own tier stays
// the honest, conservative default everywhere it's reported.
export type StructuralTier = 'AUTO_MATCH' | 'NEEDS_REVIEW';

export interface StructuralAutoMatchInput {
  tier: MatchTier;
  titleMatchType: TitleMatchType;
  resultPosition: number;
  watchedEpisodeCount: number;
  tvmazeEpisodeCount: number;
  animeNumberingRiskDetected: boolean;
  closeCompetitorDetected: boolean;
}

export interface StructuralAutoMatchResult {
  proposedTier: StructuralTier;
  reason: string;
}

export function evaluateStructuralAutoMatch(input: StructuralAutoMatchInput): StructuralAutoMatchResult {
  if (input.tier !== 'NEEDS_REVIEW') {
    return { proposedTier: 'NEEDS_REVIEW', reason: `current tier is ${input.tier}, not NEEDS_REVIEW — the structural rule only proposes promoting NEEDS_REVIEW entries` };
  }
  if (input.titleMatchType !== 'exact') {
    return { proposedTier: 'NEEDS_REVIEW', reason: `title match type is "${input.titleMatchType}", not exact` };
  }
  if (input.resultPosition !== 0) {
    return { proposedTier: 'NEEDS_REVIEW', reason: `top candidate is at result position ${input.resultPosition}, not the top search result` };
  }
  if (input.watchedEpisodeCount > input.tvmazeEpisodeCount) {
    return {
      proposedTier: 'NEEDS_REVIEW',
      reason: `watched episode count (${input.watchedEpisodeCount}) exceeds TVmaze's known total (${input.tvmazeEpisodeCount}) — episode-count sanity check fails`,
    };
  }
  if (input.watchedEpisodeCount !== input.tvmazeEpisodeCount) {
    return {
      proposedTier: 'NEEDS_REVIEW',
      reason: `watched episode count (${input.watchedEpisodeCount}) is below TVmaze's known total (${input.tvmazeEpisodeCount}) — still in progress, kept conservative for this first structural-rule pass`,
    };
  }
  if (input.animeNumberingRiskDetected) {
    return { proposedTier: 'NEEDS_REVIEW', reason: 'anime/long-running numbering risk detected — kept in review even though title, position, and episode count otherwise qualify' };
  }
  if (input.closeCompetitorDetected) {
    return { proposedTier: 'NEEDS_REVIEW', reason: 'a close competing candidate was detected — kept in review despite an exact title/position/episode-count match' };
  }

  return {
    proposedTier: 'AUTO_MATCH',
    reason: 'exact title, top search result, no close competitor, no anime-numbering risk, and watched episode count exactly matches TVmaze\'s known total',
  };
}

// docs/tmdb-enrichment-plan.md §1/§7's same reasoning applies here: this
// dataset skews heavily toward long-running anime, where absolute-vs-
// per-season numbering conventions most often disagree between providers.
// TVmaze exposes an explicit "Anime" genre tag (simpler/more direct than
// inferring it from language+origin country the way tmdb-enrichment does),
// so this only needs the episode-count side of the heuristic.
const LONG_RUNNING_EPISODE_THRESHOLD = 100;

export interface AnimeRiskInput {
  watchedEpisodeCount: number;
  tvmazeEpisodeCount: number;
  genres: string[];
}

export function detectAnimeNumberingRisk(input: AnimeRiskInput): boolean {
  const isLongRunning = Math.max(input.watchedEpisodeCount, input.tvmazeEpisodeCount) >= LONG_RUNNING_EPISODE_THRESHOLD;
  if (!isLongRunning) return false;
  return input.genres.some((g) => g.toLowerCase() === 'anime');
}

// Same idea as tmdb-enrichment/scoring.ts's detectCloseCompetitor: an
// exact-title, top-result match can't be told apart from a same-titled
// remake/reboot by score alone (e.g. TVmaze's own 1999 anime "One Piece" vs
// 2023 live-action "One Piece" — both score nearly identically for the bare
// query "one piece").
export type CloseCompetitorKind = 'same_title_different_year' | 'near_exact_title' | 'score_gap';

export interface CloseCompetitorCandidate {
  tvmazeId: number;
  tvmazeTitle: string;
  tvmazeYear: number | null;
  confidenceScore: number;
}

export interface CloseCompetitorResult {
  detected: boolean;
  reason: string | null;
  kind: CloseCompetitorKind | null;
}

const CLOSE_COMPETITOR_SCORE_GAP = 10;
const NEAR_EXACT_TITLE_SIMILARITY = 0.9;

export function detectCloseCompetitor(top: CloseCompetitorCandidate, others: CloseCompetitorCandidate[]): CloseCompetitorResult {
  const topNormalized = normalizeTitle(top.tvmazeTitle);

  for (const other of others) {
    const otherNormalized = normalizeTitle(other.tvmazeTitle);

    if (topNormalized === otherNormalized && top.tvmazeYear !== other.tvmazeYear) {
      return {
        detected: true,
        kind: 'same_title_different_year',
        reason: `another candidate "${other.tvmazeTitle}" (${other.tvmazeYear ?? 'unknown year'}) shares the exact same title but a different year`,
      };
    }

    if (titleSimilarity(top.tvmazeTitle, other.tvmazeTitle) >= NEAR_EXACT_TITLE_SIMILARITY && top.confidenceScore - other.confidenceScore < CLOSE_COMPETITOR_SCORE_GAP) {
      return {
        detected: true,
        kind: 'near_exact_title',
        reason: `another candidate "${other.tvmazeTitle}" has a near-identical title and a score within ${CLOSE_COMPETITOR_SCORE_GAP} points`,
      };
    }
  }

  const scoreGapCompetitor = others.find((o) => top.confidenceScore - o.confidenceScore < CLOSE_COMPETITOR_SCORE_GAP);
  if (scoreGapCompetitor) {
    return {
      detected: true,
      kind: 'score_gap',
      reason: `next candidate "${scoreGapCompetitor.tvmazeTitle}" scored within ${CLOSE_COMPETITOR_SCORE_GAP} points`,
    };
  }

  return { detected: false, reason: null, kind: null };
}
