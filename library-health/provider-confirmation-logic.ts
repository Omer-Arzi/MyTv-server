// Pure decision logic for the provider-confirmation report. No I/O, no
// Prisma, no TMDb/TVmaze calls — this only ever reasons about data already
// handed to it (candidates already scored/season-fetched by the
// orchestration script). Same pattern as every other *-logic.ts file here.
//
// This is a REPORTING/CLASSIFICATION layer only, same posture as
// missing-provider-candidates-logic.ts: it never decides to write an
// ExternalIds row. Its most confident outcome
// (READY_FOR_HUMAN_CONFIRMATION) is a recommendation a human still clicks
// through — see run-provider-confirmation.ts's header for why no apply mode
// exists.

import { isUntrustedNextEpisodeTitle } from '../src/common/stale-series-trust';

export type ProviderConfirmationClassification =
  | 'READY_FOR_HUMAN_CONFIRMATION'
  | 'STILL_AMBIGUOUS'
  | 'NEEDS_TVMAZE_OVER_TMDB'
  | 'NEEDS_SPECIAL_PROVIDER_HANDLING'
  | 'DEFER';

export type ProviderConfirmationRecommendedAction =
  | 'CONFIRM_TMDB_CANDIDATE'
  | 'CONFIRM_TVMAZE_CANDIDATE'
  | 'CHOOSE_BETWEEN_CANDIDATES'
  | 'DEFER_HIGH_RISK'
  | 'NO_GOOD_MATCH';

export type ComparisonTitleMatchType = 'exact' | 'substring' | 'fuzzy';
export type ComparisonYearMatchType = 'exact' | 'close' | 'unknown' | 'mismatch';

export interface ProviderCandidateComparisonEntry {
  provider: 'tmdb' | 'tvmaze';
  id: string;
  title: string;
  yearOrPremiereDate: string | null;
  network: string | null;
  status: string | null;
  totalEpisodeCount: number | null;
  seasonCount: number | null;
  episodesPerSeason: number[] | null;
  hasPoster: boolean | null; // null = not fetched/unknown
  confidenceScore: number;
  titleMatchType: ComparisonTitleMatchType;
  yearMatchType: ComparisonYearMatchType;
  seasonStructureScore: number | null;
  seasonStructureReason: string | null;
  collapsePatternDetected: boolean | null;
  animeNumberingRiskDetected: boolean;
  // watchedEpisodeCount - totalEpisodeCount; null when totalEpisodeCount is
  // unknown (season data wasn't fetched). Negative means the candidate's
  // catalog already covers everything watched and then some.
  watchedVsTotalGap: number | null;
  warnings: string[];
  // Human-facing "why this candidate is or is not likely correct" — always
  // set via explainCandidateLikelihood below, computed from this same
  // entry's own fields once they're known.
  likelyCorrectReason: string;
}

// A small, per-candidate explanation string — separate from the per-series
// `reason` on ClassifyForConfirmationResult, which explains the overall
// recommendation across all candidates.
export function explainCandidateLikelihood(
  entry: Pick<ProviderCandidateComparisonEntry, 'titleMatchType' | 'yearMatchType' | 'watchedVsTotalGap' | 'collapsePatternDetected' | 'animeNumberingRiskDetected'>,
): string {
  const bits: string[] = [];
  bits.push(entry.titleMatchType === 'exact' ? 'exact title match' : `${entry.titleMatchType} title match`);
  bits.push(entry.yearMatchType === 'mismatch' ? 'year does not match' : `year match: ${entry.yearMatchType}`);
  if (entry.watchedVsTotalGap !== null) {
    bits.push(
      entry.watchedVsTotalGap <= 0
        ? 'this candidate\'s episode count already covers everything watched'
        : `${entry.watchedVsTotalGap} more episode(s) watched locally than this candidate currently lists`,
    );
  }
  if (entry.collapsePatternDetected) bits.push('shows a season-collapse pattern relative to local');
  if (entry.animeNumberingRiskDetected) bits.push('flagged for anime/absolute-numbering risk');
  return bits.join('; ');
}

