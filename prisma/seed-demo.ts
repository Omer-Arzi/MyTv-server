// The actual destructive demo-data seed — deliberately kept out of the
// `npx prisma db seed` main path (seed.ts just points here) per the
// 2026-07-04 incident this file's guard exists to prevent (see
// seed-guard.ts's header comment for the full story).
//
// Self-guarded: this file checks safety itself before doing anything
// destructive, so running it directly (`ts-node prisma/seed-demo.ts`)
// is exactly as safe as going through seed.ts — there is no bypass.

import { PrismaClient, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { DEV_USER_DISPLAY_NAME, DEV_USER_EMAIL, DEV_USER_ID } from '../src/common/constants';
import { evaluateSeedSafety } from './seed-guard';

const prisma = new PrismaClient();

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

async function assertSafeToRun(): Promise<void> {
  const [importBatchCount, taggedSeriesCount, taggedEpisodeCount, taggedWatchCount] = await Promise.all([
    prisma.importBatch.count(),
    prisma.series.count({ where: { importBatchId: { not: null } } }),
    prisma.episode.count({ where: { importBatchId: { not: null } } }),
    prisma.episodeWatch.count({ where: { importBatchId: { not: null } } }),
  ]);

  const result = evaluateSeedSafety({
    allowDestructiveFlagSet: process.env.ALLOW_DESTRUCTIVE_SEED === 'true',
    importBatchCount,
    taggedRowCount: taggedSeriesCount + taggedEpisodeCount + taggedWatchCount,
  });

  console.log(result.reason);
  if (!result.safe) {
    process.exit(1);
  }
}

async function main() {
  await assertSafeToRun();

  console.log('Seeding demo database...');

  // Wipe existing data (order matters for FKs). Only reached once
  // assertSafeToRun() has already confirmed this is not a real database.
  await prisma.episodeNote.deleteMany();
  await prisma.episodeWatch.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.userSeriesProgress.deleteMany();
  await prisma.externalIds.deleteMany();
  await prisma.episode.deleteMany();
  await prisma.season.deleteMany();
  await prisma.series.deleteMany();
  await prisma.user.deleteMany();

  const user = await prisma.user.create({
    data: {
      id: DEV_USER_ID,
      email: DEV_USER_EMAIL,
      displayName: DEV_USER_DISPLAY_NAME,
    },
  });

  // --- Series 1: Quantum Kitchen — unwatched, sitting on the watchlist ---
  const quantumKitchen = await prisma.series.create({
    data: {
      title: 'Quantum Kitchen',
      overview: 'Competing chefs cook against the laws of physics.',
      posterUrl: 'https://images.example.com/quantum-kitchen/poster.jpg',
      releaseStatus: ReleaseStatus.RETURNING,
      seasons: {
        create: [
          {
            seasonNumber: 1,
            title: 'Season 1',
            episodes: {
              create: Array.from({ length: 10 }, (_, i) => ({
                episodeNumber: i + 1,
                title: `Course ${i + 1}`,
                overview: `Episode ${i + 1} of Quantum Kitchen, season 1.`,
                airDate: new Date(2025, 0, 5 + i * 7),
                runtimeMinutes: 35,
              })),
            },
          },
        ],
      },
    },
  });

  await prisma.watchlistItem.create({
    data: { userId: user.id, seriesId: quantumKitchen.id, addedAt: daysAgo(3) },
  });
  // Per docs/status-model-plan.md §4: a WatchlistItem should always have a
  // matching UserSeriesProgress row at WATCHLIST — the watchlist service
  // keeps this in sync going forward, but seed data bypasses the service
  // layer, so it's created directly here.
  await prisma.userSeriesProgress.create({
    data: { userId: user.id, seriesId: quantumKitchen.id, userStatus: UserSeriesStatus.WATCHLIST },
  });

  // --- Series 2: Signal & Noise — finished show, fully watched -> COMPLETED ---
  // Demonstrates the distinction this status model exists for: unlike a
  // WATCHING series with more known episodes to go, this series has
  // releaseStatus=ENDED and nothing left to watch, so it resolves to
  // COMPLETED rather than CAUGHT_UP — and should never appear in Watch Next
  // or Haven't Watched For A While.
  const signalAndNoise = await prisma.series.create({
    data: {
      title: 'Signal & Noise',
      overview: 'Two rival radio hosts investigate a decades-old disappearance.',
      posterUrl: 'https://images.example.com/signal-and-noise/poster.jpg',
      releaseStatus: ReleaseStatus.ENDED,
      seasons: {
        create: [
          {
            seasonNumber: 1,
            title: 'Season 1',
            episodes: {
              create: Array.from({ length: 4 }, (_, i) => ({
                episodeNumber: i + 1,
                title: ['Dead Air', 'Static', 'The Frequency', 'Sign Off'][i],
                overview: `Episode ${i + 1} of Signal & Noise, season 1.`,
                airDate: new Date(2022, 3, 1 + i * 7),
                runtimeMinutes: 45,
              })),
            },
          },
        ],
      },
    },
    include: { seasons: { include: { episodes: { orderBy: { episodeNumber: 'asc' } } } } },
  });
  const snEpisodes = signalAndNoise.seasons[0].episodes;
  let lastSnWatchedAt = daysAgo(20);
  for (let i = 0; i < snEpisodes.length; i++) {
    lastSnWatchedAt = daysAgo(20 - i);
    await prisma.episodeWatch.create({
      data: { userId: user.id, episodeId: snEpisodes[i].id, watchedAt: lastSnWatchedAt },
    });
  }
  await prisma.userSeriesProgress.create({
    data: {
      userId: user.id,
      seriesId: signalAndNoise.id,
      userStatus: UserSeriesStatus.COMPLETED,
      lastWatchedAt: lastSnWatchedAt,
      nextEpisodeId: null,
    },
  });

  console.log('Seed complete:');
  console.log(`  user: ${user.email} (${user.id})`);
  console.log(`  series: ${quantumKitchen.title}, ${signalAndNoise.title}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
