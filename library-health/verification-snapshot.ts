// Real-DB snapshot capture for verification-logic.ts. A thin Prisma read
// layer, not a run-*.ts orchestration script — safe to import from tests
// (no main() at module scope, unlike run-provider-confirmation-pipeline.ts).

import { PrismaClient } from '@prisma/client';
import { SeriesSnapshot } from './verification-logic';

export async function captureSeriesSnapshot(prisma: PrismaClient, seriesId: string, userId: string): Promise<SeriesSnapshot> {
  const seasons = await prisma.season.findMany({
    where: { seriesId },
    select: { seasonNumber: true, importBatchId: true, episodes: { select: { id: true, episodeNumber: true, importBatchId: true } } },
  });

  const episodes = seasons.flatMap((season) =>
    season.episodes.map((e) => ({ id: e.id, seasonNumber: season.seasonNumber, episodeNumber: e.episodeNumber, importBatchId: e.importBatchId })),
  );

  const episodeIds = episodes.map((e) => e.id);
  const watches = episodeIds.length > 0 ? await prisma.episodeWatch.findMany({ where: { userId, episodeId: { in: episodeIds } }, select: { episodeId: true } }) : [];

  const progress = await prisma.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId, seriesId } }, select: { userStatus: true, nextEpisodeId: true } });

  return {
    seriesId,
    episodes,
    seasons: seasons.map((s) => ({ seasonNumber: s.seasonNumber, importBatchId: s.importBatchId })),
    episodeWatches: watches,
    progress: progress ? { userStatus: progress.userStatus, nextEpisodeId: progress.nextEpisodeId } : null,
  };
}
