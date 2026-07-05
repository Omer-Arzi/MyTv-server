// Pure remapping of a tmdb-apply-plan.json's mytvSeriesId fields against a
// freshly-reconstructed database. No I/O — testable without a database.
//
// Exists for exactly one reason: a tmdb-apply-plan.json bakes in Series
// UUIDs from whenever the plan was generated. If the database is ever
// rebuilt from source (e.g. re-running import-tvtime after a data-loss
// incident), re-importing generates BRAND NEW Series UUIDs for the same
// titles — the old plan's mytvSeriesId values point at rows that no longer
// exist. apply-plan.ts's planCandidateUpdate() does a hard
// `where: { id: candidate.mytvSeriesId }` lookup, so every candidate would
// silently report "Series no longer exists" without this step.
//
// This ONLY rewrites mytvSeriesId by exact title match — it never touches
// tmdbId, realTier, proposedUserStatusAfterEnrichment, or any other field
// the original dry run decided. No new matching decision is made here.

import { TmdbApplyPlan } from './apply-plan-types';

export interface SeriesIdByTitle {
  title: string;
  id: string;
}

export interface RemapResult {
  plan: TmdbApplyPlan;
  remapped: Array<{ title: string; oldSeriesId: string; newSeriesId: string }>;
  unmatched: string[]; // titles with zero matches in the current database
  ambiguous: string[]; // titles with more than one match — never guessed at
}

export function remapApplyPlanSeriesIds(plan: TmdbApplyPlan, currentSeries: SeriesIdByTitle[]): RemapResult {
  const idsByTitle = new Map<string, string[]>();
  for (const s of currentSeries) {
    const list = idsByTitle.get(s.title) ?? [];
    list.push(s.id);
    idsByTitle.set(s.title, list);
  }

  const remapped: RemapResult['remapped'] = [];
  const unmatched: string[] = [];
  const ambiguous: string[] = [];

  const remappedCandidates = plan.safeApplyCandidates.map((candidate) => {
    const matches = idsByTitle.get(candidate.mytvSeriesTitle) ?? [];

    if (matches.length === 0) {
      unmatched.push(candidate.mytvSeriesTitle);
      return candidate; // left unchanged — caller must refuse to proceed if unmatched.length > 0
    }
    if (matches.length > 1) {
      ambiguous.push(candidate.mytvSeriesTitle);
      return candidate; // left unchanged — never guess between duplicates
    }

    const newSeriesId = matches[0];
    remapped.push({ title: candidate.mytvSeriesTitle, oldSeriesId: candidate.mytvSeriesId, newSeriesId });
    return { ...candidate, mytvSeriesId: newSeriesId };
  });

  return {
    plan: { ...plan, safeApplyCandidates: remappedCandidates },
    remapped,
    unmatched,
    ambiguous,
  };
}
