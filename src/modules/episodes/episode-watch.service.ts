import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { toEpisodeSummary, toSeriesSummary } from '../../common/mappers';
import { deriveUserStatusFromNextEpisode } from '../../common/derive-user-status';
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

    const nextEpisode = await this.findNextEpisode(seriesId, episode.season.seasonNumber, episode.episodeNumber);

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

  // Next episode is the following episode number in the same season, or
  // episode 1 of the next season if the current one just ended.
  private findNextEpisode(seriesId: string, seasonNumber: number, episodeNumber: number) {
    return this.prisma.episode.findFirst({
      where: {
        season: { seriesId },
        OR: [
          { season: { seasonNumber }, episodeNumber: { gt: episodeNumber } },
          { season: { seasonNumber: { gt: seasonNumber } } },
        ],
      },
      orderBy: [{ season: { seasonNumber: 'asc' } }, { episodeNumber: 'asc' }],
      include: { season: true },
    });
  }
}
