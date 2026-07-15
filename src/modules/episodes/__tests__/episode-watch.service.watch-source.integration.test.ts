// Integration coverage for two related fixes against a real Postgres
// database, same throwaway-fixture convention as
// episode-watch.service.integration.test.ts:
//
// 1. Batch-marked activity visibility (EpisodeWatch.watchSource): single
//    marks are SINGLE (visible in Recently Watched), the "mark all
//    released" bulk escape hatch (watch-all-logic.ts) creates BATCH
//    (hidden from Recently Watched, but a completely normal watch record
//    everywhere else — progress, completion, next-episode derivation).
// 2. markWatched's response now carries everything a Watch Next card needs
//    to reconcile itself with no follow-up request: remainingEpisodesAfterNext,
//    and userStatus precisely distinguishing CAUGHT_UP (still airing) from
//    COMPLETED (provider has ended the show) on the final episode.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, ReleaseStatus, Series, User } from '@prisma/client';
import { EpisodeWatchService } from '../episode-watch.service';
import { MeService } from '../../me/me.service';
import { PrismaService } from '../../../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAST = new Date(Date.now() - 30 * DAY_MS);

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('EpisodeWatchService — watch-source visibility + mark-watched response (integration, real Postgres)', () => {
  const prisma = new PrismaService();
  const episodeWatchService = new EpisodeWatchService(prisma);
  const meService = new MeService(prisma);
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
    const user = await prisma.user.create({ data: { email: `watch-source-test-${randomUUID()}@example.com`, displayName: 'Watch Source Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeries(releaseStatus: ReleaseStatus): Promise<Series> {
    const series = await prisma.series.create({ data: { title: `Watch Source Test Series ${randomUUID()}`, releaseStatus } });
    createdSeriesIds.push(series.id);
    return series;
  }

  describe('batch-marked activity visibility', () => {
    it('a single mark-watched creates a SINGLE watch, visible in Recently Watched', async () => {
      const user = await createFixtureUser();
      const series = await createFixtureSeries(ReleaseStatus.RETURNING);
      const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
      const ep1 = await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 1, airDate: PAST } });

      await episodeWatchService.markWatched(user.id, ep1.id);

      const watch = await prisma.episodeWatch.findUniqueOrThrow({ where: { userId_episodeId: { userId: user.id, episodeId: ep1.id } } });
      expect(watch.watchSource).toBe('SINGLE');

      const recentlyWatched = await meService.getRecentlyWatched(user.id, 10);
      expect(recentlyWatched.items.map((i) => i.episode.id)).toContain(ep1.id);
    });

    it('marking a season in bulk persists all episodes as watched but creates no visible Recently Watched items for them', async () => {
      const user = await createFixtureUser();
      const series = await createFixtureSeries(ReleaseStatus.RETURNING);
      const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
      const episodes = await Promise.all(Array.from({ length: 3 }, (_, i) => prisma.episode.create({ data: { seasonId: season.id, episodeNumber: i + 1, airDate: PAST } })));

      await episodeWatchService.markSeasonWatched(user.id, season.id, { dryRun: false });

      for (const ep of episodes) {
        const watch = await prisma.episodeWatch.findUniqueOrThrow({ where: { userId_episodeId: { userId: user.id, episodeId: ep.id } } });
        expect(watch.watchSource).toBe('BATCH');
      }

      const recentlyWatched = await meService.getRecentlyWatched(user.id, 10);
      const recentEpisodeIds = recentlyWatched.items.map((i) => i.episode.id);
      for (const ep of episodes) expect(recentEpisodeIds).not.toContain(ep.id);
    });

    it('marking a full series in bulk behaves the same as a season', async () => {
      const user = await createFixtureUser();
      const series = await createFixtureSeries(ReleaseStatus.ENDED);
      const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
      const episodes = await Promise.all(Array.from({ length: 2 }, (_, i) => prisma.episode.create({ data: { seasonId: season.id, episodeNumber: i + 1, airDate: PAST } })));

      await episodeWatchService.markSeriesReleasedWatched(user.id, series.id, { dryRun: false });

      for (const ep of episodes) {
        const watch = await prisma.episodeWatch.findUniqueOrThrow({ where: { userId_episodeId: { userId: user.id, episodeId: ep.id } } });
        expect(watch.watchSource).toBe('BATCH');
      }
      const recentlyWatched = await meService.getRecentlyWatched(user.id, 10);
      expect(recentlyWatched.items).toHaveLength(0);
    });

    it('reloading/refetching Recently Watched does not resurrect hidden batch activity — the exclusion is a stored field, not a request-scoped filter', async () => {
      const user = await createFixtureUser();
      const series = await createFixtureSeries(ReleaseStatus.RETURNING);
      const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
      const ep1 = await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 1, airDate: PAST } });
      await episodeWatchService.markSeasonWatched(user.id, season.id, { dryRun: false });

      const first = await meService.getRecentlyWatched(user.id, 10);
      const second = await meService.getRecentlyWatched(user.id, 10);
      expect(first.items.map((i) => i.episode.id)).not.toContain(ep1.id);
      expect(second.items.map((i) => i.episode.id)).not.toContain(ep1.id);
    });

    it('progress/completion calculations still include batch-watched episodes — userStatus correctly becomes COMPLETED', async () => {
      const user = await createFixtureUser();
      const series = await createFixtureSeries(ReleaseStatus.ENDED);
      const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
      await Promise.all(Array.from({ length: 3 }, (_, i) => prisma.episode.create({ data: { seasonId: season.id, episodeNumber: i + 1, airDate: PAST } })));

      const result = await episodeWatchService.markSeriesReleasedWatched(user.id, series.id, { dryRun: false });
      expect(result.newUserStatus).toBe('COMPLETED');

      const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
      expect(progress.userStatus).toBe('COMPLETED');
    });

    it('existing non-batch (SINGLE) history remains visible after an unrelated batch operation on the same series', async () => {
      const user = await createFixtureUser();
      const series = await createFixtureSeries(ReleaseStatus.RETURNING);
      const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
      const season2 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 2 } });
      const singleEp = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 1, airDate: PAST } });
      const batchEp = await prisma.episode.create({ data: { seasonId: season2.id, episodeNumber: 1, airDate: PAST } });

      await episodeWatchService.markWatched(user.id, singleEp.id);
      await episodeWatchService.markSeasonWatched(user.id, season2.id, { dryRun: false });

      const recentlyWatched = await meService.getRecentlyWatched(user.id, 10);
      const ids = recentlyWatched.items.map((i) => i.episode.id);
      expect(ids).toContain(singleEp.id);
      expect(ids).not.toContain(batchEp.id);
    });

    it('individually re-marking a batch-watched episode restores its Recently Watched visibility (documented undo/rewatch decision)', async () => {
      const user = await createFixtureUser();
      const series = await createFixtureSeries(ReleaseStatus.RETURNING);
      const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
      const ep1 = await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 1, airDate: PAST } });

      await episodeWatchService.markSeasonWatched(user.id, season.id, { dryRun: false });
      let watch = await prisma.episodeWatch.findUniqueOrThrow({ where: { userId_episodeId: { userId: user.id, episodeId: ep1.id } } });
      expect(watch.watchSource).toBe('BATCH');

      // A deliberate, individual re-mark via the single-episode endpoint —
      // this is real user intent (e.g. re-confirming via the series page),
      // and per this task's documented decision, promotes the row back to
      // SINGLE/visible.
      await episodeWatchService.markWatched(user.id, ep1.id);
      watch = await prisma.episodeWatch.findUniqueOrThrow({ where: { userId_episodeId: { userId: user.id, episodeId: ep1.id } } });
      expect(watch.watchSource).toBe('SINGLE');

      const recentlyWatched = await meService.getRecentlyWatched(user.id, 10);
      expect(recentlyWatched.items.map((i) => i.episode.id)).toContain(ep1.id);
    });

    it('a batch operation never overwrites an episode that was already individually (SINGLE) watched', async () => {
      const user = await createFixtureUser();
      const series = await createFixtureSeries(ReleaseStatus.RETURNING);
      const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
      const ep1 = await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 1, airDate: PAST } });
      const ep2 = await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 2, airDate: PAST } });

      await episodeWatchService.markWatched(user.id, ep1.id); // SINGLE
      await episodeWatchService.markSeasonWatched(user.id, season.id, { dryRun: false }); // batch-covers both, but ep1 already exists

      const watch1 = await prisma.episodeWatch.findUniqueOrThrow({ where: { userId_episodeId: { userId: user.id, episodeId: ep1.id } } });
      const watch2 = await prisma.episodeWatch.findUniqueOrThrow({ where: { userId_episodeId: { userId: user.id, episodeId: ep2.id } } });
      expect(watch1.watchSource).toBe('SINGLE');
      expect(watch2.watchSource).toBe('BATCH');
    });
  });

  describe('markWatched response — final-episode reconciliation data', () => {
    it('advancing to a real next episode: response.nextEpisode is set and remainingEpisodesAfterNext is correct', async () => {
      const user = await createFixtureUser();
      const series = await createFixtureSeries(ReleaseStatus.RETURNING);
      const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
      const episodes = await Promise.all(Array.from({ length: 3 }, (_, i) => prisma.episode.create({ data: { seasonId: season.id, episodeNumber: i + 1, airDate: PAST } })));

      const result = await episodeWatchService.markWatched(user.id, episodes[0].id);

      expect(result.nextEpisode?.id).toBe(episodes[1].id);
      expect(result.userStatus).toBe('WATCHING');
      // One more released episode (episodes[2]) after the new next episode.
      expect(result.remainingEpisodesAfterNext).toBe(1);
    });

    it('marking the last released episode of a STILL-RETURNING show: userStatus is CAUGHT_UP, never COMPLETED — "you\'re all caught up", not "series completed"', async () => {
      const user = await createFixtureUser();
      const series = await createFixtureSeries(ReleaseStatus.RETURNING);
      const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
      const ep1 = await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 1, airDate: PAST } });

      const result = await episodeWatchService.markWatched(user.id, ep1.id);

      expect(result.nextEpisode).toBeNull();
      expect(result.userStatus).toBe('CAUGHT_UP');
      expect(result.remainingEpisodesAfterNext).toBeNull();
    });

    it('marking the last episode of an ENDED show: userStatus is COMPLETED — "series completed"', async () => {
      const user = await createFixtureUser();
      const series = await createFixtureSeries(ReleaseStatus.ENDED);
      const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
      const ep1 = await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 1, airDate: PAST } });

      const result = await episodeWatchService.markWatched(user.id, ep1.id);

      expect(result.nextEpisode).toBeNull();
      expect(result.userStatus).toBe('COMPLETED');
    });

    it('a CANCELLED show is treated the same as ENDED — COMPLETED, not CAUGHT_UP', async () => {
      const user = await createFixtureUser();
      const series = await createFixtureSeries(ReleaseStatus.CANCELLED);
      const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
      const ep1 = await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 1, airDate: PAST } });

      const result = await episodeWatchService.markWatched(user.id, ep1.id);
      expect(result.userStatus).toBe('COMPLETED');
    });

    it('a future-dated episode in the catalog does not prevent CAUGHT_UP — future episodes must not keep the card in WATCHING', async () => {
      const user = await createFixtureUser();
      const series = await createFixtureSeries(ReleaseStatus.RETURNING);
      const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
      const ep1 = await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 1, airDate: PAST } });
      await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 2, airDate: new Date(Date.now() + 30 * DAY_MS) } });

      const result = await episodeWatchService.markWatched(user.id, ep1.id);

      expect(result.nextEpisode).toBeNull();
      expect(result.userStatus).toBe('CAUGHT_UP');
    });

    it('a Season 0 special does not block completion — marking the last regular episode still resolves to COMPLETED/CAUGHT_UP, not blocked by the unwatched special', async () => {
      const user = await createFixtureUser();
      const series = await createFixtureSeries(ReleaseStatus.ENDED);
      const regularSeason = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
      const specialsSeason = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 0 } });
      const ep1 = await prisma.episode.create({ data: { seasonId: regularSeason.id, episodeNumber: 1, airDate: PAST } });
      await prisma.episode.create({ data: { seasonId: specialsSeason.id, episodeNumber: 1, airDate: PAST } }); // never watched

      const result = await episodeWatchService.markWatched(user.id, ep1.id);

      expect(result.nextEpisode).toBeNull();
      expect(result.userStatus).toBe('COMPLETED');
    });
  });
});
