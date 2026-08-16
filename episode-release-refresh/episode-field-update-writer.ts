// The one write path for applying compareSeriesCatalog's fieldChanges
// (title/overview/airDate/imageUrl/runtimeMinutes corrections on an
// EXISTING Episode row) — added 2026-08-16 alongside future-episode
// inserts (build-episode-insert-plan.ts). Previously fieldChanges was
// report-only ("never applies metadata fieldChanges" — see
// apply-refresh-reports.ts's own summary text, now stale, being corrected
// alongside this file): safe to skip while every stored date was already in
// the past and unlikely to change. That stopped being true the moment
// future/not-yet-aired episodes started getting inserted early (so Upcoming
// can show them ahead of release) — a future date is exactly the kind of
// value that can shift before it airs, and without this, a stale future
// date would just sit there silently misleading the Upcoming timeline
// forever, with no mechanism to ever correct it.
//
// Deliberately never touches identity (tmdbEpisodeId), season/episode
// number, EpisodeWatch, or UserSeriesProgress — this is a pure metadata
// correction on a row whose identity is already settled (compareSeriesCatalog
// only produces a fieldChange for a LOCAL episode the provider still agrees
// is the same (seasonNumber, episodeNumber) slot). No watch history is ever
// at risk: EpisodeWatch keys off episodeId, which this never changes.

import { Prisma } from '@prisma/client';
import { EpisodeFieldChange } from './refresh-logic';

export interface ApplyEpisodeFieldUpdatesResult {
  episodesUpdated: number;
  // Present only for a row that no longer exists by write time (e.g. a
  // concurrent one-off repair tool deleted/merged it, per
  // library-health/rezero-duplicate-episode-merge-logic.ts's precedent) —
  // skipped rather than thrown, so one raced-away episode can never abort
  // every other episode's correction in the same refresh.
  skippedEpisodeIds: string[];
}

export async function applyEpisodeFieldUpdates(tx: Prisma.TransactionClient, fieldChanges: EpisodeFieldChange[]): Promise<ApplyEpisodeFieldUpdatesResult> {
  let episodesUpdated = 0;
  const skippedEpisodeIds: string[] = [];

  for (const change of fieldChanges) {
    try {
      await tx.episode.update({
        where: { id: change.episodeId },
        data: {
          title: change.newTitle,
          overview: change.newOverview,
          airDate: change.newAirDate,
          imageUrl: change.newImageUrl,
          runtimeMinutes: change.newRuntimeMinutes,
        },
      });
      episodesUpdated++;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        skippedEpisodeIds.push(change.episodeId);
        continue;
      }
      throw err;
    }
  }

  return { episodesUpdated, skippedEpisodeIds };
}
