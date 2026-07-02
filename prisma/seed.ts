import { PrismaClient, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { DEV_USER_DISPLAY_NAME, DEV_USER_EMAIL, DEV_USER_ID } from '../src/common/constants';

const prisma = new PrismaClient();

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

async function main() {
  console.log('Seeding database...');

  // Wipe existing data (order matters for FKs). Safe for a dev/seed DB only.
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

  // --- Series 1: The Great Voyage — ongoing show, actively being watched ---
  const greatVoyage = await prisma.series.create({
    data: {
      title: 'The Great Voyage',
      overview: 'A crew explores the outer rim of known space.',
      posterUrl: 'https://images.example.com/great-voyage/poster.jpg',
      releaseStatus: ReleaseStatus.RETURNING,
      seasons: {
        create: [
          {
            seasonNumber: 1,
            title: 'Season 1',
            episodes: {
              create: Array.from({ length: 8 }, (_, i) => ({
                episodeNumber: i + 1,
                title: [
                  'Departure',
                  'First Contact',
                  'The Anomaly',
                  'Breach',
                  'Into the Dark',
                  'Signal Lost',
                  'The Long Silence',
                  'Homecoming',
                ][i],
                overview: `Episode ${i + 1} of The Great Voyage, season 1.`,
                airDate: new Date(2024, 2, 3 + i * 7),
                runtimeMinutes: 42,
              })),
            },
          },
        ],
      },
    },
    include: { seasons: { include: { episodes: { orderBy: { episodeNumber: 'asc' } } } } },
  });
  const gvEpisodes = greatVoyage.seasons[0].episodes;

  // User has watched episodes 1-5, most recently a few hours ago.
  const gvWatchedCount = 5;
  for (let i = 0; i < gvWatchedCount; i++) {
    const watchedAt = daysAgo(gvWatchedCount - i - 1 + 0.1);
    const watch = await prisma.episodeWatch.create({
      data: { userId: user.id, episodeId: gvEpisodes[i].id, watchedAt },
    });
    if (i === gvWatchedCount - 1) {
      await prisma.episodeNote.create({
        data: { episodeWatchId: watch.id, text: 'Great cliffhanger! Did not see that coming.' },
      });
    }
  }
  await prisma.userSeriesProgress.create({
    data: {
      userId: user.id,
      seriesId: greatVoyage.id,
      userStatus: UserSeriesStatus.WATCHING,
      lastWatchedAt: daysAgo(0.1),
      nextEpisodeId: gvEpisodes[gvWatchedCount].id, // episode 6
    },
  });

  // --- Series 2: Old Town Mysteries — ended show, stale progress ---
  const oldTown = await prisma.series.create({
    data: {
      title: 'Old Town Mysteries',
      overview: 'A detective duo solves cases in a sleepy coastal town.',
      posterUrl: 'https://images.example.com/old-town/poster.jpg',
      releaseStatus: ReleaseStatus.ENDED,
      seasons: {
        create: [
          {
            seasonNumber: 1,
            title: 'Season 1',
            episodes: {
              create: Array.from({ length: 6 }, (_, i) => ({
                episodeNumber: i + 1,
                title: `The Case of the ${['Missing Locket', 'Silent Pier', 'Forged Letter', 'Empty House', 'Second Witness', 'Final Tide'][i]}`,
                overview: `Episode ${i + 1} of Old Town Mysteries, season 1.`,
                airDate: new Date(2023, 5, 1 + i * 7),
                runtimeMinutes: 38,
              })),
            },
          },
          {
            seasonNumber: 2,
            title: 'Season 2',
            episodes: {
              create: Array.from({ length: 6 }, (_, i) => ({
                episodeNumber: i + 1,
                title: `The ${['Lighthouse', 'Storm', 'Letter Home', 'Old Debt', 'Reunion', 'Last Case'][i]}`,
                overview: `Episode ${i + 1} of Old Town Mysteries, season 2.`,
                airDate: new Date(2023, 8, 1 + i * 7),
                runtimeMinutes: 40,
              })),
            },
          },
        ],
      },
    },
    include: { seasons: { include: { episodes: { orderBy: { episodeNumber: 'asc' } } }, orderBy: { seasonNumber: 'asc' } } },
  });
  const otSeason1 = oldTown.seasons.find((s) => s.seasonNumber === 1)!;
  const otSeason2 = oldTown.seasons.find((s) => s.seasonNumber === 2)!;

  // User finished season 1 two months ago and never continued -> stale.
  let lastOtWatchedAt = daysAgo(60);
  for (let i = 0; i < otSeason1.episodes.length; i++) {
    lastOtWatchedAt = daysAgo(60 - i);
    await prisma.episodeWatch.create({
      data: { userId: user.id, episodeId: otSeason1.episodes[i].id, watchedAt: lastOtWatchedAt },
    });
  }
  await prisma.userSeriesProgress.create({
    data: {
      userId: user.id,
      seriesId: oldTown.id,
      userStatus: UserSeriesStatus.WATCHING,
      lastWatchedAt: lastOtWatchedAt,
      nextEpisodeId: otSeason2.episodes[0].id, // season 2, episode 1
    },
  });

  // --- Series 3: Quantum Kitchen — unwatched, sitting on the watchlist ---
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

  // --- Series 4: Signal & Noise — finished show, fully watched -> COMPLETED ---
  // Demonstrates the distinction this status model exists for: unlike Great
  // Voyage/Old Town Mysteries (WATCHING, more known episodes to go), this
  // series has releaseStatus=ENDED and nothing left to watch, so it resolves
  // to COMPLETED rather than CAUGHT_UP — and should never appear in Watch
  // Next or Haven't Watched For A While.
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
  console.log(`  series: ${greatVoyage.title}, ${oldTown.title}, ${quantumKitchen.title}, ${signalAndNoise.title}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
