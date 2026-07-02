import { BadRequestException, Injectable } from '@nestjs/common';
import { UserSeriesStatus } from '@prisma/client';
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

  // docs/status-model-plan.md §8: DROPPED/PAUSED/WATCHLIST are explicitly
  // not-actively-engaged, COMPLETED/UNKNOWN have nothing to prompt. CAUGHT_UP
  // is left in on purpose rather than excluded — it structurally can never
  // have a nextEpisodeId, so the nextEpisodeId filter below already excludes
  // it; excluding it here too would be redundant, not wrong.
  private static readonly WATCH_NEXT_EXCLUDED_STATUSES: UserSeriesStatus[] = [
    UserSeriesStatus.DROPPED,
    UserSeriesStatus.PAUSED,
    UserSeriesStatus.COMPLETED,
    UserSeriesStatus.WATCHLIST,
    UserSeriesStatus.UNKNOWN,
  ];

  // docs/status-model-plan.md §8: DROPPED/COMPLETED are excluded because
  // re-nudging about a show the user already disengaged from (or fully
  // finished) is noise, not a useful prompt. Everything else stays eligible —
  // PAUSED/WATCHLIST/CAUGHT_UP/UNKNOWN rows will only ever appear here if
  // they also happen to have a non-null, old lastWatchedAt.
  private static readonly STALE_EXCLUDED_STATUSES: UserSeriesStatus[] = [UserSeriesStatus.DROPPED, UserSeriesStatus.COMPLETED];

  async getWatchNext(userId: string): Promise<WatchNextItemDto[]> {
    const progress = await this.prisma.userSeriesProgress.findMany({
      where: {
        userId,
        userStatus: { notIn: MeService.WATCH_NEXT_EXCLUDED_STATUSES },
        nextEpisodeId: { not: null },
      },
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
        userStatus: p.userStatus,
      }));
  }

  async getStaleSeries(userId: string, afterDays: number): Promise<StaleSeriesItemDto[]> {
    const cutoff = new Date(Date.now() - afterDays * 24 * 60 * 60 * 1000);

    const progress = await this.prisma.userSeriesProgress.findMany({
      where: {
        userId,
        userStatus: { notIn: MeService.STALE_EXCLUDED_STATUSES },
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
      userStatus: p.userStatus,
    }));
  }
}
