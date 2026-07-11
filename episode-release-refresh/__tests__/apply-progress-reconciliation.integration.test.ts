// Integration test for the new progress-only write path
// (apply-progress-reconciliation.ts) against a real Postgres database — same
// conventions as apply-refresh-transaction.integration.test.ts: throwaway
// User + Series per test, cascade-deleted afterward, skips itself entirely
// if DATABASE_URL isn't configured.
//
// This is the direct integration proof of
// docs/progress-reconciliation-architecture-todo.md's core fix: a series
// with ZERO catalog inserts pending (the episode is already local) but a
// genuinely stale UserSeriesProgress row gets its progress corrected by
// this path alone — reproducing X-Men '97's exact shape (a local
// future-dated episode that ages into released) as the primary case.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, ReleaseStatus, Series, User, UserSeriesStatus } from '@prisma/client';
import { applyProgressReconciliation } from '../apply-progress-reconciliation';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAST = new Date(Date.now() - 30 * DAY_MS);
const YESTERDAY = new Date(Date.now() - 1 * DAY_MS); // released relative to "now"
const TOMORROW = new Date(Date.now() + 1 * DAY_MS); // NOT released relative to "now"

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('applyProgressReconciliation (integration, real Postgres)', () => {
  const prisma = new PrismaClient();
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
      data: { email: `progress-reconciliation-apply-test-${randomUUID()}@example.com`, displayName: 'Progress Reconciliation Apply Test User' },
    });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeries(releaseStatus: ReleaseStatus = ReleaseStatus.RETURNING): Promise<Series> {
    const series = await prisma.series.create({ data: { title: `Progress Reconciliation Test Series ${randomUUID()}`, releaseStatus } });
    createdSeriesIds.push(series.id);
    return series;
  }

  it('the X-Men \'97 case: a local future episode has since become released — corrects CAUGHT_UP -> WATCHING and sets nextEpisodeId, with zero Season/Episode writes', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries(ReleaseStatus.RETURNING);
    const season2 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 2 } });
    const s2e3 = await prisma.episode.create({ data: { seasonId: season2.id, episodeNumber: 3, airDate: PAST } });
    // Already local at fixture-creation time, with a future airDate — same
    // shape as X-Men '97's S2E4 (inserted upfront by an enrichment apply,
    // future-dated at the time).
    const s2e4 = await prisma.episode.create({ data: { seasonId: season2.id, episodeNumber: 4, airDate: YESTERDAY } });
    await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: s2e3.id, watchedAt: PAST } });
    const progressBefore = await prisma.userSeriesProgress.create({
      data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null },
    });

    const result = await applyProgressReconciliation(prisma, { userId: user.id, seriesId: series.id });

    expect(result.progressRecomputed).toBe(true);
    expect(result.progressChange).toEqual({
      userStatusFrom: UserSeriesStatus.CAUGHT_UP,
      userStatusTo: UserSeriesStatus.WATCHING,
      nextEpisodeIdFrom: null,
      nextEpisodeIdTo: s2e4.id,
    });

    const progressAfter = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { id: progressBefore.id } });
    expect(progressAfter.userStatus).toBe(UserSeriesStatus.WATCHING);
    expect(progressAfter.nextEpisodeId).toBe(s2e4.id);

    // S2E4 itself remains unwatched — this path only ever writes
    // UserSeriesProgress, never EpisodeWatch.
    const s2e4Watch = await prisma.episodeWatch.findUnique({ where: { userId_episodeId: { userId: user.id, episodeId: s2e4.id } } });
    expect(s2e4Watch).toBeNull();
  });

  it('zero catalog inserts and no progress change: does not write, does not bump updatedAt', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries(ReleaseStatus.RETURNING);
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const ep1 = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 1, airDate: PAST } });
    const ep2 = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 2, airDate: TOMORROW } }); // not yet released
    await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: ep1.id, watchedAt: PAST } });
    const progressBefore = await prisma.userSeriesProgress.create({
      data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null },
    });
    void ep2;

    const result = await applyProgressReconciliation(prisma, { userId: user.id, seriesId: series.id });

    expect(result.progressRecomputed).toBe(false);
    expect(result.progressChange).toBeNull();
    expect(result.progressSkippedReason).toMatch(/already matches stored/);

    const progressAfter = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { id: progressBefore.id } });
    expect(progressAfter.updatedAt.getTime()).toBe(progressBefore.updatedAt.getTime());
  });

  it.each([UserSeriesStatus.PAUSED, UserSeriesStatus.DROPPED])(
    '%s series: remains %s, progress is never overridden even with a released unwatched episode sitting right there',
    async (status) => {
      const user = await createFixtureUser();
      const series = await createFixtureSeries(ReleaseStatus.RETURNING);
      const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
      const ep1 = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 1, airDate: PAST } });
      await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 2, airDate: YESTERDAY } }); // released, unwatched
      await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: ep1.id, watchedAt: PAST } });
      const progressBefore = await prisma.userSeriesProgress.create({
        data: { userId: user.id, seriesId: series.id, userStatus: status, nextEpisodeId: null },
      });

      const result = await applyProgressReconciliation(prisma, { userId: user.id, seriesId: series.id });

      expect(result.progressRecomputed).toBe(false);
      expect(result.progressSkippedReason).toMatch(/explicit user intent/);

      const progressAfter = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { id: progressBefore.id } });
      expect(progressAfter.userStatus).toBe(status);
      expect(progressAfter.nextEpisodeId).toBeNull();
      expect(progressAfter.updatedAt.getTime()).toBe(progressBefore.updatedAt.getTime());
    },
  );

  it('idempotency: applying a second time after a real correction makes zero further changes', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries(ReleaseStatus.RETURNING);
    const season2 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 2 } });
    const s2e3 = await prisma.episode.create({ data: { seasonId: season2.id, episodeNumber: 3, airDate: PAST } });
    const s2e4 = await prisma.episode.create({ data: { seasonId: season2.id, episodeNumber: 4, airDate: YESTERDAY } });
    await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: s2e3.id, watchedAt: PAST } });
    await prisma.userSeriesProgress.create({
      data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null },
    });
    void s2e4;

    const first = await applyProgressReconciliation(prisma, { userId: user.id, seriesId: series.id });
    expect(first.progressRecomputed).toBe(true);

    const afterFirst = await prisma.userSeriesProgress.findFirstOrThrow({ where: { userId: user.id, seriesId: series.id } });

    const second = await applyProgressReconciliation(prisma, { userId: user.id, seriesId: series.id });
    expect(second.progressRecomputed).toBe(false);
    expect(second.progressSkippedReason).toMatch(/already matches stored/);

    const afterSecond = await prisma.userSeriesProgress.findFirstOrThrow({ where: { userId: user.id, seriesId: series.id } });
    expect(afterSecond.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());
    expect(afterSecond.userStatus).toBe(afterFirst.userStatus);
    expect(afterSecond.nextEpisodeId).toBe(afterFirst.nextEpisodeId);
  });

  it('returns a writeSkippedReason and touches nothing when no UserSeriesProgress row exists at all', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();

    const result = await applyProgressReconciliation(prisma, { userId: user.id, seriesId: series.id });

    expect(result.progressRecomputed).toBe(false);
    expect(result.writeSkippedReason).toMatch(/no UserSeriesProgress row found/);
  });
});
