// Integration test for EpisodeWatchService.markWatched's release-date guard
// (docs/watch-next-released-episode-semantics-todo.md Phase 5) — against a
// real Postgres database, same throwaway-fixture/cascade-delete convention
// as episode-release-refresh's integration tests. No test file existed for
// this service before this task at all.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { ReleaseStatus, Series, User } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { EpisodeWatchService } from '../episode-watch.service';
import { PrismaService } from '../../../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAST = new Date(Date.now() - 2 * DAY_MS);
const FUTURE = new Date(Date.now() + 30 * DAY_MS);

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('EpisodeWatchService.markWatched — release-date guard (integration, real Postgres)', () => {
  const prisma = new PrismaService();
  const service = new EpisodeWatchService(prisma);
  const createdUserIds: string[] = [];
  const createdSeriesIds: string[] = [];

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    for (const seriesId of createdSeriesIds.splice(0)) {
      await prisma.series.deleteMany({ where: { id: seriesId } });
    }
    for (const userId of createdUserIds.splice(0)) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  async function createFixtureUser(): Promise<User> {
    const user = await prisma.user.create({
      data: { email: `mark-watched-guard-test-${randomUUID()}@example.com`, displayName: 'Mark Watched Guard Test User' },
    });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeries(releaseStatus: ReleaseStatus = ReleaseStatus.RETURNING): Promise<Series> {
    const series = await prisma.series.create({ data: { title: `Mark Watched Guard Test Series ${randomUUID()}`, releaseStatus } });
    createdSeriesIds.push(series.id);
    return series;
  }

  it('rejects marking a not-yet-released episode watched: no EpisodeWatch row created, no progress written', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();
    const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const futureEpisode = await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 1, airDate: FUTURE } });

    await expect(service.markWatched(user.id, futureEpisode.id)).rejects.toBeInstanceOf(BadRequestException);

    const watch = await prisma.episodeWatch.findUnique({ where: { userId_episodeId: { userId: user.id, episodeId: futureEpisode.id } } });
    expect(watch).toBeNull();

    const progress = await prisma.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progress).toBeNull();
  });

  it('does not alter an existing progress row when a future-episode mark-watched attempt is rejected', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();
    const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const releasedEpisode = await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 1, airDate: PAST } });
    const futureEpisode = await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 2, airDate: FUTURE } });
    await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: releasedEpisode.id, watchedAt: PAST } });
    const progressBefore = await prisma.userSeriesProgress.create({
      data: { userId: user.id, seriesId: series.id, userStatus: 'WATCHING', nextEpisodeId: null, lastWatchedAt: PAST },
    });

    await expect(service.markWatched(user.id, futureEpisode.id)).rejects.toBeInstanceOf(BadRequestException);

    const progressAfter = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { id: progressBefore.id } });
    expect(progressAfter.updatedAt.getTime()).toBe(progressBefore.updatedAt.getTime());
    expect(progressAfter.nextEpisodeId).toBeNull();

    const futureWatch = await prisma.episodeWatch.findUnique({ where: { userId_episodeId: { userId: user.id, episodeId: futureEpisode.id } } });
    expect(futureWatch).toBeNull();
  });

  it('still allows marking a released episode watched (positive control — the guard is not overly broad)', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();
    const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const releasedEpisode = await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 1, airDate: PAST } });

    const result = await service.markWatched(user.id, releasedEpisode.id);

    expect(result.watch.episode.id).toBe(releasedEpisode.id);
    const watch = await prisma.episodeWatch.findUnique({ where: { userId_episodeId: { userId: user.id, episodeId: releasedEpisode.id } } });
    expect(watch).not.toBeNull();
  });
});
