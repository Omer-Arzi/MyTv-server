// Pure planning logic for backfilling Series.rawMetadata.tvtimeShowId from
// the TV Time show id already recorded on each of a series' imported
// Episode rows (Episode.rawMetadata.tvtimeShowId). No I/O here — kept
// separate from run-backfill.ts (the DB-writing orchestration) so this is
// unit-testable without a database, same pattern as
// import-tvtime/parse-tracking-v2.ts.
//
// See docs/trakt-enrichment-plan.md §1 for why this backfill is needed: the
// TV Time importer's findOrCreateSeries never wrote tvtimeShowId into
// Series.rawMetadata, even though every imported Episode has it.

export interface EpisodeShowIdRow {
  seriesId: string;
  tvtimeShowId: string | null;
}

export interface BackfillUpdate {
  seriesId: string;
  tvtimeShowId: string;
}

export interface BackfillConflict {
  seriesId: string;
  distinctTvtimeShowIds: string[];
}

export interface BackfillPlan {
  updates: BackfillUpdate[];
  alreadyUpToDate: string[];
  skipped: string[];
  conflicts: BackfillConflict[];
}

// allSeriesIds must include every series under consideration (not just ones
// with episodes) so that series with zero tvtimeShowId-bearing episodes are
// correctly counted as "skipped" rather than silently omitted.
export function planSeriesShowIdBackfill(
  allSeriesIds: string[],
  episodeRows: EpisodeShowIdRow[],
  currentTvtimeShowIdBySeriesId: Map<string, string | null>,
): BackfillPlan {
  const distinctIdsBySeriesId = new Map<string, Set<string>>();

  for (const row of episodeRows) {
    if (!row.tvtimeShowId) continue;
    const set = distinctIdsBySeriesId.get(row.seriesId) ?? new Set<string>();
    set.add(row.tvtimeShowId);
    distinctIdsBySeriesId.set(row.seriesId, set);
  }

  const updates: BackfillUpdate[] = [];
  const alreadyUpToDate: string[] = [];
  const skipped: string[] = [];
  const conflicts: BackfillConflict[] = [];

  for (const seriesId of allSeriesIds) {
    const distinct = distinctIdsBySeriesId.get(seriesId);

    if (!distinct || distinct.size === 0) {
      skipped.push(seriesId);
      continue;
    }

    if (distinct.size > 1) {
      conflicts.push({ seriesId, distinctTvtimeShowIds: [...distinct].sort() });
      continue;
    }

    const [onlyValue] = distinct;
    const current = currentTvtimeShowIdBySeriesId.get(seriesId) ?? null;

    if (current === onlyValue) {
      alreadyUpToDate.push(seriesId);
    } else {
      updates.push({ seriesId, tvtimeShowId: onlyValue });
    }
  }

  return { updates, alreadyUpToDate, skipped, conflicts };
}
