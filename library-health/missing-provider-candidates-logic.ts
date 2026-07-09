// Pure decision logic for the missing-provider-candidates report. No I/O, no
// Prisma, no TMDb calls — this only ever reasons about data already handed
// to it (search results already scored by tmdb-enrichment/scoring.ts, and
// season/episode data already fetched for the top few plausible
// candidates). Same pattern as every other *-logic.ts file in this repo.
//
// This is a REPORTING/CLASSIFICATION layer only. It never decides to write
// an ExternalIds row, never picks a tier the way scoring.ts's decideTier
// does for the real apply pipeline, and its one "confident" outcome
// (SAFE_CANDIDATE_HIGH_CONFIDENCE) is a recommendation for a human to
// confirm — see run-missing-provider-candidates.ts's header for why no
// apply mode exists or ever will for this pipeline.

import { TitleMatchType, YearMatchType, MatchTier } from '../tmdb-enrichment/scoring';
import { SeasonShape, TieBreakResult } from '../tmdb-enrichment/season-structure-tiebreak';
import { isUntrustedNextEpisodeTitle } from '../src/common/stale-series-trust';

export type MissingProviderCandidateClassification =
  | 'SAFE_CANDIDATE_HIGH_CONFIDENCE'
  | 'NEEDS_MANUAL_CONFIRMATION'
  | 'NEEDS_ABSOLUTE_NUMBERING_PROVIDER'
  | 'PROVIDER_STRUCTURE_RISK'
  | 'NO_GOOD_MATCH'
  | 'SKIP_LOW_CONFIDENCE';

export type MissingProviderCandidateRecommendedAction =
  | 'CONFIRM_PROVIDER_MATCH'
  | 'REVIEW_CANDIDATES_MANUALLY'
  | 'WAIT_FOR_THETVDB'
  | 'MARK_AS_RISK'
  | 'RUN_TARGETED_PROVIDER_AUDIT'
  | 'NO_ACTION';

export interface MissingProviderCandidateSummary {
  provider: 'tmdb';
  tmdbId: string;
  title: string;
  year: number | null;
  confidenceScore: number;
  titleMatchType: TitleMatchType;
  yearMatchType: YearMatchType;
  resultPosition: number;
  // null exactly when season/episode data was never fetched for this
  // candidate (only the top few plausible ones get a season fetch — see
  // run-missing-provider-candidates.ts task 2).
  providerSeasonShape: SeasonShape | null;
  totalEpisodeCount: number | null;
  seasonStructureScore: number | null;
  seasonStructureReason: string | null;
  collapsePatternDetected: boolean | null;
  animeNumberingRiskDetected: boolean;
  warnings: string[];
}

export interface ClassifyMissingProviderSeriesInput {
  localTitle: string;
  localSeasonShape: SeasonShape;
  watchedEpisodeCount: number;
  // From tmdb-enrichment/scoring.ts's decideTier, run over the raw search
  // results before any season data was fetched — the title/year confidence
  // gate this report layers season structure on top of, never replaces.
  topTier: MatchTier;
  // Sorted best-first; only the "top few" candidates that got a season
  // fetch (see run-missing-provider-candidates.ts) — empty when the search
  // itself returned nothing.
  candidates: MissingProviderCandidateSummary[];
  // From tmdb-enrichment/scoring.ts's detectCloseCompetitor, computed over
  // the same top-few candidates — an ambiguity signal season structure must
  // never be allowed to resolve on its own (task safety rule).
  closeCompetitorDetected: boolean;
  // From season-structure-tiebreak.ts's sameTotalEpisodeCountTieBreaker,
  // null when fewer than 2 candidates share the local total episode count
  // (nothing to tie-break between).
  tieBreak: TieBreakResult | null;
}

export interface ClassifyMissingProviderSeriesResult {
  classification: MissingProviderCandidateClassification;
  recommendedNextAction: MissingProviderCandidateRecommendedAction;
  recommendedCandidateTmdbId: string | null;
  reason: string;
}

