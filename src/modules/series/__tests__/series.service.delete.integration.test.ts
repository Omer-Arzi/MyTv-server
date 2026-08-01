// Integration test for SeriesService.deleteSeries — the hard-delete escape
// hatch this app had no equivalent of before (only "remove from watchlist"
// existed, which never touches the underlying catalog). Real Postgres, same
// throwaway-fixture/cascade-delete convention as
// episode-watch.service.integration.test.ts.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ReleaseStatus, Series, User } from '@prisma/client';
import { SeriesService } from '../series.service';
import { PrismaService } from '../../../prisma/prisma.service';

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('SeriesService.deleteSeries (integration, real Postgres)', () => {
  const prisma = new PrismaService();
  const service = new SeriesService(prisma);
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
      data: { email: `delete-series-test-${randomUUID()}@example.com`, displayName: 'Delete Series Test User' },
    });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeries(): Promise<Series> {
    const series = await prisma.series.create({ data: { title: `Delete Series Test ${randomUUID()}`, releaseStatus: ReleaseStatus.RETURNING } });
    createdSeriesIds.push(series.id);
    return series;
  }

  it('returns a preview without deleting anything when confirm is false', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();
    const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const ep1 = await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 1 } });
    await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 2 } });
    await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: ep1.id, watchedAt: new Date() } });
    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: 'WATCHING' } });

    const result = await service.deleteSeries(user.id, series.id, false);

    expect(result).toEqual({ seriesId: series.id, title: series.title, seasonCount: 1, episodeCount: 2, watchedEpisodeCount: 1, deleted: false });

    const stillExists = await prisma.series.findUnique({ where: { id: series.id } });
    expect(stillExists).not.toBeNull();
  });

  it('deletes the series and cascades to seasons/episodes/watches/progress when confirm is true', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();
    const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const ep1 = await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 1 } });
    await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: ep1.id, watchedAt: new Date() } });
    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: 'WATCHING' } });

    const result = await service.deleteSeries(user.id, series.id, true);

    expect(result.deleted).toBe(true);
    expect(result.seasonCount).toBe(1);
    expect(result.episodeCount).toBe(1);
    expect(result.watchedEpisodeCount).toBe(1);

    expect(await prisma.series.findUnique({ where: { id: series.id } })).toBeNull();
    expect(await prisma.season.findUnique({ where: { id: season.id } })).toBeNull();
    expect(await prisma.episode.findUnique({ where: { id: ep1.id } })).toBeNull();
    expect(await prisma.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } })).toBeNull();

    createdSeriesIds.splice(createdSeriesIds.indexOf(series.id), 1); // already gone — afterEach's deleteMany would be a no-op anyway, but keep the list honest
  });

  it('refuses to delete a series another user still tracks via UserSeriesProgress, even with confirm: true', async () => {
    const owner = await createFixtureUser();
    const otherUser = await createFixtureUser();
    const series = await createFixtureSeries();
    await prisma.userSeriesProgress.create({ data: { userId: owner.id, seriesId: series.id, userStatus: 'WATCHING' } });
    await prisma.userSeriesProgress.create({ data: { userId: otherUser.id, seriesId: series.id, userStatus: 'WATCHLIST' } });

    await expect(service.deleteSeries(owner.id, series.id, true)).rejects.toBeInstanceOf(ConflictException);

    expect(await prisma.series.findUnique({ where: { id: series.id } })).not.toBeNull();
  });

  it('refuses to delete a series another user still has on their watchlist, even with confirm: true', async () => {
    const owner = await createFixtureUser();
    const otherUser = await createFixtureUser();
    const series = await createFixtureSeries();
    await prisma.watchlistItem.create({ data: { userId: otherUser.id, seriesId: series.id } });

    await expect(service.deleteSeries(owner.id, series.id, true)).rejects.toBeInstanceOf(ConflictException);

    expect(await prisma.series.findUnique({ where: { id: series.id } })).not.toBeNull();
  });

  it('allows deleting a series with zero relationships from any user', async () => {
    const caller = await createFixtureUser();
    const series = await createFixtureSeries();

    const result = await service.deleteSeries(caller.id, series.id, true);

    expect(result.deleted).toBe(true);
    expect(await prisma.series.findUnique({ where: { id: series.id } })).toBeNull();
  });

  it('throws NotFoundException for a series id that does not exist', async () => {
    const caller = await createFixtureUser();
    await expect(service.deleteSeries(caller.id, randomUUID(), true)).rejects.toBeInstanceOf(NotFoundException);
  });
});
