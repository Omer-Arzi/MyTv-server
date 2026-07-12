// Integration test for the "Season 0 (Specials) never participates in
// derived progress" product rule — against a real Postgres database, same
// throwaway-fixture/cascade-delete convention as this project's other
// integration tests. Covers the exact 3 examples from the spec, plus the
// "Specials remain fully supported elsewhere" guarantees: still in the
// catalog, still on the Series page, still watchable, watch history
// unaffected.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { ReleaseStatus, Series, User, UserSeriesStatus } from '@prisma/client';
import { EpisodeWatchService } from '../episode-watch.service';
import { SeriesService } from '../../series/series.service';
import { PrismaService } from '../../../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAST = new Date(Date.now() - 30 * DAY_MS);

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('Season 0 (Specials) derivation rule (integration, real Postgres)', () => {
  const prisma = new PrismaService();
  const episodeWatchService = new EpisodeWatchService(prisma);
  const seriesService = new SeriesService(prisma);
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
    const user = await prisma.user.create({ data: { email: `season-zero-test-${randomUUID()}@example.com`, displayName: 'Season Zero Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeries(releaseStatus: ReleaseStatus): Promise<Series> {
    const series = await prisma.series.create({ data: { title: `Season Zero Test Series ${randomUUID()}`, releaseStatus } });
    createdSeriesIds.push(series.id);
    return series;
  }

  // Season 0: 10 specials (unwatched). Season 1: 2/2 watched (standing in
  // for 12/12). Season 2: 2/2 watched (standing in for 10/10). Watching
  // the LAST canonical episode is what triggers derivation, via markWatched.
  async function buildSeriesWithSpecials(user: User, releaseStatus: ReleaseStatus) {
    const series = await createFixtureSeries(releaseStatus);
    const season0 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 0 } });
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const season2 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 2 } });

    const specials = await Promise.all(
      Array.from({ length: 3 }, (_, i) => prisma.episode.create({ data: { seasonId: season0.id, episodeNumber: i + 1, airDate: PAST, title: `Special ${i + 1}` } })),
    );
    const s1e1 = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 1, airDate: PAST } });
    const s1e2 = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 2, airDate: PAST } });
    const s2e1 = await prisma.episode.create({ data: { seasonId: season2.id, episodeNumber: 1, airDate: PAST } });
    const s2e2 = await prisma.episode.create({ data: { seasonId: season2.id, episodeNumber: 2, airDate: PAST } });

    // Watch every canonical episode except the very last one (s2e2) —
    // markWatched-ing that one is what we assert the derivation on.
    // Specials are left entirely unwatched.
    for (const ep of [s1e1, s1e2, s2e1]) {
      await prisma.episodeWatch.upsert({ where: { userId_episodeId: { userId: user.id, episodeId: ep.id } }, create: { userId: user.id, episodeId: ep.id, watchedAt: PAST }, update: {} });
    }
    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: s2e2.id, lastWatchedAt: PAST } });

    return { series, specials, s1e1, s1e2, s2e1, s2e2 };
  }

  it('Example 1 — ended show, all canonical episodes watched, unwatched Specials only -> COMPLETED (never WATCHING)', async () => {
    const user = await createFixtureUser();
    const { series, s2e2 } = await buildSeriesWithSpecials(user, ReleaseStatus.ENDED);

    const result = await episodeWatchService.markWatched(user.id, s2e2.id);

    expect(result.userStatus).toBe(UserSeriesStatus.COMPLETED);
    expect(result.seriesCompleted).toBe(true);
    expect(result.nextEpisode).toBeNull();

    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progress.userStatus).toBe(UserSeriesStatus.COMPLETED);
    expect(progress.nextEpisodeId).toBeNull();
  });

  it('Example 2 — returning show, all currently-released canonical episodes watched, unwatched Specials only -> CAUGHT_UP (never WATCHING)', async () => {
    const user = await createFixtureUser();
    const { series, s2e2 } = await buildSeriesWithSpecials(user, ReleaseStatus.RETURNING);

    const result = await episodeWatchService.markWatched(user.id, s2e2.id);

    expect(result.userStatus).toBe(UserSeriesStatus.CAUGHT_UP);
    expect(result.nextEpisode).toBeNull();

    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progress.userStatus).toBe(UserSeriesStatus.CAUGHT_UP);
    expect(progress.nextEpisodeId).toBeNull();
  });

  it('Example 3 — a released, unwatched canonical episode still becomes nextEpisode/WATCHING; Season 0 is ignored regardless of position', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries(ReleaseStatus.RETURNING);
    const season0 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 0 } });
    const season2 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 2 } });
    const special = await prisma.episode.create({ data: { seasonId: season0.id, episodeNumber: 1, airDate: PAST } });
    const s2e4 = await prisma.episode.create({ data: { seasonId: season2.id, episodeNumber: 4, airDate: PAST } });
    const s2e5 = await prisma.episode.create({ data: { seasonId: season2.id, episodeNumber: 5, airDate: PAST } });

    await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: s2e4.id, watchedAt: PAST } });
    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null } });

    const result = await episodeWatchService.markWatched(user.id, s2e4.id);

    expect(result.userStatus).toBe(UserSeriesStatus.WATCHING);
    expect(result.nextEpisode?.id).toBe(s2e5.id);

    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progress.nextEpisodeId).toBe(s2e5.id);
    expect(progress.nextEpisodeId).not.toBe(special.id);
  });

  it('Specials remain fully visible on the Series page and remain watchable, and watch history is unaffected by this rule', async () => {
    const user = await createFixtureUser();
    const { series, specials } = await buildSeriesWithSpecials(user, ReleaseStatus.RETURNING);

    // 1. Specials still exist and are visible via GET /series/:id.
    const detail = await seriesService.getDetail(user.id, series.id);
    const season0Detail = detail.seasons.find((s) => s.seasonNumber === 0);
    expect(season0Detail).toBeDefined();
    expect(season0Detail!.episodes).toHaveLength(3);
    expect(season0Detail!.episodes.map((e) => e.title).sort()).toEqual(['Special 1', 'Special 2', 'Special 3']);

    // 2. A Special can still be marked watched — no rejection, no special-case guard.
    const specialToWatch = specials[0];
    const watchResult = await episodeWatchService.markWatched(user.id, specialToWatch.id);
    expect(watchResult.watch.episode.id).toBe(specialToWatch.id);
    const watchRow = await prisma.episodeWatch.findUnique({ where: { userId_episodeId: { userId: user.id, episodeId: specialToWatch.id } } });
    expect(watchRow).not.toBeNull();

    // 3. Marking a Special watched does NOT itself change userStatus away from
    // WATCHING (there's still an unwatched canonical episode, s2e2, pending) —
    // proves Specials don't drive derivation in either direction.
    const progressAfter = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progressAfter.userStatus).toBe(UserSeriesStatus.WATCHING);
  });
});
