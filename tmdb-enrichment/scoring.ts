// Pure confidence-scoring logic for TMDb candidates, implementing
// docs/tmdb-enrichment-plan.md §3.2 exactly: title match (0-50) + year match
// (0-30) + a rank-based relevance signal (0-20, ADAPTED from Trakt's — TMDb
// exposes no per-result relevance score, only pre-sorted order, see the plan
// doc's §2 note on this). No I/O — testable without a network or database.
//
// extractTitleYearHint/normalizeTitle/titleSimilarity are fully
// provider-agnostic (just string manipulation), so they're imported from
// trakt-enrichment/scoring.ts rather than duplicated — this is a read-only
// import, nothing in trakt-enrichment/ is modified. Everything below that
// has TMDb-specific field names (ScoreBreakdown, scoreCandidates, decideTier)
// is its own implementation, deliberately not shared, so a TMDb report never
// shows a field named after Trakt's concepts.

import { extractTitleYearHint, normalizeTitle, titleSimilarity, TitleYearHint } from '../trakt-enrichment/scoring';
import { TmdbTvDetails, TmdbTvSearchResult } from './tmdb-types';

export { extractTitleYearHint, TitleYearHint };

export type TitleMatchType = 'exact' | 'substring' | 'fuzzy';
export type YearMatchType = 'exact' | 'close' | 'unknown' | 'mismatch';

export interface ScoreBreakdown {
  titleScore: number;
  titleMatchType: TitleMatchType;
  yearScore: number;
  yearMatchType: YearMatchType;
  rankRelevanceScore: number;
  resultPosition: number;
  totalScore: number;
}

export interface ScoredCandidate {
  result: TmdbTvSearchResult;
  breakdown: ScoreBreakdown;
}

function scoreTitle(bareTitle: string, candidateName: string): { score: number; type: TitleMatchType } {
  const a = normalizeTitle(bareTitle);
  const b = normalizeTitle(candidateName);

  if (a === b) return { score: 50, type: 'exact' };
  if (a.includes(b) || b.includes(a)) return { score: 30, type: 'substring' };

  const similarity = titleSimilarity(bareTitle, candidateName);
  return { score: Math.round(similarity * 25), type: 'fuzzy' };
}

// TMDb gives a full "YYYY-MM-DD" date (or null for an unaired/unknown show),
// unlike Trakt's bare year integer — needs parsing first.
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

// Adapted relevance signal (docs/tmdb-enrichment-plan.md §3.2): TMDb search
// results come back pre-sorted by TMDb's own relevance ranking, but the
// score itself isn't exposed — this uses result position as a proxy. Not an
// equivalent to Trakt's explicit score, an honest substitute.
function scoreRank(position: number): number {
  return Math.max(0, 20 - position * 2);
}

export function scoreCandidates(hint: TitleYearHint, results: TmdbTvSearchResult[]): ScoredCandidate[] {
  return results
    .map((result, position) => {
      const title = scoreTitle(hint.bareTitle, result.name);
      const year = scoreYear(hint.titleYear, parseYearFromDate(result.first_air_date));
      const rankRelevanceScore = scoreRank(position);

      const breakdown: ScoreBreakdown = {
        titleScore: title.score,
        titleMatchType: title.type,
        yearScore: year.score,
        yearMatchType: year.type,
        rankRelevanceScore,
        resultPosition: position,
        totalScore: title.score + year.score + rankRelevanceScore,
      };

      return { result, breakdown };
    })
    .sort((a, b) => b.breakdown.totalScore - a.breakdown.totalScore);
}

export type MatchTier = 'AUTO_MATCH' | 'NEEDS_REVIEW' | 'NO_MATCH';

// Identical thresholds to trakt-enrichment/scoring.ts's decideTier, kept as
// a separate implementation (not imported) so the two providers' tiering
// logic stay independently modifiable — see docs/tmdb-enrichment-plan.md §3.3
// for why the thresholds themselves are deliberately kept identical (direct
// comparability between providers).
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

// docs/tmdb-enrichment-plan.md §1/§7: this dataset skews heavily toward
// long-running anime, which is exactly where episode-numbering conventions
// most often disagree between metadata providers. Flags — doesn't block —
// so a reviewer can weigh a "needs review" entry differently when this is
// true (an episode-count mismatch here is expected noise, not necessarily a
// wrong match).
const LONG_RUNNING_EPISODE_THRESHOLD = 100;
const ANIME_ORIGIN_COUNTRIES = new Set(['JP']);
const ANIME_ORIGINAL_LANGUAGE = 'ja';

export interface AnimeRiskInput {
  watchedEpisodeCount: number;
  tmdbTotalEpisodeCount: number;
  genres?: TmdbTvDetails['genres'];
  originalLanguage?: string | null;
  originCountry?: string[];
}

export function detectAnimeNumberingRisk(input: AnimeRiskInput): boolean {
  const isLongRunning = Math.max(input.watchedEpisodeCount, input.tmdbTotalEpisodeCount) >= LONG_RUNNING_EPISODE_THRESHOLD;
  if (!isLongRunning) return false;

  const looksLikeAnime =
    (input.genres ?? []).some((g) => g.name.toLowerCase() === 'animation') ||
    input.originalLanguage === ANIME_ORIGINAL_LANGUAGE ||
    (input.originCountry ?? []).some((c) => ANIME_ORIGIN_COUNTRIES.has(c));

  return looksLikeAnime;
}

