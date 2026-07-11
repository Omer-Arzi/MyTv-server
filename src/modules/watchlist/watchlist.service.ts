import { Injectable, NotFoundException } from '@nestjs/common';
import { UserSeriesStatus } from '@prisma/client';
import { toSeriesSummary } from '../../common/mappers';
import { PrismaService } from '../../prisma/prisma.service';
import { WatchlistItemDto } from './dto/watchlist-item.dto';
import { buildWatchlistTabWhere, isWatchlistTabEligible } from './watchlist-query-helpers';
import { classifySeriesForAttention } from '../../common/classify-series-for-attention';
import { hasConfirmedExternalId } from '../../common/has-confirmed-external-id';

@Injectable()
export class WatchlistService {
  constructor(private readonly prisma: PrismaService) {}

  // The Watchlist tab's product definition: the user's ACTIVE, TRUSTWORTHY
  // tracking list (currently watching, actively following, or planning to
  // start) — not their whole collection, and not every row that happens to
  // carry a WATCHING/CAUGHT_UP label. Queried directly off
  // UserSeriesProgress (the authoritative status source) rather than
  // WatchlistItem, so a series that moved on to PAUSED/DROPPED/COMPLETED
  // correctly disappears from this tab without any data being deleted or
  // any status being changed — it's still fully visible via GET /series
  // (Library tab). A real-DB audit found 81/105 (77%) of stored WATCHING
  // rows had no confirmed provider match — a frozen import-time default,
  // not a live derived truth — so isWatchlistTabEligible additionally
  // drops any WATCHING/CAUGHT_UP row without one; those series remain
  // visible in Library and in the Needs Attention inbox instead. Sorted
  // alphabetically by title, same plain-collation `asc` convention
  // series-query-helpers.ts's list query already uses (predictable,
  // browsable — the Home tab already owns dynamic/recency-based ordering).
  // Grouping into Watching/Caught Up/Watchlist sections and computing
  // per-section counts is left to the client — every item already carries
  // its own userStatus, so no extra backend shape is needed for that.
  async list(userId: string): Promise<WatchlistItemDto[]> {
    const progress = await this.prisma.userSeriesProgress.findMany({
      where: buildWatchlistTabWhere(userId),
      orderBy: { series: { title: 'asc' } },
      include: { series: { include: { externalIds: true } } },
    });

    const eligible = progress.filter((p) => isWatchlistTabEligible({ userStatus: p.userStatus, externalIds: p.series.externalIds }));

    return eligible.map((p) => {
      const hasConfirmedProviderMatch = hasConfirmedExternalId(p.series.externalIds);
      const classification = classifySeriesForAttention({ title: p.series.title, hasConfirmedProviderMatch });

      return {
        id: p.id,
        series: toSeriesSummary(p.series),
        userStatus: p.userStatus,
        attentionReasonCode: classification?.reasonCode ?? null,
      };
    });
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
        include: { series: { include: { externalIds: true } } },
      }),
      this.ensureWatchlistProgress(userId, seriesId),
    ]);

    const classification = classifySeriesForAttention({
      title: item.series.title,
      hasConfirmedProviderMatch: hasConfirmedExternalId(item.series.externalIds),
    });

    return {
      id: item.id,
      series: toSeriesSummary(item.series),
      userStatus,
      attentionReasonCode: classification?.reasonCode ?? null,
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
}
