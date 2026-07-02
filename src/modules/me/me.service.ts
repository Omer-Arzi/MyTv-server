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

  // docs/status-model-plan.md §8: an INCLUDE-list, not an exclude-list, so
  // this section can never silently start showing a future userStatus value
  // without a deliberate decision to add it here. WATCHING is the only value
  // that occurs in practice today; CAUGHT_UP is included because it's
  // correct once enrichment can assign it (nothing does yet). DROPPED/
  // COMPLETED/WATCHLIST are excluded because re-nudging about a show the
  // user disengaged from, fully finished, or never started is noise, not a
  // useful prompt. PAUSED is excluded for now too — a user who explicitly
  // paused a show already told MyTv they know they stopped, so resurfacing
  // it here would be redundant; revisit if that turns out to be poor UX.
  private static readonly STALE_INCLUDED_STATUSES: UserSeriesStatus[] = [UserSeriesStatus.WATCHING, UserSeriesStatus.CAUGHT_UP];

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
        userStatus: { in: MeService.STALE_INCLUDED_STATUSES },
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
