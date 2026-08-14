// Write path for Phase 4's PendingProviderEpisode table — deliberately not
// part of the same transaction as applySeriesInsertPlan/createMissingSeasonsAndEpisodes:
// a pending-episode record is an independent side-table entry, never
// touches Episode/Season/EpisodeWatch/UserSeriesProgress, and upserting it
// is safe to retry on its own regardless of whether the catalog-insert side
// of a refresh succeeds or not.

import { PrismaClient } from '@prisma/client';
import { PendingEpisodeCandidate } from './numbering-resolution-logic';

export async function upsertPendingEpisodes(prisma: PrismaClient, seriesId: string, pending: PendingEpisodeCandidate[]): Promise<number> {
  let count = 0;
  for (const p of pending) {
    await prisma.pendingProviderEpisode.upsert({
      where: { tmdbEpisodeId: p.tmdbEpisodeId },
      create: {
        seriesId,
        tmdbEpisodeId: p.tmdbEpisodeId,
        providerSeasonNumber: p.providerSeasonNumber,
        providerEpisodeNumber: p.providerEpisodeNumber,
        title: p.title,
        overview: p.overview,
        airDate: p.airDate,
        imageUrl: p.imageUrl,
        runtimeMinutes: p.runtimeMinutes,
      },
      update: {
        providerSeasonNumber: p.providerSeasonNumber,
        providerEpisodeNumber: p.providerEpisodeNumber,
        title: p.title,
        overview: p.overview,
        airDate: p.airDate,
        imageUrl: p.imageUrl,
        runtimeMinutes: p.runtimeMinutes,
      },
    });
    count++;
  }
  return count;
}