export interface ClassifyForConfirmationInput {
  localTitle: string;
  // false for series the task explicitly deprioritizes (higher structural
  // risk, left in the report for visibility but not investigated further
  // this pass) — always resolves to DEFER regardless of any candidate data.
  isPriorityScope: boolean;
  watchedEpisodeCount: number;
  tmdbCandidates: ProviderCandidateComparisonEntry[]; // sorted best-first
  tvmazeCandidates: ProviderCandidateComparisonEntry[]; // sorted best-first
  tmdbCloseCompetitorDetected: boolean;
  tvmazeCloseCompetitorDetected: boolean;
}

export interface ClassifyForConfirmationResult {
  classification: ProviderConfirmationClassification;
  recommendedNextAction: ProviderConfirmationRecommendedAction;
  recommendedCandidate: { provider: 'tmdb' | 'tvmaze'; id: string } | null;
  reason: string;
}

// A candidate's own episode-count catalog is allowed to lag the local
// watched count by a small margin without that alone being disqualifying —
// legacy shows' provider catalogs commonly undercount by a handful of
// episodes (double-length episodes counted as one, a finale not yet
// indexed, etc.). Percentage-based with a flat floor so both very small and
// very large libraries get a sane tolerance.
const GAP_TOLERANCE_FRACTION = 0.03;
const GAP_TOLERANCE_MIN_EPISODES = 3;

function gapWithinTolerance(gap: number | null, watchedEpisodeCount: number): boolean {
  if (gap === null) return false;
  const tolerance = Math.max(GAP_TOLERANCE_MIN_EPISODES, watchedEpisodeCount * GAP_TOLERANCE_FRACTION);
  return gap >= 0 && gap <= tolerance;
}

function isCandidateClean(entry: ProviderCandidateComparisonEntry): boolean {
  if (entry.titleMatchType !== 'exact') return false;
  if (entry.yearMatchType === 'mismatch') return false;
  if (entry.collapsePatternDetected) return false;
  if (entry.animeNumberingRiskDetected) return false;
  return true;
}