export function classifyMissingProviderSeries(input: ClassifyMissingProviderSeriesInput): ClassifyMissingProviderSeriesResult {
  // --- Safety net 1: a risk-listed local title is never a safe target for
  // an automatic-looking recommendation, no matter what candidates turn up.
  // Shouldn't normally even reach this report (library-health/health-logic.ts
  // already routes risk-listed titles to PROVIDER_STRUCTURE_RISK before
  // MISSING_PROVIDER_MATCH is ever assigned), but kept as an explicit,
  // cheap, independent check rather than trusting that invariant silently.
  if (isUntrustedNextEpisodeTitle(input.localTitle)) {
    return {
      classification: 'PROVIDER_STRUCTURE_RISK',
      recommendedNextAction: 'MARK_AS_RISK',
      recommendedCandidateTmdbId: null,
      reason: `"${input.localTitle}" is already on an existing provider-structure/episode-numbering risk list — no candidate search result can override that.`,
    };
  }

  if (input.candidates.length === 0) {
    return {
      classification: 'NO_GOOD_MATCH',
      recommendedNextAction: 'RUN_TARGETED_PROVIDER_AUDIT',
      recommendedCandidateTmdbId: null,
      reason: 'TMDb search returned no candidates at all for this title.',
    };
  }

  if (input.topTier === 'NO_MATCH') {
    return {
      classification: 'SKIP_LOW_CONFIDENCE',
      recommendedNextAction: 'NO_ACTION',
      recommendedCandidateTmdbId: null,
      reason: `top candidate "${input.candidates[0].title}" scores below the needs-review floor — not worth queuing for manual review yet.`,
    };
  }

  // --- Safety net 2: an ambiguous field of close competitors is never
  // resolved by season structure alone (task's explicit rule: "do not let
  // season structure override strong title/year mismatch" — a close
  // competitor is exactly the kind of identity ambiguity that rule guards).
  if (input.closeCompetitorDetected) {
    return {
      classification: 'NEEDS_MANUAL_CONFIRMATION',
      recommendedNextAction: 'REVIEW_CANDIDATES_MANUALLY',
      recommendedCandidateTmdbId: null,
      reason: 'a close competing candidate was detected among the top results — season structure is not used to break this kind of identity ambiguity.',
    };
  }

  const top = input.candidates[0];

  // --- Cross-candidate season-structure tie-break, when applicable -------
  if (input.tieBreak && input.tieBreak.applicable) {
    if (input.tieBreak.classification === 'SAFE_CANDIDATE_HIGH_CONFIDENCE' && input.tieBreak.preferredCandidateId) {
      const preferred = input.candidates.find((c) => c.tmdbId === input.tieBreak!.preferredCandidateId);
      if (preferred && preferred.titleMatchType === 'exact' && preferred.yearMatchType !== 'mismatch') {
        return {
          classification: 'SAFE_CANDIDATE_HIGH_CONFIDENCE',
          recommendedNextAction: 'CONFIRM_PROVIDER_MATCH',
          recommendedCandidateTmdbId: preferred.tmdbId,
          reason: `season-structure tie-break confidently prefers "${preferred.title}" (${input.tieBreak.reason}), and its title/year also match cleanly.`,
        };
      }
      // The season-structure tie-break is confident, but title/year is not
      // — never let structure alone carry the recommendation (task rule).
      return {
        classification: 'NEEDS_MANUAL_CONFIRMATION',
        recommendedNextAction: 'REVIEW_CANDIDATES_MANUALLY',
        recommendedCandidateTmdbId: null,
        reason: `season structure prefers a candidate, but its title/year match is not clean enough to trust on its own (${preferred ? `titleMatchType=${preferred.titleMatchType}, yearMatchType=${preferred.yearMatchType}` : 'preferred candidate not found in the fetched set'}).`,
      };
    }

    const anyCollapseOrAnime = input.candidates.some((c) => c.collapsePatternDetected || c.animeNumberingRiskDetected);
    if (anyCollapseOrAnime) {
      return {
        classification: 'NEEDS_ABSOLUTE_NUMBERING_PROVIDER',
        recommendedNextAction: 'WAIT_FOR_THETVDB',
        recommendedCandidateTmdbId: null,
        reason: `multiple same-total-episode-count candidates could not be confidently distinguished, and at least one shows an anime/absolute-numbering collapse signature — ${input.tieBreak.reason}`,
      };
    }

    return {
      classification: 'NEEDS_MANUAL_CONFIRMATION',
      recommendedNextAction: 'REVIEW_CANDIDATES_MANUALLY',
      recommendedCandidateTmdbId: null,
      reason: `multiple same-total-episode-count candidates remain plausible: ${input.tieBreak.reason}`,
    };
  }

  // --- No tie-break to run (fewer than 2 same-total candidates) — fall
  // back to the single top candidate's own season structure.
  if (!top.providerSeasonShape) {
    return {
      classification: 'NEEDS_MANUAL_CONFIRMATION',
      recommendedNextAction: 'REVIEW_CANDIDATES_MANUALLY',
      recommendedCandidateTmdbId: null,
      reason: 'no season/episode data could be fetched for the top candidate — not enough information for a confident recommendation.',
    };
  }

  // A single candidate flagged for anime/absolute-numbering risk is never
  // auto-promoted — with no rival candidate to structurally confirm it
  // against, there's nothing to "clear all other gates" against (task
  // rule: never approve an anime/absolute-numbering case unless every gate
  // is clean, which a solo candidate can't demonstrate on its own).
  if (top.animeNumberingRiskDetected) {
    return {
      classification: 'NEEDS_ABSOLUTE_NUMBERING_PROVIDER',
      recommendedNextAction: 'WAIT_FOR_THETVDB',
      recommendedCandidateTmdbId: null,
      reason: `top candidate "${top.title}" is flagged for anime/absolute-numbering risk (${top.seasonStructureReason ?? 'season structure unavailable'}) with no rival candidate to confirm the season structure against.`,
    };
  }

  if (top.collapsePatternDetected) {
    return {
      classification: 'NEEDS_ABSOLUTE_NUMBERING_PROVIDER',
      recommendedNextAction: 'WAIT_FOR_THETVDB',
      recommendedCandidateTmdbId: null,
      reason: `top candidate "${top.title}" shows a season-collapse pattern relative to local (${top.seasonStructureReason ?? 'no detail available'}) — the classic absolute-numbering signature.`,
    };
  }

  const HIGH_SEASON_STRUCTURE_SCORE = 70;
  const isConfident =
    input.topTier === 'AUTO_MATCH' &&
    top.titleMatchType === 'exact' &&
    top.yearMatchType !== 'mismatch' &&
    top.seasonStructureScore !== null &&
    top.seasonStructureScore >= HIGH_SEASON_STRUCTURE_SCORE;

  if (isConfident) {
    return {
      classification: 'SAFE_CANDIDATE_HIGH_CONFIDENCE',
      recommendedNextAction: 'CONFIRM_PROVIDER_MATCH',
      recommendedCandidateTmdbId: top.tmdbId,
      reason: `top candidate "${top.title}" has an exact title/year match, an AUTO_MATCH title tier, and a strong season structure match (${top.seasonStructureReason}).`,
    };
  }

  return {
    classification: 'NEEDS_MANUAL_CONFIRMATION',
    recommendedNextAction: 'REVIEW_CANDIDATES_MANUALLY',
    recommendedCandidateTmdbId: null,
    reason: `top candidate "${top.title}" does not clear every confidence gate at once (tier=${input.topTier}, titleMatchType=${top.titleMatchType}, yearMatchType=${top.yearMatchType}, seasonStructureScore=${top.seasonStructureScore ?? 'unavailable'}).`,
  };
}
