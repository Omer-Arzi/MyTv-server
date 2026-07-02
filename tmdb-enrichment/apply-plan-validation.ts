// Pure validation for the apply step — no Prisma, no TMDb, no I/O. Kept
// separate from apply-plan.ts (which does the actual DB/TMDb work) the same
// way scoring.ts is kept separate from enrichment-dry-run.ts: testable
// without a database or network, and it's the one place that decides
// "is this candidate actually safe to write," so it needs to be trivially
// auditable on its own.
//
// Deliberately re-checks every safety flag already present on each
// candidate (closeCompetitorDetected, animeNumberingRiskDetected, watched
// vs total, tier) rather than trusting that tmdb-apply-plan.json's
// safeApplyCandidates list was filtered correctly. This is NOT
// recomputing eligibility — nothing here re-runs scoring, re-searches
// TMDb, or re-decides which candidate matched. It only re-reads the
// booleans/numbers the plan already computed and refuses to proceed if one
// of them says "unsafe" — a guard against a hand-edited or stale plan file
// silently applying something it shouldn't.

import { ApplyPlanCandidate, TmdbApplyPlan } from './apply-plan-types';

export interface CandidateSafetyResult {
  safe: boolean;
  violations: string[];
}

export function validateCandidateSafety(candidate: ApplyPlanCandidate, dataQualityFlaggedIds: ReadonlySet<string>): CandidateSafetyResult {
  const violations: string[] = [];

  if (dataQualityFlaggedIds.has(candidate.mytvSeriesId)) {
    violations.push(`"${candidate.mytvSeriesTitle}" appears in a data-quality issue — must not be applied`);
  }
  if (candidate.closeCompetitorDetected) {
    violations.push(`"${candidate.mytvSeriesTitle}" has closeCompetitorDetected=true — must not be applied`);
  }
  if (candidate.animeNumberingRiskDetected) {
    violations.push(`"${candidate.mytvSeriesTitle}" has animeNumberingRiskDetected=true — must not be applied`);
  }
  if (candidate.watchedEpisodeCount > candidate.tmdbTotalEpisodeCount) {
    violations.push(
      `"${candidate.mytvSeriesTitle}" has watched (${candidate.watchedEpisodeCount}) > total (${candidate.tmdbTotalEpisodeCount}) — must not be applied`,
    );
  }
  if (candidate.watchedEpisodeCount < candidate.tmdbTotalEpisodeCount) {
    violations.push(
      `"${candidate.mytvSeriesTitle}" has watched (${candidate.watchedEpisodeCount}) < total (${candidate.tmdbTotalEpisodeCount}) — must not be applied`,
    );
  }
  if (candidate.realTier === 'NO_MATCH') {
    violations.push(`"${candidate.mytvSeriesTitle}" has tier NO_MATCH — must not be applied`);
  }

  return { safe: violations.length === 0, violations };
}

// Every dataQuality-carrying bucket in manualReview is series-id-keyed, so
// this is just a union of ids across all of them — a candidate flagged by
// ANY of these must be rejected, not just the data-quality-specific ones,
// per validateCandidateSafety above (which checks the other flags directly
// off the candidate). Kept as its own function since it needs the plan's
// manualReview section, not just one candidate.
export function collectDataQualityFlaggedIds(plan: TmdbApplyPlan): Set<string> {
  const ids = new Set<string>();
  for (const entry of plan.manualReview.duplicate_title_year_suffix_collision) ids.add(entry.mytvSeriesId);
  for (const entry of plan.manualReview.remake_reboot_collision) ids.add(entry.mytvSeriesId);
  for (const entry of plan.manualReview.placeholder_title) ids.add(entry.mytvSeriesId);
  return ids;
}

export interface CandidateSelectionResult {
  candidates: ApplyPlanCandidate[];
  errors: string[];
}

// Restricts the apply run to a specific subset of series ids, if requested
// (--series=id1,id2). Every requested id MUST already be present in
// plan.safeApplyCandidates — an id that isn't (a manual-review entry, a
// typo, a series from a different batch entirely) is an error, not a
// silent skip: "do not apply anything outside the plan" means the caller
// asking for something outside the plan is a mistake to surface, not
// something to quietly ignore.
export function selectCandidatesToApply(plan: TmdbApplyPlan, requestedSeriesIds?: string[]): CandidateSelectionResult {
  if (!requestedSeriesIds || requestedSeriesIds.length === 0) {
    return { candidates: plan.safeApplyCandidates, errors: [] };
  }

  const byId = new Map(plan.safeApplyCandidates.map((c) => [c.mytvSeriesId, c]));
  const candidates: ApplyPlanCandidate[] = [];
  const errors: string[] = [];

  for (const id of requestedSeriesIds) {
    const candidate = byId.get(id);
    if (!candidate) {
      errors.push(`series id "${id}" is not in tmdb-apply-plan.json's safeApplyCandidates — refusing to apply it`);
      continue;
    }
    candidates.push(candidate);
  }

  return { candidates, errors };
}

export interface PlanValidationResult {
  ok: boolean;
  candidates: ApplyPlanCandidate[];
  errors: string[];
}

// The single entry point run-apply-plan.ts calls before doing anything
// else: resolves which candidates were requested, then re-validates every
// one of them. Any error at all — an unknown series id OR an unsafe
// candidate — fails the WHOLE run rather than applying the candidates that
// did pass, per the task's "fail the run instead of applying it."
export function resolveAndValidateCandidates(plan: TmdbApplyPlan, requestedSeriesIds?: string[]): PlanValidationResult {
  const { candidates, errors: selectionErrors } = selectCandidatesToApply(plan, requestedSeriesIds);
  const dataQualityFlaggedIds = collectDataQualityFlaggedIds(plan);

  const errors = [...selectionErrors];
  for (const candidate of candidates) {
    const { safe, violations } = validateCandidateSafety(candidate, dataQualityFlaggedIds);
    if (!safe) errors.push(...violations);
  }

  return { ok: errors.length === 0, candidates, errors };
}