export function classifyForConfirmation(input: ClassifyForConfirmationInput): ClassifyForConfirmationResult {
  // --- Safety net: a risk-listed local title is never a candidate for a
  // normal confirmation flow, regardless of what candidates turn up.
  if (isUntrustedNextEpisodeTitle(input.localTitle)) {
    return {
      classification: 'NEEDS_SPECIAL_PROVIDER_HANDLING',
      recommendedNextAction: 'DEFER_HIGH_RISK',
      recommendedCandidate: null,
      reason: `"${input.localTitle}" is already on an existing provider-structure/episode-numbering risk list — no candidate can override that.`,
    };
  }

  if (!input.isPriorityScope) {
    return {
      classification: 'DEFER',
      recommendedNextAction: 'DEFER_HIGH_RISK',
      recommendedCandidate: null,
      reason: `"${input.localTitle}" is left in this report for visibility but was not prioritized for confirmation in this pass — it showed higher structural risk in the missing-provider-candidates report and should be revisited manually, separately, later.`,
    };
  }

  const tmdbTop = input.tmdbCandidates[0] ?? null;
  const tvmazeTop = input.tvmazeCandidates[0] ?? null;

  if (!tmdbTop && !tvmazeTop) {
    return {
      classification: 'STILL_AMBIGUOUS',
      recommendedNextAction: 'NO_GOOD_MATCH',
      recommendedCandidate: null,
      reason: 'no plausible candidate was found on either TMDb or TVmaze.',
    };
  }

  const tmdbClean = tmdbTop !== null && isCandidateClean(tmdbTop) && !input.tmdbCloseCompetitorDetected;
  const tvmazeClean = tvmazeTop !== null && isCandidateClean(tvmazeTop) && !input.tvmazeCloseCompetitorDetected;
  const tmdbGapOk = tmdbTop !== null && gapWithinTolerance(tmdbTop.watchedVsTotalGap, input.watchedEpisodeCount);
  const tvmazeGapOk = tvmazeTop !== null && gapWithinTolerance(tvmazeTop.watchedVsTotalGap, input.watchedEpisodeCount);

  const tmdbReady = tmdbTop !== null && tmdbClean && tmdbGapOk;
  const tvmazeReady = tvmazeTop !== null && tvmazeClean && tvmazeGapOk;

  if (tmdbReady && tmdbTop) {
    return {
      classification: 'READY_FOR_HUMAN_CONFIRMATION',
      recommendedNextAction: 'CONFIRM_TMDB_CANDIDATE',
      recommendedCandidate: { provider: 'tmdb', id: tmdbTop.id },
      reason: `TMDb candidate "${tmdbTop.title}" has an exact title match, no close competitor, and an episode-count gap of ${tmdbTop.watchedVsTotalGap} — within the acceptable margin for a provider catalog that may lag slightly behind a legacy show.`,
    };
  }

  if (tvmazeReady && tvmazeTop) {
    return {
      classification: 'NEEDS_TVMAZE_OVER_TMDB',
      recommendedNextAction: 'CONFIRM_TVMAZE_CANDIDATE',
      recommendedCandidate: { provider: 'tvmaze', id: tvmazeTop.id },
      reason: `TVmaze's candidate "${tvmazeTop.title}" is a clean match (exact title, no competitor, gap ${tvmazeTop.watchedVsTotalGap}) while TMDb's best candidate was not — prefer TVmaze for this title.`,
    };
  }

  // Deliberately only the TOP candidate per provider, not every fetched
  // candidate — a low-ranked, obviously-unrelated result (e.g. a
  // same-titled but unrelated decades-older show with a handful of
  // episodes) trivially "collapses" relative to local without that being
  // any signal about the real match's structure at all. Real finding from
  // this exact report: TVmaze's 2nd-ranked "Friends" (1979, 5 episodes, an
  // unrelated show) flagged this way while its 1st-ranked "Friends" (1994)
  // was a perfect gap-0 match — checking every candidate would have
  // mislabeled a clean match as an anime/absolute-numbering risk. A
  // same-titled irrelevant candidate is exactly what the close-competitor
  // check below already exists to catch, with an accurate reason.
  const topCandidates = [tmdbTop, tvmazeTop].filter((c): c is ProviderCandidateComparisonEntry => c !== null);
  const topCollapseOrAnime = topCandidates.some((c) => c.collapsePatternDetected || c.animeNumberingRiskDetected);
  if (topCollapseOrAnime) {
    return {
      classification: 'NEEDS_SPECIAL_PROVIDER_HANDLING',
      recommendedNextAction: 'DEFER_HIGH_RISK',
      recommendedCandidate: null,
      reason: 'the top candidate on at least one provider shows an anime/absolute-numbering collapse signature — needs the same absolute-numbering-aware handling as the missing-provider-candidates report, not a plain confirmation.',
    };
  }

  if (input.tmdbCloseCompetitorDetected || input.tvmazeCloseCompetitorDetected) {
    return {
      classification: 'STILL_AMBIGUOUS',
      recommendedNextAction: 'CHOOSE_BETWEEN_CANDIDATES',
      recommendedCandidate: null,
      reason: 'multiple candidates remain close in confidence — a human needs to pick between them using the side-by-side comparison.',
    };
  }

  // A single best-available candidate exists but doesn't clear every gate
  // (typically the episode-count gap) — still the strongest lead, just
  // needs a closer look before confirming, not a blind auto-approval.
  const best =
    tmdbTop && (!tvmazeTop || tmdbTop.confidenceScore >= tvmazeTop.confidenceScore)
      ? { provider: 'tmdb' as const, top: tmdbTop }
      : tvmazeTop
        ? { provider: 'tvmaze' as const, top: tvmazeTop }
        : null;

  if (best) {
    return {
      classification: 'STILL_AMBIGUOUS',
      recommendedNextAction: best.provider === 'tmdb' ? 'CONFIRM_TMDB_CANDIDATE' : 'CONFIRM_TVMAZE_CANDIDATE',
      recommendedCandidate: { provider: best.provider, id: best.top.id },
      reason: `"${best.top.title}" is the best available candidate, but its episode-count gap (${best.top.watchedVsTotalGap ?? 'unknown'}) is larger than the safe auto-confirm margin — worth a quick human sanity check before confirming, not an automatic approval.`,
    };
  }

  return {
    classification: 'STILL_AMBIGUOUS',
    recommendedNextAction: 'NO_GOOD_MATCH',
    recommendedCandidate: null,
    reason: 'no candidate could be confidently recommended.',
  };
}
