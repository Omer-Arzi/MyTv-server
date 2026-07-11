// Pure helpers for SeriesService — no Prisma calls, no I/O — kept separate
// so the library filter logic and season/episode grouping are unit-testable
// without a database, same pattern used throughout this project's
// import/enrichment pipelines.

import { Prisma, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { EpisodeSummaryDto } from '../../common/dto/episode-summary.dto';
import { deriveUserStatusFromNextEpisode } from '../../common/derive-user-status';
import { isEpisodeReleased } from '../../common/is-episode-released';
import { EpisodeDetailDto } from './dto/episode-detail.dto';
import { SeasonDetailDto } from './dto/season-detail.dto';
import { ManualUserStatus } from './dto/update-series-status.dto';

export interface LibraryFilters {
  userId: string;
  status?: UserSeriesStatus;
  releaseStatus?: ReleaseStatus;
  q?: string;
}

// GET /series is a personal "my library" view, not a browse-everything
// catalog — every result is scoped to a series the current user has some
// UserSeriesProgress relationship with (watchlisted, watching, paused,
// dropped, caught up, or completed — docs/status-model-plan.md §4), with
// status/releaseStatus/title-search narrowing that on top.
export function buildLibraryWhere(filters: LibraryFilters): Prisma.SeriesWhereInput {
  return {
    progress: {
      some: {
        userId: filters.userId,
        ...(filters.status ? { userStatus: filters.status } : {}),
      },
    },
    ...(filters.releaseStatus ? { releaseStatus: filters.releaseStatus } : {}),
    ...(filters.q ? { title: { contains: filters.q, mode: 'insensitive' } } : {}),
  };
}

export interface RawEpisodeForGrouping {
  id: string;
  seasonId: string;
  seasonNumber: number;
  seasonTitle: string | null;
  episodeNumber: number;
  title: string | null;
  overview: string | null;
  airDate: Date | null;
  runtimeMinutes: number | null;
  imageUrl: string | null;
}

export interface EpisodeWatchInfo {
  episodeWatchId: string;
  watchedAt: Date;
  note: string | null;
}

// Groups a flat, already (seasonNumber, episodeNumber)-ordered episode list
// into per-season buckets, merging in this user's watch state per episode.
// Input ordering is the caller's job (a DB query concern) — this function
// only groups and merges, it doesn't sort.
export function groupEpisodesBySeason(
  episodes: RawEpisodeForGrouping[],
  watchInfoByEpisodeId: ReadonlyMap<string, EpisodeWatchInfo>,
): SeasonDetailDto[] {
  const seasons = new Map<number, { title: string | null; episodes: EpisodeDetailDto[] }>();

  for (const ep of episodes) {
    const bucket = seasons.get(ep.seasonNumber) ?? { title: ep.seasonTitle, episodes: [] };
    const watch = watchInfoByEpisodeId.get(ep.id);

    const summary: EpisodeSummaryDto = {
      id: ep.id,
      seasonId: ep.seasonId,
      seasonNumber: ep.seasonNumber,
      episodeNumber: ep.episodeNumber,
      title: ep.title,
      overview: ep.overview,
      airDate: ep.airDate,
      runtimeMinutes: ep.runtimeMinutes,
      imageUrl: ep.imageUrl,
    };

    bucket.episodes.push({
      ...summary,
      watched: !!watch,
      watchedAt: watch?.watchedAt ?? null,
      note: watch?.note ?? null,
      episodeWatchId: watch?.episodeWatchId ?? null,
    });

    seasons.set(ep.seasonNumber, bucket);
  }

  return [...seasons.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seasonNumber, bucket]) => ({ seasonNumber, title: bucket.title, episodes: bucket.episodes }));
}

export interface OrderedEpisodeForNextLookup {
  id: string;
  airDate: Date | null;
}

// Finds the first unwatched, already-released episode in (seasonNumber,
// episodeNumber) order — same "first gap, not just after the last-watched
// position" semantics as next-episode-backfill/derive-next-episode.ts,
// reimplemented here (deliberately not imported — that module is a
// one-time offline backfill pipeline, this is a live request-path concern,
// and the task explicitly scopes this change away from touching that
// pipeline) rather than "next episode after wherever the user last
// clicked." Requiring isEpisodeReleased means a not-yet-aired episode is
// never returned as "next" even if it's the first unwatched one in order —
// see src/common/is-episode-released.ts for why.
export function findFirstUnwatchedEpisodeId(orderedEpisodes: OrderedEpisodeForNextLookup[], watchedEpisodeIds: ReadonlySet<string>, now: Date = new Date()): string | null {
  const next = orderedEpisodes.find((e) => !watchedEpisodeIds.has(e.id) && isEpisodeReleased(e.airDate, now));
  return next?.id ?? null;
}

