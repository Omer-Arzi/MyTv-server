// Pure helpers for MeService — no Prisma calls, no I/O — same pattern as
// series-query-helpers.ts.

import { isEpisodeReleased } from '../../common/is-episode-released';

export interface ProgressWithNextEpisode {
  nextEpisode: { airDate: Date | null } | null;
}

// GET /me/watch-next's own defense-in-depth: UserSeriesProgress.nextEpisodeId
// is already gated at every write site (markWatched, the manual
// status-update endpoint, the one-time backfill — see
// src/common/is-episode-released.ts) so a future or null-airDate episode
// should never end up as nextEpisodeId in the first place. This filter
// re-checks it anyway at read time, so a bug in some future write path (or a
// row written before a gating fix existed) can't leak an unwatchable episode
// into Watch Next — the endpoint's contract holds regardless of how the row
// got into the table.
//
// A null airDate is excluded here for the same reason it's excluded
// everywhere else: there's no way to distinguish "definitely aired, TMDb
// just never recorded the date" from "not aired yet, no date announced," so
// it's treated as not-yet-released. Future/null-airDate episodes belong in a
// future "Upcoming" section instead — not implemented yet.
export function filterReleasedNextEpisodes<T extends ProgressWithNextEpisode>(
  progress: T[],
  now: Date = new Date(),
): (T & { nextEpisode: NonNullable<T['nextEpisode']> })[] {
  return progress.filter(
    (p): p is T & { nextEpisode: NonNullable<T['nextEpisode']> } =>
      p.nextEpisode !== null && isEpisodeReleased(p.nextEpisode.airDate, now),
  );
}
