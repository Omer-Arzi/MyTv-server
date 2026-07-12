import { Injectable, NotFoundException } from '@nestjs/common';
import { UserSeriesStatus } from '@prisma/client';
import { toEpisodeSummary, toSeriesSummary } from '../../common/mappers';
import { hasConfirmedExternalId } from '../../common/has-confirmed-external-id';
import { PrismaService } from '../../prisma/prisma.service';
import { SeriesDetailDto } from './dto/series-detail.dto';
import { SeriesListPageDto } from './dto/series-list-page.dto';
import { ManualUserStatus } from './dto/update-series-status.dto';
import { UpdateSeriesStatusResponseDto } from './dto/update-series-status-response.dto';
import {
  buildLibraryWhere,
  deriveManualStatusUpdate,
  groupEpisodesBySeason,
  LibraryFilters,
  OrderedEpisodeForNextLookup,
} from './series-query-helpers';
import { decodeCursor, encodeCursor } from '../../common/utils/cursor.util';

@Injectable()
export class SeriesService {
  constructor(private readonly prisma: PrismaService) {}

  async getDetail(userId: string, seriesId: string): Promise<SeriesDetailDto> {
    const series = await this.prisma.series.findUnique({
      where: { id: seriesId },
      include: { externalIds: true },
    });
    if (!series) {
      throw new NotFoundException(`Series ${seriesId} not found`);
    }

    const [progress, episodes, watches] = await Promise.all([
      this.prisma.userSeriesProgress.findUnique({
        where: { userId_seriesId: { userId, seriesId } },
        include: { nextEpisode: { include: { season: true } } },
      }),
      this.prisma.episode.findMany({
        where: { season: { seriesId } },
        orderBy: [{ season: { seasonNumber: 'asc' } }, { episodeNumber: 'asc' }],
        include: { season: true },
      }),
      this.prisma.episodeWatch.findMany({
        where: { userId, episode: { season: { seriesId } } },
        include: { note: true },
      }),
    ]);

    const watchInfoByEpisodeId = new Map(
      watches.map((w) => [w.episodeId, { episodeWatchId: w.id, watchedAt: w.watchedAt, note: w.note?.text ?? null }]),
    );

    const seasons = groupEpisodesBySeason(
      episodes.map((e) => ({
        id: e.id,
        seasonId: e.seasonId,
        seasonNumber: e.season.seasonNumber,
        seasonTitle: e.season.title,
        episodeNumber: e.episodeNumber,
        title: e.title,
        overview: e.overview,
        airDate: e.airDate,
        runtimeMinutes: e.runtimeMinutes,
        imageUrl: e.imageUrl,
      })),
      watchInfoByEpisodeId,
    );

    const hasAnyExternalId = hasConfirmedExternalId(series.externalIds);

    return {
      id: series.id,
      title: series.title,
      overview: series.overview,
      posterUrl: series.posterUrl,
      backdropUrl: series.backdropUrl,
      releaseStatus: series.releaseStatus,
      userStatus: progress?.userStatus ?? UserSeriesStatus.UNKNOWN,
      nextEpisode: progress?.nextEpisode ? toEpisodeSummary(progress.nextEpisode) : null,
      seasons,
      externalIds: hasAnyExternalId
        ? { tmdbId: series.externalIds!.tmdbId, traktId: series.externalIds!.traktId, imdbId: series.externalIds!.imdbId }
        : null,
    };
  }

