// A CAUTIOUS scoring tie-breaker for choosing between multiple provider
// candidates that share the same total episode count as a local series. No
// I/O — pure functions only, same pattern as scoring.ts/data-quality.ts.
//
// Motivation (see the task this was built for): TMDb sometimes collapses
// multiple TV-Time-style cours/seasons into one long season, especially for
// anime — so when two candidates both have the right total episode count,
// the one whose season COUNT and per-season SHAPE more closely match the
// local series is (cautiously) more likely to be the TV-Time-style match,
// not the absolute-numbering one.
//
// Deliberately provider-agnostic (no tmdb-types.ts import) — nothing here
// assumes TMDb specifically, so this is equally usable for a future TVmaze
// candidate list, same reasoning scoring.ts's header comment already gives
// for extractTitleYearHint/normalizeTitle/titleSimilarity being shared.
//
// This module is ONLY ever a scoring/reporting input. It:
//   - never decides AUTO_MATCH by itself (see the header note on
//     SeasonStructureClassification below — its "high confidence" outcome
//     is a candidate-preference signal for a human/downstream step to
//     weigh, not a tier);
//   - never overrides a title/year/network mismatch;
//   - never promotes a risk-listed title (reuses
//     src/common/stale-series-trust.ts's isUntrustedNextEpisodeTitle
//     directly, so it can never disagree with the app's own risk list);
//   - never promotes an anime/absolute-numbering-flagged candidate unless
//     every other gate is clean AND the season count matches exactly.

import { isUntrustedNextEpisodeTitle } from '../src/common/stale-series-trust';

export interface SeasonShape {
  seasonCount: number;
  // Episode count per season, in season order. Index-aligned comparison
  // (season 1 vs season 1, etc.) is a deliberate simplification — season
  // *numbers* are never trusted for cross-provider comparison elsewhere in
  // this codebase (see secondary-provider-audit/tvmaze-compare.ts's header
  // comment), but comparing *shape by position* for same-total candidates
  // is a much narrower, lower-stakes use than trusting numbering directly.
  episodesPerSeason: number[];
  totalEpisodeCount: number;
}

export function buildSeasonShape(episodesPerSeason: number[]): SeasonShape {
  return {
    seasonCount: episodesPerSeason.length,
    episodesPerSeason,
    totalEpisodeCount: episodesPerSeason.reduce((sum, n) => sum + n, 0),
  };
}

// --- The four named pure helpers -----------------------------------------

export function totalEpisodeCountMatch(localTotal: number, candidateTotal: number): boolean {
  return localTotal === candidateTotal;
}

export function seasonCountDistance(localSeasonCount: number, candidateSeasonCount: number): number {
  return Math.abs(localSeasonCount - candidateSeasonCount);
}

// 0 (nothing alike) .. 1 (identical). Index-aligned absolute-difference sum,
// normalized against local's own total so a wildly different candidate
// shape can't produce a negative/out-of-range result. Missing seasons on
// either side count as 0 episodes for that slot (not skipped), so a
// candidate with fewer/more seasons than local is penalized in proportion
// to the actual episode-count mismatch it represents, not just "different
// length."
export function seasonDistributionSimilarity(local: number[], candidate: number[]): number {
  const length = Math.max(local.length, candidate.length);
  let diff = 0;
  let localTotal = 0;
  for (let i = 0; i < length; i++) {
    const a = local[i] ?? 0;
    const b = candidate[i] ?? 0;
    diff += Math.abs(a - b);
    localTotal += a;
  }
  if (localTotal === 0) return local.length === candidate.length ? 1 : 0;
  return Math.max(0, Math.min(1, 1 - diff / (2 * localTotal)));
}

// The classic anime absolute-numbering signature already established
// elsewhere in this codebase (library-health/incomplete-catalog-investigation.ts's
// looksLikeAbsoluteNumberingConsolidation uses the identical condition) —
// reimplemented here rather than imported, since that file's version is
// scoped to a live post-match refresh comparison and this one runs
// pre-match against unconfirmed search candidates; keeping them
// independently readable matters more than avoiding a one-line duplication,
// but the condition itself is intentionally kept identical so the two
// pipelines never disagree about what counts as "a collapse."
export function isSeasonCollapsePattern(localSeasonCount: number, candidateSeasonCount: number): boolean {
  return candidateSeasonCount <= 1 && localSeasonCount > 1;
}

// --- Per-candidate scoring -------------------------------------------------

// Suggested-scoring weights from the task: total-count match is the
// strongest signal (40), season-count closeness next (30, decaying 10
// points per season of distance), per-season shape similarity last (up to
// 30). Bounded 0-100 so it reads naturally as a percentage-like confidence
// contribution; never the sole basis for a tier decision (see module header).
const MAX_TOTAL_MATCH_POINTS = 40;
const MAX_SEASON_COUNT_POINTS = 30;
const SEASON_COUNT_POINT_DECAY_PER_SEASON = 10;
const MAX_DISTRIBUTION_POINTS = 30;

