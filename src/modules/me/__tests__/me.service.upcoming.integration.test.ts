// Integration test for MeService.getUpcoming — eligibility filtering,
// date-window boundaries, no duplicates across adjacent windows, and
// watched-state joins, against a real Postgres database. Same
// throwaway-fixture/cascade-delete convention as this project's other
// integration tests (see watchlist.service.integration.test.ts).

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { UserSeriesStatus } from '@prisma/client';
import { MeService } from '../me.service';
import { PrismaService } from '../../../prisma/prisma.service';

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('MeService.getUpcoming (integration, real Postgres)', () => {
  const prisma = new PrismaService();
  const service = new MeService(prisma);
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

  async function createFixtureUser() {
    const user = await prisma.user.create({
      data: { email: `upcoming-test-${randomUUID()}@example.com`, displayName: 'Upcoming Test User' },
    });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeriesWithEpisode(
    title: string,
    userId: string,
    userStatus: UserSeriesStatus,
    airDate: string,
    options: { seasonNumber?: number; episodeNumber?: number; watched?: boolean } = {},
  ) {
    const series = await prisma.series.create({ data: { title } });
    createdSeriesIds.push(series.id);
    await prisma.userSeriesProgress.create({ data: { userId, seriesId: series.id, userStatus } });
    const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: options.seasonNumber ?? 1 } });
    const episode = await prisma.episode.create({
      data: { seasonId: season.id, episodeNumber: options.episodeNumber ?? 1, airDate: new Date(airDate) },
    });
    if (options.watched) {
      await prisma.episodeWatch.create({ data: { userId, episodeId: episode.id } });
    }
    return { series, season, episode };
  }

  it('includes WATCHING/CAUGHT_UP/WATCHLIST/PAUSED/COMPLETED and excludes DROPPED/UNKNOWN', async () => {
    const user = await createFixtureUser();
    await createFixtureSeriesWithEpisode('Watching Show', user.id, UserSeriesStatus.WATCHING, '2026-07-15');
    await createFixtureSeriesWithEpisode('Caught Up Show', user.id, UserSeriesStatus.CAUGHT_UP, '2026-07-15');
    await createFixtureSeriesWithEpisode('Watchlist Show', user.id, UserSeriesStatus.WATCHLIST, '2026-07-15');
    await createFixtureSeriesWithEpisode('Paused Show', user.id, UserSeriesStatus.PAUSED, '2026-07-15');
    await createFixtureSeriesWithEpisode('Completed Show', user.id, UserSeriesStatus.COMPLETED, '2026-07-15');
    await createFixtureSeriesWithEpisode('Dropped Show', user.id, UserSeriesStatus.DROPPED, '2026-07-15');
    await createFixtureSeriesWithEpisode('Unknown Show', user.id, UserSeriesStatus.UNKNOWN, '2026-07-15');

    const page = await service.getUpcoming(user.id, '2026-07-14', '2026-07-16');
    expect(page.days).toHaveLength(1);
    const titles = page.days[0].items.map((i) => i.seriesTitle).sort();
    expect(titles).toEqual(['Caught Up Show', 'Completed Show', 'Paused Show', 'Watching Show', 'Watchlist Show']);
  });

  it('excludes an episode with no airDate (never mixed into the dated timeline)', async () => {
    const user = await createFixtureUser();
    const series = await prisma.series.create({ data: { title: 'Dateless Show' } });
    createdSeriesIds.push(series.id);
    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.WATCHING } });
    const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 1, airDate: null } });

    const page = await service.getUpcoming(user.id, '2026-06-01', '2026-07-15');
    expect(page.days.flatMap((d) => d.items.map((i) => i.seriesId))).not.toContain(series.id);
  });

  it('respects the [from, to) window boundary — an episode exactly at "to" is excluded, one just before is included', async () => {
    const user = await createFixtureUser();
    await createFixtureSeriesWithEpisode('Boundary In', user.id, UserSeriesStatus.WATCHING, '2026-07-14');
    await createFixtureSeriesWithEpisode('Boundary Out', user.id, UserSeriesStatus.WATCHING, '2026-07-15');

    const page = await service.getUpcoming(user.id, '2026-07-01', '2026-07-15');
    const titles = page.days.flatMap((d) => d.items.map((i) => i.seriesTitle));
    expect(titles).toContain('Boundary In');
    expect(titles).not.toContain('Boundary Out');
  });

  it('never duplicates or drops an item across two adjacent, non-overlapping windows', async () => {
    const user = await createFixtureUser();
    await createFixtureSeriesWithEpisode('Early Window', user.id, UserSeriesStatus.WATCHING, '2026-07-10');
    await createFixtureSeriesWithEpisode('Late Window', user.id, UserSeriesStatus.WATCHING, '2026-07-20');

    const firstPage = await service.getUpcoming(user.id, '2026-07-01', '2026-07-15');
    const secondPage = await service.getUpcoming(user.id, '2026-07-15', '2026-07-31');

    const allTitles = [...firstPage.days, ...secondPage.days].flatMap((d) => d.items.map((i) => i.seriesTitle));
    expect(allTitles.sort()).toEqual(['Early Window', 'Late Window']);
  });

  it('reports hasMorePast/hasMoreFuture correctly based on eligible episodes outside the window', async () => {
    const user = await createFixtureUser();
    await createFixtureSeriesWithEpisode('Way Past', user.id, UserSeriesStatus.WATCHING, '2020-01-01');
    await createFixtureSeriesWithEpisode('In Window', user.id, UserSeriesStatus.WATCHING, '2026-07-15');
    await createFixtureSeriesWithEpisode('Way Future', user.id, UserSeriesStatus.WATCHING, '2030-01-01');

    const page = await service.getUpcoming(user.id, '2026-07-01', '2026-07-31');
    expect(page.hasMorePast).toBe(true);
    expect(page.hasMoreFuture).toBe(true);
  });

  it('hasMorePast/hasMoreFuture are false when nothing eligible exists outside the window', async () => {
    const user = await createFixtureUser();
    await createFixtureSeriesWithEpisode('Only Show', user.id, UserSeriesStatus.WATCHING, '2026-07-15');

    const page = await service.getUpcoming(user.id, '2026-07-01', '2026-07-31');
    expect(page.hasMorePast).toBe(false);
    expect(page.hasMoreFuture).toBe(false);
  });

  it('marks watched episodes correctly, including episodeWatchId for the unwatch endpoint', async () => {
    const user = await createFixtureUser();
    const { episode } = await createFixtureSeriesWithEpisode('Watched Show', user.id, UserSeriesStatus.WATCHING, '2026-07-15', { watched: true });

    const page = await service.getUpcoming(user.id, '2026-07-01', '2026-07-31');
    const item = page.days[0].items.find((i) => i.episodeId === episode.id);
    expect(item?.isWatched).toBe(true);
    expect(item?.episodeWatchId).not.toBeNull();
  });

  it('rejects an invalid window with a 400', async () => {
    const user = await createFixtureUser();
    await expect(service.getUpcoming(user.id, '2026-07-31', '2026-07-01')).rejects.toThrow();
  });
});
