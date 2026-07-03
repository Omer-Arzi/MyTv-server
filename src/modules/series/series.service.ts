import { Injectable, NotFoundException } from '@nestjs/common';
import { UserSeriesStatus } from '@prisma/client';
import { toEpisodeSummary, toSeriesSummary } from '../../common/mappers';
import { PrismaService } from '../../prisma/prisma.service';
import { SeriesDetailDto } from './dto/series-detail.dto';
import { SeriesListPageDto } from './dto/series-list-page.dto';
import { buildLibraryWhere, groupEpisodesBySeason, LibraryFilters } from './series-query-helpers';
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

    const watchInfoByEpisodeId = new Map(watches.map((w) => [w.episodeId, { watchedAt: w.watchedAt, note: w.note?.text ?? null }]));

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

    const hasAnyExternalId = !!series.externalIds && (series.externalIds.tmdbId || series.externalIds.traktId || series.externalIds.imdbId);

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
}