// docs/tmdb-matching-tuning-notes.md's real finding: an exact-title,
// top-result match is often correct but can't be told apart, from score
// alone, from a same-titled remake/reboot or a genuinely ambiguous pair of
// candidates. This makes that check explicit and inspectable instead of
// leaving it implicit in the ambiguity-gap math inside decideTier (which
// only ever looks at the #2 candidate, and only once the top candidate
// already clears the AUTO_MATCH threshold).
export type CloseCompetitorKind = 'same_title_different_year' | 'near_exact_title' | 'score_gap';

export interface CloseCompetitorCandidate {
  tmdbId: string;
  tmdbTitle: string;
  tmdbYear: number | null;
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
  const topNormalized = normalizeTitle(top.tmdbTitle);

  for (const other of others) {
    const otherNormalized = normalizeTitle(other.tmdbTitle);

    if (otherNormalized === topNormalized) {
      if (other.tmdbYear !== top.tmdbYear) {
        return {
          detected: true,
          kind: 'same_title_different_year',
          reason: `candidate "${other.tmdbTitle}" (${other.tmdbYear ?? 'unknown year'}, tmdbId ${other.tmdbId}) has an identical title to the top candidate but a different year — possible remake/reboot ambiguity`,
        };
      }
      return {
        detected: true,
        kind: 'near_exact_title',
        reason: `candidate "${other.tmdbTitle}" (tmdbId ${other.tmdbId}) has an identical normalized title to the top candidate`,
      };
    }

    const similarity = titleSimilarity(top.tmdbTitle, other.tmdbTitle);
    if (similarity >= NEAR_EXACT_TITLE_SIMILARITY) {
      return {
        detected: true,
        kind: 'near_exact_title',
        reason: `candidate "${other.tmdbTitle}" (tmdbId ${other.tmdbId}) has a near-exact title match to the top candidate (similarity ${similarity.toFixed(2)})`,
      };
    }

    const gap = Math.abs(top.confidenceScore - other.confidenceScore);
    if (gap <= CLOSE_COMPETITOR_SCORE_GAP) {
      return {
        detected: true,
        kind: 'score_gap',
        reason: `candidate "${other.tmdbTitle}" (tmdbId ${other.tmdbId}) scores within ${CLOSE_COMPETITOR_SCORE_GAP} points of the top candidate (${other.confidenceScore} vs ${top.confidenceScore})`,
      };
    }
  }

  return { detected: false, reason: null, kind: null };
}

// docs/tmdb-matching-tuning-notes.md §3.1 — a preview-only, parallel
// structural path to AUTO_MATCH that doesn't route through the absolute
// score at all. This function only ever computes a *proposal*
// (proposedTierAfterStructuralRule on the dry-run report); nothing calls it
// as part of the real decideTier/apply path.
export type StructuralTier = 'AUTO_MATCH' | 'NEEDS_REVIEW';

export interface StructuralAutoMatchInput {
  tier: MatchTier;
  titleMatchType: TitleMatchType;
  resultPosition: number;
  watchedEpisodeCount: number;
  tmdbTotalEpisodeCount: number;
  animeNumberingRiskDetected: boolean;
  closeCompetitorDetected: boolean;
}

export interface StructuralAutoMatchResult {
  proposedTier: StructuralTier;
  reason: string;
}

export function evaluateStructuralAutoMatch(input: StructuralAutoMatchInput): StructuralAutoMatchResult {
  if (input.tier !== 'NEEDS_REVIEW') {
    return {
      proposedTier: 'NEEDS_REVIEW',
      reason: `current tier is ${input.tier}, not NEEDS_REVIEW — the structural rule only proposes promoting NEEDS_REVIEW entries`,
    };
  }

  if (input.titleMatchType !== 'exact') {
    return { proposedTier: 'NEEDS_REVIEW', reason: `title match type is "${input.titleMatchType}", not exact` };
  }

  if (input.resultPosition !== 0) {
    return { proposedTier: 'NEEDS_REVIEW', reason: `top candidate is at result position ${input.resultPosition}, not the top search result` };
  }

  if (input.watchedEpisodeCount > input.tmdbTotalEpisodeCount) {
    return {
      proposedTier: 'NEEDS_REVIEW',
      reason: `watched episode count (${input.watchedEpisodeCount}) exceeds TMDb's known total (${input.tmdbTotalEpisodeCount}) — episode-count sanity check fails`,
    };
  }

  if (input.watchedEpisodeCount !== input.tmdbTotalEpisodeCount) {
    return {
      proposedTier: 'NEEDS_REVIEW',
      reason: `watched episode count (${input.watchedEpisodeCount}) is below TMDb's known total (${input.tmdbTotalEpisodeCount}) — still in progress, kept conservative for this first structural-rule pass`,
    };
  }

  if (input.animeNumberingRiskDetected) {
    return {
      proposedTier: 'NEEDS_REVIEW',
      reason: 'anime/long-running numbering risk detected — kept in review even though title, position, and episode count otherwise qualify',
    };
  }

  if (input.closeCompetitorDetected) {
    return {
      proposedTier: 'NEEDS_REVIEW',
      reason: 'a close competing candidate was detected — kept in review despite an exact title/position/episode-count match',
    };
  }

  return {
    proposedTier: 'AUTO_MATCH',
    reason: 'exact title, top search result, no close competitor, no anime-numbering risk, and watched episode count exactly matches TMDb\'s known total',
  };
}
