// Pure helpers for SeriesService — no Prisma calls, no I/O — kept separate
// so the library filter logic and season/episode grouping are unit-testable
// without a database, same pattern used throughout this project's
// import/enrichment pipelines.

import { Prisma, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { EpisodeSummaryDto } from '../../common/dto/episode-summary.dto';
import { EpisodeDetailDto } from './dto/episode-detail.dto';
import { SeasonDetailDto } from './dto/season-detail.dto';

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
    });

    seasons.set(ep.seasonNumber, bucket);
  }

  return [...seasons.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seasonNumber, bucket]) => ({ seasonNumber, title: bucket.title, episodes: bucket.episodes }));
}
