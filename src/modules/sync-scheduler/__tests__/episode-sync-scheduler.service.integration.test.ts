// Integration test for the automatic sync scheduler (Part 1/4/5/7 of the
// scheduler-architecture task) against a real Postgres database, with TMDb
// mocked at the global fetch level (TmdbClient defaults to global fetch
// when no fetchFn is injected — see tmdb-enrichment/tmdb-client.ts) since
// the service constructs its own TmdbClient internally from
// TMDB_ACCESS_TOKEN, the same way every other run-*.ts CLI entry point
// does. Every fixture uses its own disposable user (never DEV_USER_ID) so
// this test can never touch real tracked-series data — runTick's userId
// parameter exists specifically to make that possible.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, ReleaseStatus, User, UserSeriesStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { EpisodeSyncSchedulerService } from '../episode-sync-scheduler.service';
import { SeriesRefreshOrchestratorService } from '../../sync/series-refresh-orchestrator.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAST = new Date(Date.now() - 30 * DAY_MS);

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('EpisodeSyncSchedulerService (integration, real Postgres + mocked TMDb fetch)', () => {
  const prisma = new PrismaService();
  // The scheduler now delegates every per-series attempt to the shared
  // orchestrator (locking, local-release-activation, SeriesSyncStatus
  // bookkeeping) — see episode-sync-scheduler.service.ts's file header.
  const service = new EpisodeSyncSchedulerService(prisma, new SeriesRefreshOrchestratorService(prisma));
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

  afterEach(async () => {
    fetchSpy?.mockRestore();
    for (const seriesId of createdSeriesIds.splice(0)) {
      await prisma.series.deleteMany({ where: { id: seriesId } });
    }
    for (const userId of createdUserIds.splice(0)) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  async function createFixtureUser(): Promise<User> {
    const user = await prisma.user.create({ data: { email: `sync-scheduler-test-${randomUUID()}@example.com`, displayName: 'Sync Scheduler Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  // One existing, watched S1E1 — the mocked TMDb response below always adds
  // exactly one brand-new, already-released S1E2 on top of it.
  async function createFixtureSeries(userId: string, userStatus: UserSeriesStatus, title = `Sync Scheduler Test ${randomUUID()}`) {
    const tmdbId = `9${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const series = await prisma.series.create({ data: { title, releaseStatus: ReleaseStatus.RETURNING } });
    createdSeriesIds.push(series.id);
    await prisma.externalIds.create({ data: { seriesId: series.id, tmdbId } });
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const ep1 = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 1, airDate: PAST } });
    await prisma.episodeWatch.create({ data: { userId, episodeId: ep1.id, watchedAt: PAST } });
    await prisma.userSeriesProgress.create({ data: { userId, seriesId: series.id, userStatus, nextEpisodeId: null } });
    return series;
  }

  function mockGlobalFetchWithOneNewEpisode() {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      // getShowDetails always requests append_to_response=external_ids;
      // getSeasonsBatch requests append_to_response=season%2FN (URL-encoded
      // slash) — 'external_ids' is the unambiguous, unencoded discriminator.
      if (url.includes('external_ids')) {
        return new Response(JSON.stringify({ id: 1, name: 'Mock Show', number_of_seasons: 1, status: 'Returning Series', first_air_date: '2020-01-01', genres: [], original_language: 'en', origin_country: ['US'] }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          'season/1': {
            id: 1,
            season_number: 1,
            episodes: [
              { id: 1, season_number: 1, episode_number: 1, name: 'Episode 1', air_date: PAST.toISOString().slice(0, 10) },
              { id: 2, season_number: 1, episode_number: 2, name: 'Episode 2', air_date: new Date(Date.now() - DAY_MS).toISOString().slice(0, 10) },
            ],
          },
        }),
        { status: 200 },
      );
    });
  }

  // 404, not 500 — TmdbRequestError still results (refreshOneSeries's
  // failure path is exercised identically either way), but 404 throws
  // immediately with no retry, unlike a 5xx (TmdbClient's real exponential
  // backoff would otherwise make this test wait ~30s for real).
  function mockGlobalFetchAlwaysFails() {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));
  }

  it('refreshes a due WATCHING series, inserts the episode, recomputes progress, and writes a SUCCESS SeriesSyncStatus row', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries(user.id, UserSeriesStatus.WATCHING);
    mockGlobalFetchWithOneNewEpisode();

    const result = await service.runTick(user.id);

    expect(result.checked).toBe(1);
    expect(result.refreshed).toBe(1);
    expect(result.errored).toBe(0);

    const insertedEpisode = await prisma.episode.findFirst({ where: { season: { seriesId: series.id }, episodeNumber: 2 } });
    expect(insertedEpisode).not.toBeNull();

    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progress.nextEpisodeId).not.toBeNull();

    const syncStatus = await prisma.seriesSyncStatus.findUniqueOrThrow({ where: { seriesId: series.id } });
    expect(syncStatus.lastEpisodeRefreshStatus).toBe('SUCCESS');
    expect(syncStatus.numberOfFailures).toBe(0);
    expect(syncStatus.lastSuccessfulRefreshAt).not.toBeNull();
    expect(syncStatus.nextEligibleRefreshAt).not.toBeNull();
    expect(syncStatus.nextEligibleRefreshAt!.getTime()).toBeGreaterThan(Date.now());
  });

  // Part 3 proof at the scheduler level: a WATCHLIST series is still
  // refreshed on its own cadence — catalog gets the new episode — but
  // userStatus/nextEpisodeId are never touched by the scheduler.
  it('refreshes a due WATCHLIST series catalog but leaves userStatus/nextEpisodeId untouched', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries(user.id, UserSeriesStatus.WATCHLIST);
    mockGlobalFetchWithOneNewEpisode();

    const result = await service.runTick(user.id);

    expect(result.refreshed).toBe(1);
    const insertedEpisode = await prisma.episode.findFirst({ where: { season: { seriesId: series.id }, episodeNumber: 2 } });
    expect(insertedEpisode).not.toBeNull();

    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progress.userStatus).toBe(UserSeriesStatus.WATCHLIST);
    expect(progress.nextEpisodeId).toBeNull();
  });

  // Part 7: a genuine provider failure is isolated to the failing series,
  // recorded as FAILURE with an incremented failure count and a short
  // backoff, and never corrupts the existing catalog.
  it('isolates a provider failure to the one series, recording FAILURE + incremented numberOfFailures, without throwing', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries(user.id, UserSeriesStatus.WATCHING);
    mockGlobalFetchAlwaysFails();

    const result = await service.runTick(user.id);

    expect(result.errored).toBe(1);
    expect(result.refreshed).toBe(0);

    const syncStatus = await prisma.seriesSyncStatus.findUniqueOrThrow({ where: { seriesId: series.id } });
    expect(syncStatus.lastEpisodeRefreshStatus).toBe('FAILURE');
    expect(syncStatus.numberOfFailures).toBe(1);
    expect(syncStatus.lastEpisodeRefreshError).not.toBeNull();
    expect(syncStatus.lastSuccessfulRefreshAt).toBeNull();

    // Catalog untouched — a failed fetch never corrupts what's already there.
    const episodeCount = await prisma.episode.count({ where: { season: { seriesId: series.id } } });
    expect(episodeCount).toBe(1);
  });

  // One failing series must never block another due series in the same tick.
  it('processes a second series normally even when the first one in the tick fails', async () => {
    const user = await createFixtureUser();
    const failingSeries = await createFixtureSeries(user.id, UserSeriesStatus.WATCHING, `Failing Series ${randomUUID()}`);
    const healthySeries = await createFixtureSeries(user.id, UserSeriesStatus.WATCHING, `Healthy Series ${randomUUID()}`);

    let callCount = 0;
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const isFailingSeries = url.includes((await prisma.externalIds.findUniqueOrThrow({ where: { seriesId: failingSeries.id } })).tmdbId!);
      if (isFailingSeries) return new Response('not found', { status: 404 }); // no retry, unlike 5xx
      callCount++;
      // getShowDetails always requests append_to_response=external_ids;
      // getSeasonsBatch requests append_to_response=season%2FN (URL-encoded
      // slash) — 'external_ids' is the unambiguous, unencoded discriminator.
      if (url.includes('external_ids')) {
        return new Response(JSON.stringify({ id: 1, name: 'Mock Show', number_of_seasons: 1, status: 'Returning Series', first_air_date: '2020-01-01', genres: [], original_language: 'en', origin_country: ['US'] }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          'season/1': {
            id: 1,
            season_number: 1,
            episodes: [
              { id: 1, season_number: 1, episode_number: 1, name: 'Episode 1', air_date: PAST.toISOString().slice(0, 10) },
              { id: 2, season_number: 1, episode_number: 2, name: 'Episode 2', air_date: new Date(Date.now() - DAY_MS).toISOString().slice(0, 10) },
            ],
          },
        }),
        { status: 200 },
      );
    });

    const result = await service.runTick(user.id);

    expect(result.checked).toBe(2);
    expect(result.errored).toBe(1);
    expect(result.refreshed).toBe(1);

    const healthyProgress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: healthySeries.id } } });
    expect(healthyProgress.nextEpisodeId).not.toBeNull();
    expect(callCount).toBeGreaterThan(0);
  });

  it('skips a series that is not yet due (nextEligibleRefreshAt in the future)', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries(user.id, UserSeriesStatus.WATCHING);
    await prisma.seriesSyncStatus.create({
      data: { seriesId: series.id, nextEligibleRefreshAt: new Date(Date.now() + DAY_MS), lastEpisodeRefreshAt: new Date(), lastEpisodeRefreshStatus: 'SUCCESS' },
    });
    mockGlobalFetchWithOneNewEpisode();

    const result = await service.runTick(user.id);

    expect(result.checked).toBe(0);
    const episodeCount = await prisma.episode.count({ where: { season: { seriesId: series.id } } });
    expect(episodeCount).toBe(1); // untouched
  });

  it('never checks (or writes SeriesSyncStatus for) an UNKNOWN-status series', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries(user.id, UserSeriesStatus.UNKNOWN);
    mockGlobalFetchWithOneNewEpisode();

    const result = await service.runTick(user.id);

    expect(result.checked).toBe(0);
    const syncStatus = await prisma.seriesSyncStatus.findUnique({ where: { seriesId: series.id } });
    expect(syncStatus).toBeNull();
  });
});
