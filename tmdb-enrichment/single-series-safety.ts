// Pure safety validation for a targeted, single-series enrichment apply —
// deliberately separate from apply-plan-validation.ts's batch validator.
// That validator requires watchedEpisodeCount === tmdbTotalEpisodeCount
// (conservative first-pass rule: only ever batch-apply to series the user
// has fully finished). A targeted single-series fix is explicitly for the
// opposite case — an ongoing series a reviewer has manually confirmed is
// the right match, still mid-watch, whose catalog is missing the unwatched
// remainder. Every OTHER safety signal (no data-quality flag, no close
// competitor, no anime-numbering risk, not a NO_MATCH tier, not
// over-watched) still applies unchanged.

export type SingleSeriesTier = 'AUTO_MATCH' | 'NEEDS_REVIEW' | 'NO_MATCH';

export interface SingleSeriesCandidateInput {
  tier: SingleSeriesTier;
  closeCompetitorDetected: boolean;
  animeNumberingRiskDetected: boolean;
  isDataQualityFlagged: boolean;
  watchedEpisodeCount: number;
  providerTotalEpisodeCount: number;
}

export interface SingleSeriesSafetyResult {
  safe: boolean;
  violations: string[];
}

export function validateSingleSeriesCandidate(input: SingleSeriesCandidateInput): SingleSeriesSafetyResult {
  const violations: string[] = [];

  if (input.tier === 'NO_MATCH') {
    violations.push('tier is NO_MATCH — no confident candidate exists, must not be applied without a stronger signal');
  }
  if (input.closeCompetitorDetected) {
    violations.push('closeCompetitorDetected=true — a same-titled or near-identical-scoring competitor exists, must not be applied');
  }
  if (input.animeNumberingRiskDetected) {
    violations.push('animeNumberingRiskDetected=true — absolute-vs-per-season numbering risk, must not be applied without manual episode-order confirmation');
  }
  if (input.isDataQualityFlagged) {
    violations.push('flagged in the data-quality pass (remake/duplicate-title collision) — must not be applied');
  }
  if (input.watchedEpisodeCount > input.providerTotalEpisodeCount) {
    violations.push(
      `watched (${input.watchedEpisodeCount}) exceeds the provider's known total (${input.providerTotalEpisodeCount}) — catalog is likely incomplete or mismatched, must not be applied`,
    );
  }

  return { safe: violations.length === 0, violations };
}
