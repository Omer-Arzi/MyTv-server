// The one read-only Prisma query shape both library-health CLI scripts
// (run-health-report.ts and run-incomplete-catalog-investigation.ts) need:
// every series plus this user's progress/watch state, reshaped into
// health-logic.ts's pure SeriesHealthInput. Kept out of health-logic.ts
// itself (which must stay I/O-free) and out of run-health-report.ts (which
// has a top-level main().catch() side effect on import — never import a
// script file like that from another script) so it's safely shareable.

import { PrismaClient } from '@prisma/client';
import { LocalEpisodeHealthInput, SeriesHealthInput } from './health-logic';

export async function loadSeriesHealthInputs(prisma: PrismaClient, userId: string): Promise<SeriesHealthInput[]> {
  const [allSeries, watches] = await Promise.all([
    prisma.series.findMany({
      select: {
        id: true,
        title: true,
        releaseStatus: true,
        posterUrl: true,
        backdropUrl: true,
        externalIds: { select: { tmdbId: true, provider: true, providerId: true, matchConfidence: true, matchSource: true } },
        seasons: {
          select: {
            seasonNumber: true,
            episodes: { select: { id: true, episodeNumber: true, title: true, airDate: true } },
          },
        },
        progress: { where: { userId }, select: { userStatus: true, nextEpisodeId: true, lastWatchedAt: true } },
      },
    }),
    prisma.episodeWatch.findMany({ where: { userId }, select: { episodeId: true } }),
  ]);

  const watchedEpisodeIds = new Set(watches.map((w) => w.episodeId));

  return allSeries.map((series) => {
    const episodes: LocalEpisodeHealthInput[] = series.seasons.flatMap((season) =>
      season.episodes.map((ep) => ({
        id: ep.id,
        seasonNumber: season.seasonNumber,
        episodeNumber: ep.episodeNumber,
        title: ep.title,
        airDate: ep.airDate,
        watched: watchedEpisodeIds.has(ep.id),
      })),
    );

    return {
      seriesId: series.id,
      title: series.title,
      releaseStatus: series.releaseStatus,
      posterUrl: series.posterUrl,
      backdropUrl: series.backdropUrl,
      externalIds: series.externalIds
        ? {
            tmdbId: series.externalIds.tmdbId,
            provider: series.externalIds.provider,
            providerId: series.externalIds.providerId,
            matchConfidence: series.externalIds.matchConfidence,
            matchSource: series.externalIds.matchSource,
          }
        : null,
      episodes,
      progress: series.progress[0]
        ? { userStatus: series.progress[0].userStatus, nextEpisodeId: series.progress[0].nextEpisodeId, lastWatchedAt: series.progress[0].lastWatchedAt }
        : null,
    };
  });
}
