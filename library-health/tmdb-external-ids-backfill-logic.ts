// Pure logic for the one-time ExternalIds.tmdbId backfill. No I/O.
//
// Context: run-provider-confirmation-pipeline.ts's apply transaction wrote
// provider/providerId for every confirmed match but never the dedicated,
// uniquely-constrained ExternalIds.tmdbId column that health-logic.ts,
// episode-release-refresh, and the app's series.service.ts all actually
// read. This backfill closes that gap for rows this pipeline already
// wrote — see docs/library-health-provider-confirmation-runbook.md.
//
// Scope is deliberately narrow: only rows with provider === 'tmdb',
// tmdbId already null, and a matchSource this specific pipeline wrote
// (never touches a row managed by a different process, e.g. the older
// tmdb-enrichment/apply-plan.ts pipeline, which already sets tmdbId
// itself and has its own reasons for whatever state its rows are in).

export interface BackfillCandidateRow {
  seriesId: string;
  title: string;
  providerId: string;
  matchSource: string | null;
}

export type BackfillAction = 'backfill' | 'skip_collision';

export interface BackfillPlanEntry {
  seriesId: string;
  title: string;
  providerId: string;
  action: BackfillAction;
  reason: string;
}

// existingTmdbIds must be every non-null tmdbId value currently in the
// ExternalIds table, from ANY row / ANY process — the uniqueness
// constraint is table-wide, not scoped to this pipeline's own rows.
export function planTmdbIdBackfill(input: { candidates: BackfillCandidateRow[]; existingTmdbIds: Set<string> }): BackfillPlanEntry[] {
  const seenInBatch = new Set<string>();
  const plan: BackfillPlanEntry[] = [];

  for (const c of input.candidates) {
    if (input.existingTmdbIds.has(c.providerId)) {
      plan.push({
        seriesId: c.seriesId,
        title: c.title,
        providerId: c.providerId,
        action: 'skip_collision',
        reason: `tmdbId ${c.providerId} is already used by another existing ExternalIds row — refusing to create a duplicate.`,
      });
      continue;
    }
    if (seenInBatch.has(c.providerId)) {
      plan.push({
        seriesId: c.seriesId,
        title: c.title,
        providerId: c.providerId,
        action: 'skip_collision',
        reason: `tmdbId ${c.providerId} is duplicated by another candidate row in this same backfill batch — refusing to create a duplicate.`,
      });
      continue;
    }
    seenInBatch.add(c.providerId);
    plan.push({
      seriesId: c.seriesId,
      title: c.title,
      providerId: c.providerId,
      action: 'backfill',
      reason: 'no collision against any existing tmdbId or any other candidate in this batch — safe to set tmdbId = providerId.',
    });
  }

  return plan;
}
