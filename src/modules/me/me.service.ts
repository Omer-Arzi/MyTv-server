import { BadRequestException, Injectable } from '@nestjs/common';
import { ProgressStatus } from '@prisma/client';
import { toEpisodeSummary, toSeriesSummary } from '../../common/mappers';
import { PrismaService } from '../../prisma/prisma.service';
import { decodeCursor, encodeCursor } from '../../common/utils/cursor.util';
import { RecentlyWatchedItemDto, RecentlyWatchedPageDto } from './dto/recently-watched-item.dto';
import { WatchNextItemDto } from './dto/watch-next-item.dto';
import { StaleSeriesItemDto } from './dto/stale-series-item.dto';

@Injectable()
export class MeService {
  constructor(private readonly prisma: PrismaService) {}

  async getRecentlyWatched(userId: string, limit: number, before?: string): Promise<RecentlyWatchedPageDto> {
    let cursorId: string | undefined;
    if (before) {
      try {
        cursorId = decodeCursor(before);
      } catch {
        throw new BadRequestException('Invalid "before" cursor');
      }
    }

    const watches = await this.prisma.episodeWatch.findMany({
      where: { userId },
      orderBy: [{ watchedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      include: {
        note: true,
        episode: { include: { season: { include: { series: true } } } },
      },
    });

    const hasMore = watches.length > limit;
    const page = hasMore ? watches.slice(0, limit) : watches;

    const items: RecentlyWatchedItemDto[] = page.map((watch) => ({
      watchId: watch.id,
      watchedAt: watch.watchedAt,
      note: watch.note?.text ?? null,
      series: toSeriesSummary(watch.episode.season.series),
      episode: toEpisodeSummary(watch.episode),
    }));

    return {
      items,
      nextCursor: hasMore ? encodeCursor(page[page.length - 1].id) : null,
    };
  }

  async getWatchNext(userId: string): Promise<WatchNextItemDto[]> {
    const progress = await this.prisma.userSeriesProgress.findMany({
      where: { userId, status: ProgressStatus.WATCHING, nextEpisodeId: { not: null } },
      orderBy: { lastWatchedAt: 'desc' },
      include: {
        series: true,
        nextEpisode: { include: { season: true } },
      },
    });

    return progress
      .filter((p) => p.nextEpisode !== null)
      .map((p) => ({
        series: toSeriesSummary(p.series),
        nextEpisode: toEpisodeSummary(p.nextEpisode!),
        lastWatchedAt: p.lastWatchedAt,
      }));
  }

  async getStaleSeries(userId: string, afterDays: number): Promise<StaleSeriesItemDto[]> {
    const cutoff = new Date(Date.now() - afterDays * 24 * 60 * 60 * 1000);

    const progress = await this.prisma.userSeriesProgress.findMany({
      where: {
        userId,
        status: ProgressStatus.WATCHING,
        lastWatchedAt: { not: null, lt: cutoff },
      },
      orderBy: { lastWatchedAt: 'asc' },
      include: {
        series: true,
        nextEpisode: { include: { season: true } },
      },
    });

    return progress.map((p) => ({
      series: toSeriesSummary(p.series),
      lastWatchedAt: p.lastWatchedAt,
      nextEpisode: p.nextEpisode ? toEpisodeSummary(p.nextEpisode) : null,
    }));
  }
}
