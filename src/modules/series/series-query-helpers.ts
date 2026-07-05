// Pure helpers for SeriesService — no Prisma calls, no I/O — kept separate
// so the library filter logic and season/episode grouping are unit-testable
// without a database, same pattern used throughout this project's
// import/enrichment pipelines.

import { Prisma, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { EpisodeSummaryDto } from '../../common/dto/episode-summary.dto';
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
}

export interface ManualStatusUpdateResult {
  userStatus: UserSeriesStatus;
  nextEpisodeId: string | null;
}

// The status-update rules from PATCH /series/:seriesId/status, as pure
// logic: WATCHING re-derives nextEpisodeId from this user's currently-known
// episode catalog (best-effort — may come back null for a series with no
// episodes recorded yet, or if everything currently known is watched);
// PAUSED/DROPPED/WATCHLIST always clear it, since none of those states
// implies "here's what to watch next." Never touches WatchlistItem — that's
// a DB side effect the service layer handles, not something pure logic
// should do.
export function deriveManualStatusUpdate(input: ManualStatusUpdateInput): ManualStatusUpdateResult {
  if (input.userStatus === UserSeriesStatus.WATCHING) {
    return {
      userStatus: UserSeriesStatus.WATCHING,
      nextEpisodeId: findFirstUnwatchedEpisodeId(input.orderedEpisodes, input.watchedEpisodeIds),
    };
  }

  return { userStatus: input.userStatus, nextEpisodeId: null };
}
