// Integration test for LibraryRefreshJobService's status-scoped manual
// refresh (mobile/docs/tab-restructure-todo.md's System tab). Real Postgres,
// TMDb mocked at the global fetch level (see episode-sync-scheduler's
// integration test for the same convention) — this test only cares about
// which series get selected into the job (loadPrioritizedCandidateIds'
// status filter), not the per-series refresh outcome itself, so TMDb is
// mocked to fail fast (404, no retry) rather than simulate real responses.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, ReleaseStatus, User, UserSeriesStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LibraryRefreshJobService } from '../library-refresh-job.service';
import { SeriesRefreshOrchestratorService } from '../series-refresh-orchestrator.service';

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('LibraryRefreshJobService.startLibraryRefresh — status filter (integration, real Postgres + mocked TMDb fetch)', () => {
  const prisma = new PrismaService();
  const service = new LibraryRefreshJobService(prisma, new SeriesRefreshOrchestratorService(prisma));
  const createdUserIds: string[] = [];
  const createdSeriesIds: string[] = [];
  let fetchSpy: jest.SpyInstance;

  beforeAll(async () => {
    await prisma.$connect();
    if (!process.env.TMDB_ACCESS_TOKEN) process.env.TMDB_ACCESS_TOKEN = 'test-token-for-mocked-fetch';
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    for (const seriesId of createdSeriesIds.splice(0)) {
      await prisma.series.deleteMany({ where: { id: seriesId } });
    }
    for (const userId of createdUserIds.splice(0)) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  async function createFixtureUser(): Promise<User> {
    const user = await prisma.user.create({ data: { email: `library-refresh-status-filter-test-${randomUUID()}@example.com`, displayName: 'Library Refresh Status Filter Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeries(userId: string, userStatus: UserSeriesStatus): Promise<void> {
    const tmdbId = `9${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const series = await prisma.series.create({ data: { title: `Library Refresh Status Filter Test ${randomUUID()}`, releaseStatus: ReleaseStatus.RETURNING } });
    createdSeriesIds.push(series.id);
    await prisma.externalIds.create({ data: { seriesId: series.id, tmdbId } });
    await prisma.userSeriesProgress.create({ data: { userId, seriesId: series.id, userStatus, nextEpisodeId: null } });
  }

  // startLibraryRefresh's processJob is fire-and-forget — it keeps writing
  // to the LibraryRefreshJob row in the background after this call returns.
  // Every test must wait for it to reach a terminal status before returning
  // control to afterEach, otherwise fixture cleanup (which cascade-deletes
  // this job row via its User relation) races the background write and
  // surfaces as an unhandled "Record to update not found" rejection.
  async function waitForJobToFinish(userId: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const job = await service.getLatestJobStatus(userId);
      if (job && job.status !== 'RUNNING') return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for library refresh job to finish');
  }

  // The job row's totalSeries is set synchronously, before startLibraryRefresh
  // fires the fire-and-forget processJob — so it's a direct, immediate readout
  // of loadPrioritizedCandidateIds' filtered length, with no need to wait for
  // (or care about) the background per-series refresh outcome.
  it('includes every tracked (non-UNKNOWN) status when statuses is omitted', async () => {
    const user = await createFixtureUser();
    await createFixtureSeries(user.id, UserSeriesStatus.WATCHING);
    await createFixtureSeries(user.id, UserSeriesStatus.COMPLETED);
    await createFixtureSeries(user.id, UserSeriesStatus.CAUGHT_UP);

    const job = await service.startLibraryRefresh(user.id);
    await waitForJobToFinish(user.id);

    expect(job.totalSeries).toBe(3);
  });

  it('treats an empty statuses array the same as omitted', async () => {
    const user = await createFixtureUser();
    await createFixtureSeries(user.id, UserSeriesStatus.WATCHING);
    await createFixtureSeries(user.id, UserSeriesStatus.COMPLETED);

    const job = await service.startLibraryRefresh(user.id, undefined, []);
    await waitForJobToFinish(user.id);

    expect(job.totalSeries).toBe(2);
  });

  it('narrows to only the requested statuses when statuses is provided', async () => {
    const user = await createFixtureUser();
    await createFixtureSeries(user.id, UserSeriesStatus.WATCHING);
    await createFixtureSeries(user.id, UserSeriesStatus.COMPLETED);
    await createFixtureSeries(user.id, UserSeriesStatus.CAUGHT_UP);

    const job = await service.startLibraryRefresh(user.id, undefined, [UserSeriesStatus.COMPLETED]);
    await waitForJobToFinish(user.id);

    expect(job.totalSeries).toBe(1);
  });

  it('combines multiple requested statuses with an OR, not an AND', async () => {
    const user = await createFixtureUser();
    await createFixtureSeries(user.id, UserSeriesStatus.WATCHING);
    await createFixtureSeries(user.id, UserSeriesStatus.COMPLETED);
    await createFixtureSeries(user.id, UserSeriesStatus.CAUGHT_UP);
    await createFixtureSeries(user.id, UserSeriesStatus.DROPPED);

    const job = await service.startLibraryRefresh(user.id, undefined, [UserSeriesStatus.COMPLETED, UserSeriesStatus.CAUGHT_UP]);
    await waitForJobToFinish(user.id);

    expect(job.totalSeries).toBe(2);
  });

  it('never includes UNKNOWN even if explicitly requested', async () => {
    const user = await createFixtureUser();
    const series = await prisma.series.create({ data: { title: `Library Refresh Status Filter Test ${randomUUID()}`, releaseStatus: ReleaseStatus.RETURNING } });
    createdSeriesIds.push(series.id);
    await prisma.externalIds.create({ data: { seriesId: series.id, tmdbId: `9${randomUUID().replace(/-/g, '').slice(0, 6)}` } });
    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.UNKNOWN, nextEpisodeId: null } });

    const job = await service.startLibraryRefresh(user.id, undefined, [UserSeriesStatus.UNKNOWN]);
    await waitForJobToFinish(user.id);

    expect(job.totalSeries).toBe(0);
  });
});