export interface ManualStatusUpdateInput {
  userStatus: ManualUserStatus;
  orderedEpisodes: OrderedEpisodeForNextLookup[];
  watchedEpisodeIds: ReadonlySet<string>;
  // Only consulted when userStatus === WATCHING (a "resume watching" or
  // plain re-assert-active request) — needed to derive the ACTUAL correct
  // resulting status (see below), not just echo back WATCHING.
  releaseStatus: ReleaseStatus;
  // The row's nextEpisodeId as it stood before this update — preserved
  // verbatim for PAUSED/DROPPED (see below) rather than nulled, so a
  // pause/drop doesn't throw away a value the app already had correct.
  currentNextEpisodeId: string | null;
}

export interface ManualStatusUpdateResult {
  userStatus: UserSeriesStatus;
  nextEpisodeId: string | null;
}

export interface ActiveProgressInput {
  orderedEpisodes: OrderedEpisodeForNextLookup[];
  watchedEpisodeIds: ReadonlySet<string>;
  releaseStatus: ReleaseStatus;
  now?: Date;
}

export interface ActiveProgressResult {
  // Only ever WATCHING/CAUGHT_UP/COMPLETED — this is "what should an
  // actively-tracked series' progress be right now," never a
  // user-controlled/not-applicable value (PAUSED/DROPPED/WATCHLIST/UNKNOWN
  // are the caller's concern, not this function's — see
  // episode-release-refresh/progress-reconciliation-logic.ts for the
  // caller that adds that gating on top of this).
  userStatus: UserSeriesStatus;
  nextEpisodeId: string | null;
}

// The single canonical "what is this series' correct active progress right
// now, given its local episode catalog and watch history" computation —
// find the first unwatched, released episode
// (findFirstUnwatchedEpisodeId — unreleased episodes never count, see
// src/common/is-episode-released.ts), then derive WATCHING/CAUGHT_UP/
// COMPLETED from whether one was found (deriveUserStatusFromNextEpisode —
// the same function markWatched, watch-all, and unwatch all already use).
// Extracted out of deriveManualStatusUpdate's WATCHING branch below so
// episode-release-refresh's progress-reconciliation operation
// (docs/progress-reconciliation-architecture-todo.md) can reuse the exact
// same composition instead of a second implementation of it.
export function deriveActiveProgress(input: ActiveProgressInput): ActiveProgressResult {
  const nextEpisodeId = findFirstUnwatchedEpisodeId(input.orderedEpisodes, input.watchedEpisodeIds, input.now);
  return {
    nextEpisodeId,
    userStatus: deriveUserStatusFromNextEpisode(!!nextEpisodeId, input.releaseStatus),
  };
}

// The status-update rules from PATCH /series/:seriesId/status, as pure
// logic:
//
// - WATCHING (also how a "resume watching" action from PAUSED/DROPPED is
//   requested): re-derives nextEpisodeId/userStatus via deriveActiveProgress
//   above, rather than blindly echoing back WATCHING. A resume can
//   correctly land on CAUGHT_UP (every currently-known released episode is
//   already watched, show still airing) or COMPLETED (same, but the show
//   has ended/been cancelled), not just WATCHING. This is a deliberate
//   fix: the previous version of this function always returned literal
//   WATCHING here, which was wrong for exactly the "resume a series you're
//   already fully caught up on" case (docs/on-hold-dropped-status-todo.md
//   Phase 4).
// - PAUSED/DROPPED: userStatus is set exactly as requested (both are
//   explicit user intent, never re-derived), and nextEpisodeId is
//   PRESERVED from currentNextEpisodeId rather than cleared — the value is
//   still accurate internally (nothing recomputes it while paused/dropped;
//   episode-release-refresh's TRACKED_USER_STATUSES already excludes both),
//   it's just not surfaced in active Continue Watching presentation (that
//   exclusion is Watch Next's own userStatus=WATCHING filter, not a
//   nextEpisodeId concern) — see docs/on-hold-dropped-status-todo.md Phase 5.
// - WATCHLIST: nextEpisodeId is cleared, unchanged from before — a
//   watchlisted series is normally not-yet-started, and this task's scope
//   is PAUSED/DROPPED only.
//
// Never touches WatchlistItem — that's a DB side effect the service layer
// handles, not something pure logic should do.
export function deriveManualStatusUpdate(input: ManualStatusUpdateInput): ManualStatusUpdateResult {
  if (input.userStatus === UserSeriesStatus.WATCHING) {
    return deriveActiveProgress({
      orderedEpisodes: input.orderedEpisodes,
      watchedEpisodeIds: input.watchedEpisodeIds,
      releaseStatus: input.releaseStatus,
    });
  }

  if (input.userStatus === UserSeriesStatus.PAUSED || input.userStatus === UserSeriesStatus.DROPPED) {
    return { userStatus: input.userStatus, nextEpisodeId: input.currentNextEpisodeId };
  }

  return { userStatus: input.userStatus, nextEpisodeId: null };
}
