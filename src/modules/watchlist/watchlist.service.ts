import { Injectable, NotFoundException } from '@nestjs/common';
import { UserSeriesStatus } from '@prisma/client';
import { toSeriesSummary } from '../../common/mappers';
import { PrismaService } from '../../prisma/prisma.service';
import { WatchlistItemDto } from './dto/watchlist-item.dto';

@Injectable()
export class WatchlistService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<WatchlistItemDto[]> {
    const items = await this.prisma.watchlistItem.findMany({
      where: { userId },
      orderBy: { addedAt: 'desc' },
      include: { series: true },
    });

    // WatchlistItem and UserSeriesProgress aren't directly related in the
    // schema (both keyed by userId+seriesId independently) — fetched
    // separately and merged so a series that moved on to WATCHING (etc.)
    // after being watchlisted still reports its real current userStatus
    // here, not a stale WATCHLIST.
    const progressBySeriesId = await this.progressStatusBySeriesId(
      userId,
      items.map((i) => i.seriesId),
    );

    return items.map((item) => ({
      id: item.id,
      addedAt: item.addedAt,
      series: toSeriesSummary(item.series),
      userStatus: progressBySeriesId.get(item.seriesId) ?? UserSeriesStatus.WATCHLIST,
    }));
  }

  async add(userId: string, seriesId: string): Promise<WatchlistItemDto> {
    const series = await this.prisma.series.findUnique({ where: { id: seriesId } });
    if (!series) {
      throw new NotFoundException(`Series ${seriesId} not found`);
    }

    const [item, userStatus] = await Promise.all([
      this.prisma.watchlistItem.upsert({
        where: { userId_seriesId: { userId, seriesId } },
        create: { userId, seriesId },
        update: {},
        include: { series: true },
      }),
      this.ensureWatchlistProgress(userId, seriesId),
    ]);

    return {
      id: item.id,
      addedAt: item.addedAt,
      series: toSeriesSummary(item.series),
      userStatus,
    };
  }

  async remove(userId: string, seriesId: string): Promise<void> {
    const item = await this.prisma.watchlistItem.findUnique({
      where: { userId_seriesId: { userId, seriesId } },
    });
    if (!item) {
      throw new NotFoundException(`Series ${seriesId} is not in the watchlist`);
    }

    await this.prisma.watchlistItem.delete({ where: { id: item.id } });

    // If the only reason a UserSeriesProgress row existed was the watchlist
    // membership (userStatus is still WATCHLIST — nothing else ever
    // happened), remove it too rather than leaving a status-less orphan
    // row. A row with any other status reflects real watch activity and is
    // untouched by removing from the watchlist. See docs/status-model-plan.md §4.
    const progress = await this.prisma.userSeriesProgress.findUnique({
      where: { userId_seriesId: { userId, seriesId } },
    });
    if (progress && progress.userStatus === UserSeriesStatus.WATCHLIST) {
      await this.prisma.userSeriesProgress.delete({ where: { id: progress.id } });
    }
  }

  // Creates a UserSeriesProgress row at WATCHLIST if none exists yet, or
  // promotes an UNKNOWN row to WATCHLIST. Never downgrades a row that
  // already reflects real watch activity (WATCHING/PAUSED/DROPPED/
  // CAUGHT_UP/COMPLETED) — adding an already-started show to the watchlist
  // shouldn't erase that progress. Returns the row's resulting userStatus.
  private async ensureWatchlistProgress(userId: string, seriesId: string): Promise<UserSeriesStatus> {
    const existing = await this.prisma.userSeriesProgress.findUnique({
      where: { userId_seriesId: { userId, seriesId } },
    });

    if (!existing) {
      const created = await this.prisma.userSeriesProgress.create({
        data: { userId, seriesId, userStatus: UserSeriesStatus.WATCHLIST },
      });
      return created.userStatus;
    }

    if (existing.userStatus === UserSeriesStatus.UNKNOWN) {
      const updated = await this.prisma.userSeriesProgress.update({
        where: { id: existing.id },
        data: { userStatus: UserSeriesStatus.WATCHLIST },
      });
      return updated.userStatus;
    }

    return existing.userStatus;
  }

  private async progressStatusBySeriesId(userId: string, seriesIds: string[]): Promise<Map<string, UserSeriesStatus>> {
    if (seriesIds.length === 0) return new Map();

    const rows = await this.prisma.userSeriesProgress.findMany({
      where: { userId, seriesId: { in: seriesIds } },
      select: { seriesId: true, userStatus: true },
    });
    return new Map(rows.map((r) => [r.seriesId, r.userStatus]));
  }
}
