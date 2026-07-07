// Pure helpers for the manual progress correction plan. No Prisma calls, no
// I/O — same "pure logic, tested standalone" pattern as every other audit
// tool in this repo (watch-next-audit/, stale-series-audit/, etc.). These
// are deliberately small, mechanical building blocks — the actual per-item
// decisions (which series, which risks, which readiness bucket) are
// hand-assembled in run-plan.ts against real, inspected DB state rather than
// inferred generically, because 19 distinct user-provided manual decisions
// don't reduce to one classifier the way a single audit category does.

import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { deriveUserStatusFromNextEpisode } from '../src/common/derive-user-status';

export interface EpisodeRef {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  airDate: Date | null;
}

export function findEpisodeBySeasonEpisode(episodes: EpisodeRef[], seasonNumber: number, episodeNumber: number): EpisodeRef | null {
  return episodes.find((e) => e.seasonNumber === seasonNumber && e.episodeNumber === episodeNumber) ?? null;
}

// Case-insensitive, whitespace-trimmed exact match — deliberately not fuzzy.
// A wrong "close enough" title match here would mean setting nextEpisodeId
// to the wrong episode, so this only ever returns an exact match or null.
export function findEpisodeByExactTitle(episodes: EpisodeRef[], title: string): EpisodeRef | null {
  const needle = title.trim().toLowerCase();
  return episodes.find((e) => e.title?.trim().toLowerCase() === needle) ?? null;
}

// `orderedEpisodes` must already be ordered chronologically (season asc,
// episode asc within season) — the only ordering absolute/global episode
// numbering can mean for a season-structured catalog. 1-based, matching how
// "episode 1158" is naturally spoken about.
export function findEpisodeByAbsolutePosition(orderedEpisodes: EpisodeRef[], absolutePosition: number): EpisodeRef | null {
  if (absolutePosition < 1) return null;
  return orderedEpisodes[absolutePosition - 1] ?? null;
}

export function computeUnwatchedKnownEpisodes(episodes: EpisodeRef[], watchedEpisodeIds: ReadonlySet<string>): EpisodeRef[] {
  return episodes.filter((e) => !watchedEpisodeIds.has(e.id));
}

// What userStatus should become after "mark everything currently known as
// watched" — reuses the app's own existing single source of truth
// (src/common/derive-user-status.ts) rather than inventing new status logic
// for this report. hasNextEpisode is always false here because this helper
// is only used once every known episode has been accounted for.
export function deriveStatusAfterMarkAllWatched(releaseStatus: ReleaseStatus): UserSeriesStatus {
  return deriveUserStatusFromNextEpisode(false, releaseStatus);
}