  async list(userId: string, filters: Omit<LibraryFilters, 'userId'>, limit: number, cursor?: string): Promise<SeriesListPageDto> {
    const where = buildLibraryWhere({ userId, ...filters });

    let cursorId: string | undefined;
    if (cursor) {
      try {
        cursorId = decodeCursor(cursor);
      } catch {
        cursorId = undefined;
      }
    }

    const series = await this.prisma.series.findMany({
      where,
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      include: { progress: { where: { userId } } },
    });

    const hasMore = series.length > limit;
    const page = hasMore ? series.slice(0, limit) : series;

    return {
      items: page.map((s) => ({ ...toSeriesSummary(s), userStatus: s.progress[0]?.userStatus ?? UserSeriesStatus.UNKNOWN })),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1].id) : null,
    };
  }

  // PATCH /series/:seriesId/status — manual override of the personal
  // userStatus. Only ever called with one of MANUAL_USER_STATUSES
  // (UpdateSeriesStatusDto's @IsIn already rejects anything else with a
  // 400 before this method runs, so COMPLETED/CAUGHT_UP/UNKNOWN never
  // reach here). See docs/status-model-plan.md §4/§7 for why those two
  // stay auto-derived-only.
  async updateStatus(userId: string, seriesId: string, userStatus: ManualUserStatus): Promise<UpdateSeriesStatusResponseDto> {
    const series = await this.prisma.series.findUnique({ where: { id: seriesId }, select: { id: true, releaseStatus: true } });
    if (!series) {
      throw new NotFoundException(`Series ${seriesId} not found`);
    }

    // Only fetched when actually needed:
    // - episode catalog + watches: WATCHING only — deriveManualStatusUpdate
    //   uses these to find the next episode AND (via releaseStatus below)
    //   correctly derive WATCHING/CAUGHT_UP/COMPLETED rather than blindly
    //   returning WATCHING. airDate is fetched alongside id so
    //   findFirstUnwatchedEpisodeId can skip a not-yet-aired episode rather
    //   than surfacing it as "next" (src/common/is-episode-released.ts).
    // - the row's current nextEpisodeId: PAUSED/DROPPED only, so it can be
    //   preserved rather than cleared (see series-query-helpers.ts's
    //   deriveManualStatusUpdate doc comment).
    let orderedEpisodes: OrderedEpisodeForNextLookup[] = [];
    let watchedEpisodeIds = new Set<string>();
    let currentNextEpisodeId: string | null = null;

    if (userStatus === UserSeriesStatus.WATCHING) {
      const [episodes, watches] = await Promise.all([
        this.prisma.episode.findMany({
          where: { season: { seriesId } },
          orderBy: [{ season: { seasonNumber: 'asc' } }, { episodeNumber: 'asc' }],
          select: { id: true, airDate: true, season: { select: { seasonNumber: true } } },
        }),
        this.prisma.episodeWatch.findMany({ where: { userId, episode: { season: { seriesId } } }, select: { episodeId: true } }),
      ]);
      orderedEpisodes = episodes.map((e) => ({ id: e.id, airDate: e.airDate, seasonNumber: e.season.seasonNumber }));
      watchedEpisodeIds = new Set(watches.map((w) => w.episodeId));
    } else if (userStatus === UserSeriesStatus.PAUSED || userStatus === UserSeriesStatus.DROPPED) {
      const existingProgress = await this.prisma.userSeriesProgress.findUnique({
        where: { userId_seriesId: { userId, seriesId } },
        select: { nextEpisodeId: true },
      });
      currentNextEpisodeId = existingProgress?.nextEpisodeId ?? null;
    }

    const decision = deriveManualStatusUpdate({
      userStatus,
      orderedEpisodes,
      watchedEpisodeIds,
      releaseStatus: series.releaseStatus,
      currentNextEpisodeId,
    });

    const nextEpisode = await this.prisma.$transaction(async (tx) => {
      await tx.userSeriesProgress.upsert({
        where: { userId_seriesId: { userId, seriesId } },
        create: { userId, seriesId, userStatus: decision.userStatus, nextEpisodeId: decision.nextEpisodeId },
        update: { userStatus: decision.userStatus, nextEpisodeId: decision.nextEpisodeId },
      });

      // Keep WatchlistItem in sync so the dedicated Watchlist screen
      // (GET /watchlist, which queries WatchlistItem directly — see
      // docs/status-model-plan.md §4's "keep both tables" recommendation)
      // reflects a status set here, not just one set via
      // POST /series/:seriesId/watchlist. Only ever created, never
      // removed by this endpoint — same rule WatchlistService already
      // follows: a WatchlistItem is only ever removed by an explicit
      // DELETE, never as a side effect of userStatus moving on.
      if (decision.userStatus === UserSeriesStatus.WATCHLIST) {
        await tx.watchlistItem.upsert({
          where: { userId_seriesId: { userId, seriesId } },
          create: { userId, seriesId },
          update: {},
        });
      }

      if (!decision.nextEpisodeId) return null;
      return tx.episode.findUnique({ where: { id: decision.nextEpisodeId }, include: { season: true } });
    });

    return {
      seriesId,
      userStatus: decision.userStatus,
      nextEpisode: nextEpisode ? toEpisodeSummary(nextEpisode) : null,
    };
  }
}
