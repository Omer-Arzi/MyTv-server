import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { toEpisodeSummary, toSeriesSummary } from '../../common/mappers';
import { deriveUserStatusFromNextEpisode } from '../../common/derive-user-status';
import { findFirstUnwatchedEpisodeId, OrderedEpisodeForNextLookup } from '../series/series-query-helpers';
import { MarkWatchedResponseDto } from './dto/mark-watched-response.dto';
import { EpisodeWatchDto } from './dto/episode-watch.dto';

@Injectable()
export class EpisodeWatchService {
  constructor(private readonly prisma: PrismaService) {}

  async markWatched(userId: string, episodeId: string): Promise<MarkWatchedResponseDto> {
    const episode = await this.prisma.episode.findUnique({
      where: { id: episodeId },
      include: { season: { include: { series: true } } },
    });
    if (!episode) {
      throw new NotFoundException(`Episode ${episodeId} not found`);
    }

    const seriesId = episode.season.seriesId;

    const watch = await this.prisma.episodeWatch.upsert({
      where: { userId_episodeId: { userId, episodeId } },
      create: { userId, episodeId },
      update: { watchedAt: new Date() },
      include: { note: true },
    });

    const nextEpisode = await this.findNextEpisode(userId, seriesId);

    // A fresh watch is the strongest signal available — always overwrite
    // userStatus (clears any prior WATCHLIST/PAUSED/DROPPED without a
    // separate "resume" step) rather than only filling it in on create.
    // See docs/status-model-plan.md §6.
    const userStatus = deriveUserStatusFromNextEpisode(!!nextEpisode, episode.season.series.releaseStatus);

    await this.prisma.userSeriesProgress.upsert({
      where: { userId_seriesId: { userId, seriesId } },
      create: {
        userId,
        seriesId,
        lastWatchedAt: watch.watchedAt,
        nextEpisodeId: nextEpisode?.id ?? null,
        userStatus,
      },
      update: {
        lastWatchedAt: watch.watchedAt,
        nextEpisodeId: nextEpisode?.id ?? null,
        userStatus,
      },
    });

    return {
      watch: {
        id: watch.id,
        watchedAt: watch.watchedAt,
        note: watch.note?.text ?? null,
        episode: toEpisodeSummary(episode),
      },
      series: toSeriesSummary(episode.season.series),
      nextEpisode: nextEpisode ? toEpisodeSummary(nextEpisode) : null,
      seriesCompleted: !nextEpisode,
      userStatus,
    };
  }

  async addNote(userId: string, watchId: string, text: string): Promise<EpisodeWatchDto> {
    const watch = await this.prisma.episodeWatch.findUnique({
      where: { id: watchId },
      include: { episode: { include: { season: true } } },
    });
    if (!watch || watch.userId !== userId) {
      throw new NotFoundException(`Episode watch ${watchId} not found`);
    }

    const note = await this.prisma.episodeNote.upsert({
      where: { episodeWatchId: watchId },
      create: { episodeWatchId: watchId, text },
      update: { text },
    });

    return {
      id: watch.id,
      watchedAt: watch.watchedAt,
      note: note.text,
      episode: toEpisodeSummary(watch.episode),
    };
  }

  // Next episode is the first released, not-yet-watched episode in
  // (seasonNumber, episodeNumber) order for this user — the same "first
  // gap" semantics as PATCH /series/:seriesId/status
  // (series-query-helpers.ts's findFirstUnwatchedEpisodeId, reused here
  // rather than reimplemented a third time).
  //
  // This used to just look for "the episode immediately after the one
  // being marked," with no check against what's actually been watched.
  // That regresses out-of-order watching: skipping S1E2 to watch S1E3
  // permanently hid S1E2 from Watch Next, and later watching the skipped
  // S1E2 would compute S1E3 as "next" again even though it was already
  // watched, overwriting nextEpisodeId with an already-watched episode.
  private async findNextEpisode(userId: string, seriesId: string) {
    const [episodes, watches] = await Promise.all([
      this.prisma.episode.findMany({
        where: { season: { seriesId } },
        orderBy: [{ season: { seasonNumber: 'asc' } }, { episodeNumber: 'asc' }],
        select: { id: true, airDate: true },
      }),
      this.prisma.episodeWatch.findMany({ where: { userId, episode: { season: { seriesId } } }, select: { episodeId: true } }),
    ]);

    const orderedEpisodes: OrderedEpisodeForNextLookup[] = episodes;
    const watchedEpisodeIds = new Set(watches.map((w) => w.episodeId));
    const nextEpisodeId = findFirstUnwatchedEpisodeId(orderedEpisodes, watchedEpisodeIds);
    if (!nextEpisodeId) return null;

    return this.prisma.episode.findUnique({ where: { id: nextEpisodeId }, include: { season: true } });
  }
}
