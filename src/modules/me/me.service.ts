import { BadRequestException, Injectable } from '@nestjs/common';
import { UserSeriesStatus } from '@prisma/client';
import { toEpisodeSummary, toSeriesSummary } from '../../common/mappers';
import { PrismaService } from '../../prisma/prisma.service';
import { decodeCursor, encodeCursor } from '../../common/utils/cursor.util';
import { RecentlyWatchedItemDto, RecentlyWatchedPageDto } from './dto/recently-watched-item.dto';
import { WatchNextItemDto } from './dto/watch-next-item.dto';
import { StaleSeriesItemDto } from './dto/stale-series-item.dto';
import { filterNonStaleWatchNextCandidates, filterTrustedStaleCandidates } from './me-query-helpers';
import { DEFAULT_STALE_AFTER_DAYS } from '../../common/stale-series-trust';

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

  // docs/status-model-plan.md §8's literal query: userStatus = 'watching'
  // AND nextEpisodeId IS NOT NULL — an exact-match include, not an
  // exclude-list. This used to be an exclude-list that happened to produce
  // the same result only because CAUGHT_UP could never have a non-null
  // nextEpisodeId; the next-episode-backfill can now find a newly-available
  // episode for a CAUGHT_UP row, and moves it to WATCHING when it does
  // (caught_up is only a valid state while nextEpisodeId is null — §4), so
  // that invariant is enforced at the write side, not relied on here.
  // Matching the spec's literal equality check means this can't silently
  // regress if a future write path ever produces a CAUGHT_UP-with-
  // nextEpisodeId row again.
  //
  // Watch Next / stale-series overlap fix: the same series used to be able
  // to appear in both sections at once (a WATCHING series with a released
  // nextEpisode but a very old lastWatchedAt). The two are mutually
  // exclusive by product definition — a series that's gone stale belongs in
  // "haven't watched for a while," not in "continue watching" — so this
  // excludes anything that would also qualify as a trusted stale candidate,
  // using the exact same threshold and trust rules getStaleSeries uses
  // below (DEFAULT_STALE_AFTER_DAYS, isTrustedStaleCandidate).
  async getWatchNext(userId: string): Promise<WatchNextItemDto[]> {
    const staleCutoff = new Date(Date.now() - DEFAULT_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000);

    const progress = await this.prisma.userSeriesProgress.findMany({
      where: {
        userId,
        userStatus: UserSeriesStatus.WATCHING,
        nextEpisodeId: { not: null },
      },
      orderBy: { lastWatchedAt: 'desc' },
      include: {
        series: true,
        nextEpisode: { include: { season: true } },
      },
    });

    return filterNonStaleWatchNextCandidates(progress, staleCutoff).map((p) => ({
      series: toSeriesSummary(p.series),
      nextEpisode: toEpisodeSummary(p.nextEpisode),
      lastWatchedAt: p.lastWatchedAt,
      userStatus: p.userStatus,
    }));
  }

  // stale-series-audit/output/stale-series-accuracy-report.md found this
  // endpoint nudging users about series that were already CAUGHT_UP (nothing
  // left to watch) or had no known next episode at all — old lastWatchedAt
  // was the only thing being checked. "Haven't watched for a while" now
  // means the same thing Watch Next does (userStatus = WATCHING, a real
  // released nextEpisodeId — same trust gate as getWatchNext above), plus
  // this section's own point: it's been a while (lastWatchedAt older than
  // afterDays) and the series isn't on the known
  // episode-numbering/season-shift risk list (see
  // src/common/stale-series-trust.ts).
  async getStaleSeries(userId: string, afterDays: number): Promise<StaleSeriesItemDto[]> {
    const cutoff = new Date(Date.now() - afterDays * 24 * 60 * 60 * 1000);

    const progress = await this.prisma.userSeriesProgress.findMany({
      where: {
        userId,
        userStatus: UserSeriesStatus.WATCHING,
        nextEpisodeId: { not: null },
        lastWatchedAt: { not: null, lt: cutoff },
      },
      orderBy: { lastWatchedAt: 'asc' },
      include: {
        series: true,
        nextEpisode: { include: { season: true } },
      },
    });

    return filterTrustedStaleCandidates(progress, cutoff).map((p) => ({
      series: toSeriesSummary(p.series),
      lastWatchedAt: p.lastWatchedAt,
      nextEpisode: toEpisodeSummary(p.nextEpisode),
      userStatus: p.userStatus,
    }));
  }
}