export interface SeasonStructureScore {
  totalEpisodeCountMatches: boolean;
  seasonCountDistance: number;
  seasonDistributionSimilarity: number;
  collapsePatternDetected: boolean;
  seasonStructureScore: number;
  seasonStructureReason: string;
}

export function scoreCandidateSeasonStructure(local: SeasonShape, candidate: SeasonShape): SeasonStructureScore {
  const totalMatches = totalEpisodeCountMatch(local.totalEpisodeCount, candidate.totalEpisodeCount);
  const distance = seasonCountDistance(local.seasonCount, candidate.seasonCount);
  const similarity = seasonDistributionSimilarity(local.episodesPerSeason, candidate.episodesPerSeason);
  const collapse = isSeasonCollapsePattern(local.seasonCount, candidate.seasonCount);

  const score =
    (totalMatches ? MAX_TOTAL_MATCH_POINTS : 0) +
    Math.max(0, MAX_SEASON_COUNT_POINTS - distance * SEASON_COUNT_POINT_DECAY_PER_SEASON) +
    Math.round(similarity * MAX_DISTRIBUTION_POINTS);

  const reasonParts = [
    totalMatches
      ? `total episode counts match (${local.totalEpisodeCount})`
      : `total episode counts differ (local ${local.totalEpisodeCount} vs candidate ${candidate.totalEpisodeCount})`,
    distance === 0
      ? `season count matches exactly (${local.seasonCount})`
      : `season count differs by ${distance} (local ${local.seasonCount} vs candidate ${candidate.seasonCount})`,
    `per-season distribution similarity ${(similarity * 100).toFixed(0)}%`,
  ];
  if (collapse) {
    reasonParts.push(
      `candidate collapses ${local.seasonCount} local seasons into ${candidate.seasonCount} — the classic absolute-numbering pattern, treated as a risk signal, not a positive`,
    );
  }

  return {
    totalEpisodeCountMatches: totalMatches,
    seasonCountDistance: distance,
    seasonDistributionSimilarity: similarity,
    collapsePatternDetected: collapse,
    seasonStructureScore: score,
    seasonStructureReason: reasonParts.join('; '),
  };
}

// --- The tie-breaker itself -------------------------------------------------

// A candidate never promoted, even if it has the best season structure of
// the bunch — the exact three hard rules the task calls out.
export type SeasonStructureClassification =
  | 'SAFE_CANDIDATE_HIGH_CONFIDENCE' // exactly one clear, ungated, exact-season-count winner
  | 'NEEDS_MANUAL_CONFIRMATION' // applicable, but no confident/ungated winner
  | 'NOT_APPLICABLE'; // fewer than 2 candidates share the local total episode count

export interface TieBreakCandidateInput {
  candidateId: string;
  candidateLabel: string;
  candidateTitle: string; // checked against isUntrustedNextEpisodeTitle — kept separate from candidateLabel so a report can format the label differently (e.g. with a year) without affecting the risk-list check
  shape: SeasonShape;
  hasStrongTitleYearNetworkMismatch: boolean;
  animeNumberingRiskDetected: boolean;
  baseConfidenceScore: number;
}

export interface TieBreakCandidateReport extends SeasonStructureScore {
  candidateId: string;
  candidateLabel: string;
  localSeasonCount: number;
  providerSeasonCount: number;
  localEpisodeCount: number;
  providerEpisodeCount: number;
  isRiskListedTitle: boolean;
  eligibleForPreference: boolean;
  ineligibilityReason: string | null;
}

export interface TieBreakResult {
  applicable: boolean;
  classification: SeasonStructureClassification;
  // Only ever set alongside classification === 'SAFE_CANDIDATE_HIGH_CONFIDENCE'.
  preferredCandidateId: string | null;
  reason: string;
  // Sorted best-to-worst among eligible candidates, ineligible ones last —
  // useful for a report to render in preference order even when no single
  // candidate clears the bar for preferredCandidateId.
  candidates: TieBreakCandidateReport[];
}

// A "confident" winner must match local's season count exactly AND have a
// high per-season shape similarity — an approximately-close season count
// alone (e.g. distance 1, picked only because it beat another equally-off
// candidate) is never enough to call this "high confidence," it only ever
// earns NEEDS_MANUAL_CONFIRMATION. This is what keeps the "prefer more
// seasons when equally close" tie-break rule from ever alone producing an
// auto-preferred candidate — two candidates can only be "equally close" at
// distance >= 1, which never clears this bar.
const QUALITY_BAR_MAX_SEASON_COUNT_DISTANCE = 0;
const QUALITY_BAR_MIN_DISTRIBUTION_SIMILARITY = 0.85;

// Internal-only: carries the raw confidence score used solely as the final
// ranking tie-break key, kept off the public TieBreakCandidateReport shape
// (callers get baseConfidenceScore back via candidateId lookup on their own
// input list if they need it — this module's report is about season
// structure, not re-exporting a score it didn't compute).
interface RankableCandidateReport extends TieBreakCandidateReport {
  baseConfidenceScoreForRanking: number;
}

