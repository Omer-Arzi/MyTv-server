import { BadRequestException, Injectable } from '@nestjs/common';
import { UserSeriesStatus, WatchSource } from '@prisma/client';
import { toEpisodeSummary, toSeriesSummary } from '../../common/mappers';
import { PrismaService } from '../../prisma/prisma.service';
import { decodeCursor, encodeCursor } from '../../common/utils/cursor.util';
import { RecentlyWatchedItemDto, RecentlyWatchedPageDto } from './dto/recently-watched-item.dto';
import { WatchNextItemDto } from './dto/watch-next-item.dto';
import { StaleSeriesItemDto } from './dto/stale-series-item.dto';
import { HavenStartedYetItemDto } from './dto/haven-started-yet-item.dto';
import {
  computeRemainingEpisodesAfterNext,
  deriveHavenStartedYetCandidates,
  filterNonStaleWatchNextCandidates,
  filterTrustedStaleCandidates,
  groupOrderedEpisodesBySeriesId,
  sortHavenStartedYetResults,
} from './me-query-helpers';
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

    // Excludes only BATCH-sourced watches (the "mark all released" escape
    // hatch — watch-all-logic.ts) — a domain-model distinction
    // (EpisodeWatch.watchSource), not a timestamp/heuristic filter. Every
    // other reader of watch history (progress/completion/next-episode
    // derivation, series-detail episode lists, watch-all's own dry-run
    // preview) queries EpisodeWatch directly with no such filter and is
    // completely unaffected — this exclusion is scoped to Recently Watched
    // alone. `not: BATCH` (not `equals: SINGLE`) so a future third source
    // value defaults to visible unless it's explicitly taught to hide too.
    const watches = await this.prisma.episodeWatch.findMany({
      where: { userId, watchSource: { not: WatchSource.BATCH } },
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

    const candidates = filterNonStaleWatchNextCandidates(progress, staleCutoff);
    const remainingEpisodesAfterNextBySeriesId = await this.getRemainingEpisodesAfterNextBySeriesId(userId, candidates);

    return candidates.map((p) => ({
      series: toSeriesSummary(p.series),
      nextEpisode: toEpisodeSummary(p.nextEpisode),
      lastWatchedAt: p.lastWatchedAt,
      userStatus: p.userStatus,
      remainingEpisodesAfterNext: remainingEpisodesAfterNextBySeriesId.get(p.seriesId) ?? null,
    }));
  }

  // Watch Next "+N" remaining-episodes indicator (mobile Continue Watching
  // card): one batched query across every candidate's series, rather than
  // one query per series. Only ever called with the already-filtered Watch
  // Next candidate list (never the full unfiltered progress set), so this
  // never fetches catalog data for a series that won't actually be
  // returned by getWatchNext. Also fetches this user's EpisodeWatch rows
  // for the batch (previously not fetched at all here) — the count must
  // exclude both future-dated AND already-watched episodes, not just
  // apply a raw catalog position (docs/watch-next-released-episode-semantics-todo.md).
  private async getRemainingEpisodesAfterNextBySeriesId(
    userId: string,
    candidates: { seriesId: string; nextEpisode: { id: string } }[],
  ): Promise<Map<string, number | null>> {
    if (candidates.length === 0) return new Map();

    const seriesIds = [...new Set(candidates.map((c) => c.seriesId))];
    const [episodes, watches] = await Promise.all([
      this.prisma.episode.findMany({
        where: { season: { seriesId: { in: seriesIds } } },
        orderBy: [{ season: { seasonNumber: 'asc' } }, { episodeNumber: 'asc' }],
        select: { id: true, airDate: true, season: { select: { seriesId: true } } },
      }),
      this.prisma.episodeWatch.findMany({
        where: { userId, episode: { season: { seriesId: { in: seriesIds } } } },
        select: { episodeId: true },
      }),
    ]);
    const watchedEpisodeIds = new Set(watches.map((w) => w.episodeId));

    const orderedEpisodesBySeriesId = groupOrderedEpisodesBySeriesId(
      episodes.map((episode) => ({ id: episode.id, seriesId: episode.season.seriesId, airDate: episode.airDate })),
    );

    const result = new Map<string, number | null>();
    for (const candidate of candidates) {
      const orderedEpisodes = orderedEpisodesBySeriesId.get(candidate.seriesId) ?? [];
      result.set(candidate.seriesId, computeRemainingEpisodesAfterNext(orderedEpisodes, candidate.nextEpisode.id, watchedEpisodeIds));
    }
    return result;
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

  // Derived Home section, not a persistent status — see
  // deriveHavenStartedYetCandidates for the full eligibility contract.
  // Queries every WATCHLIST series' full episode list (need every episode,
  // not just watched ones, to determine "zero watches" and "at least one
  // released regular episode" for series that have never been touched) plus
  // this user's watches scoped to just those series, in two queries rather
  // than one-per-series.
  async getHavenStartedYet(userId: string): Promise<HavenStartedYetItemDto[]> {
    const progress = await this.prisma.userSeriesProgress.findMany({
      where: { userId, userStatus: UserSeriesStatus.WATCHLIST },
      include: {
        series: {
          include: {
            externalIds: true,
            seasons: { include: { episodes: true } },
          },
        },
      },
    });
    if (progress.length === 0) return [];

    const seriesIds = progress.map((p) => p.seriesId);
    const watches = await this.prisma.episodeWatch.findMany({
      where: { userId, episode: { season: { seriesId: { in: seriesIds } } } },
      select: { episodeId: true },
    });
    const watchedEpisodeIds = new Set(watches.map((w) => w.episodeId));

    const candidates = progress.map((p) => ({
      seriesId: p.seriesId,
      seriesTitle: p.series.title,
      userStatus: p.userStatus,
      externalIds: p.series.externalIds ? { provider: p.series.externalIds.provider, providerId: p.series.externalIds.providerId } : null,
      episodes: p.series.seasons.flatMap((season) =>
        season.episodes.map((episode) => ({
          id: episode.id,
          seasonId: episode.seasonId,
          seasonNumber: season.seasonNumber,
          episodeNumber: episode.episodeNumber,
          title: episode.title,
          overview: episode.overview,
          airDate: episode.airDate,
          runtimeMinutes: episode.runtimeMinutes,
          imageUrl: episode.imageUrl,
        })),
      ),
    }));

    const results = deriveHavenStartedYetCandidates(candidates, watchedEpisodeIds);
    const titleBySeriesId = new Map(progress.map((p) => [p.seriesId, p.series.title]));
    const sorted = sortHavenStartedYetResults(results, titleBySeriesId);
    const seriesById = new Map(progress.map((p) => [p.seriesId, p.series]));

    return sorted.map((r) => ({
      series: toSeriesSummary(seriesById.get(r.seriesId)!),
      latestReleasedRegularEpisode: {
        id: r.latestReleasedRegularEpisode.id,
        seasonId: r.latestReleasedRegularEpisode.seasonId,
        seasonNumber: r.latestReleasedRegularEpisode.seasonNumber,
        episodeNumber: r.latestReleasedRegularEpisode.episodeNumber,
        title: r.latestReleasedRegularEpisode.title,
        overview: r.latestReleasedRegularEpisode.overview,
        airDate: r.latestReleasedRegularEpisode.airDate,
        runtimeMinutes: r.latestReleasedRegularEpisode.runtimeMinutes,
        imageUrl: r.latestReleasedRegularEpisode.imageUrl,
      },
      releasedRegularEpisodeCount: r.releasedRegularEpisodeCount,
    }));
  }
}