function rankCandidates(a: RankableCandidateReport, b: RankableCandidateReport): number {
  if (a.seasonCountDistance !== b.seasonCountDistance) return a.seasonCountDistance - b.seasonCountDistance;
  // Equally close: prefer more seasons (task's explicit tie-break rule).
  if (a.providerSeasonCount !== b.providerSeasonCount) return b.providerSeasonCount - a.providerSeasonCount;
  if (a.seasonDistributionSimilarity !== b.seasonDistributionSimilarity) return b.seasonDistributionSimilarity - a.seasonDistributionSimilarity;
  return b.baseConfidenceScoreForRanking - a.baseConfidenceScoreForRanking;
}

export function sameTotalEpisodeCountTieBreaker(localShape: SeasonShape, candidates: TieBreakCandidateInput[]): TieBreakResult {
  const sameTotalCandidates = candidates.filter((c) => totalEpisodeCountMatch(localShape.totalEpisodeCount, c.shape.totalEpisodeCount));

  if (sameTotalCandidates.length < 2) {
    return {
      applicable: false,
      classification: 'NOT_APPLICABLE',
      preferredCandidateId: null,
      reason: `only ${sameTotalCandidates.length} candidate(s) share the local total episode count (${localShape.totalEpisodeCount}) — this tie-breaker only applies with 2 or more`,
      candidates: [],
    };
  }

  const reports = sameTotalCandidates.map((c): RankableCandidateReport => {
    const score = scoreCandidateSeasonStructure(localShape, c.shape);
    const isRiskListedTitle = isUntrustedNextEpisodeTitle(c.candidateTitle);

    let ineligibilityReason: string | null = null;
    if (isRiskListedTitle) {
      ineligibilityReason = 'candidate title is on an existing provider-structure/episode-numbering risk list — season structure can never promote a risk-listed title';
    } else if (c.hasStrongTitleYearNetworkMismatch) {
      ineligibilityReason = 'candidate has a strong title/year/network mismatch — season structure must never override that';
    } else if (score.collapsePatternDetected) {
      ineligibilityReason = 'candidate itself shows a season-collapse pattern relative to local — cannot be treated as a confident structural match';
    } else if (c.animeNumberingRiskDetected && score.seasonCountDistance > QUALITY_BAR_MAX_SEASON_COUNT_DISTANCE) {
      ineligibilityReason = 'anime/absolute-numbering risk is present and season count is not an exact match — only an exact match clears this gate for a flagged anime candidate';
    }

    return {
      ...score,
      candidateId: c.candidateId,
      candidateLabel: c.candidateLabel,
      localSeasonCount: localShape.seasonCount,
      providerSeasonCount: c.shape.seasonCount,
      localEpisodeCount: localShape.totalEpisodeCount,
      providerEpisodeCount: c.shape.totalEpisodeCount,
      isRiskListedTitle,
      eligibleForPreference: ineligibilityReason === null,
      ineligibilityReason,
      baseConfidenceScoreForRanking: c.baseConfidenceScore,
    };
  });

  const eligibleRanked = reports.filter((r) => r.eligibleForPreference).sort(rankCandidates);
  const ineligible = reports.filter((r) => !r.eligibleForPreference);
  const sortedCandidates = [...eligibleRanked, ...ineligible].map(({ baseConfidenceScoreForRanking: _unused, ...rest }) => rest);

  const [top, second] = eligibleRanked;
  const clearsQualityBar = (r: TieBreakCandidateReport) =>
    r.seasonCountDistance <= QUALITY_BAR_MAX_SEASON_COUNT_DISTANCE && r.seasonDistributionSimilarity >= QUALITY_BAR_MIN_DISTRIBUTION_SIMILARITY;
  const topIsClearWinner = top && clearsQualityBar(top) && (!second || rankCandidates(top, second) !== 0);

  if (topIsClearWinner && top) {
    return {
      applicable: true,
      classification: 'SAFE_CANDIDATE_HIGH_CONFIDENCE',
      preferredCandidateId: top.candidateId,
      reason: `"${top.candidateLabel}" has the closest season structure to local (${top.seasonStructureReason}) and no disqualifying risk signal — preferred as a tie-break among ${sameTotalCandidates.length} same-total-episode-count candidates`,
      candidates: sortedCandidates,
    };
  }

  let reasonBit: string;
  if (eligibleRanked.length === 0) {
    reasonBit = 'no candidate is free of a disqualifying risk signal (risk-listed title, title/year/network mismatch, season collapse, or unresolved anime-numbering risk)';
  } else if (!top || !clearsQualityBar(top)) {
    reasonBit = 'the best-ranked eligible candidate does not clear the season-structure confidence bar (exact season count + high per-season distribution similarity)';
  } else {
    reasonBit = 'two or more eligible candidates are tied on season structure — no confident preference can be made';
  }

  return {
    applicable: true,
    classification: 'NEEDS_MANUAL_CONFIRMATION',
    preferredCandidateId: null,
    reason: `${sameTotalCandidates.length} candidates share the local total episode count (${localShape.totalEpisodeCount}), but ${reasonBit} — flagged for manual confirmation rather than auto-preferring one.`,
    candidates: sortedCandidates,
  };
}
