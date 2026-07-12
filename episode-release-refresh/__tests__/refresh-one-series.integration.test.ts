// Integration test for the extracted, shared refreshOneSeries pipeline
// function (episode-release-refresh/refresh-one-series.ts) — proves both
// (a) behavior-preserving extraction from run-apply-refresh.ts's original
// inline loop, exercised via the same real Postgres pattern
// apply-refresh-transaction.integration.test.ts already uses, and (b) the
// scheduler-architecture task's Part 3 catalog/status separation at the
// full-pipeline level (not just inside applySeriesInsertPlan alone): a
// WATCHLIST series' catalog IS refreshed, but its userStatus/nextEpisodeId
// are left untouched. TMDb is mocked (same buildMockTmdb pattern
// library-health's own integration tests use) — no live network call.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, ReleaseStatus, Series, User, UserSeriesStatus } from '@prisma/client';
import { TmdbClient, TmdbRequestError } from '../../tmdb-enrichment/tmdb-client';
import { refreshOneSeries, SeriesRow } from '../refresh-one-series';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAST = new Date(Date.now() - 30 * DAY_MS);
const NEW_RELEASED = new Date(Date.now() - 1 * DAY_MS);

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('refreshOneSeries (integration, real Postgres + mocked TMDb)', () => {
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
    const user = await prisma.user.create({ data: { email: `refresh-one-series-test-${randomUUID()}@example.com`, displayName: 'Refresh One Series Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  // One existing, watched S1E1 — the mock TMDb candidate below always adds
  // exactly one brand-new, already-released S1E2 on top of it.
  async function createFixtureSeries(userId: string, userStatus: UserSeriesStatus): Promise<{ series: Series; row: SeriesRow }> {
    const tmdbId = `9${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const series = await prisma.series.create({ data: { title: `Refresh One Series Test ${randomUUID()}`, releaseStatus: ReleaseStatus.RETURNING } });
    createdSeriesIds.push(series.id);
    await prisma.externalIds.create({ data: { seriesId: series.id, tmdbId } });
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const ep1 = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 1, airDate: PAST } });
    await prisma.episodeWatch.create({ data: { userId, episodeId: ep1.id, watchedAt: PAST } });
    await prisma.userSeriesProgress.create({ data: { userId, seriesId: series.id, userStatus, nextEpisodeId: null } });

    const row: SeriesRow = {
      id: series.id,
      title: series.title,
      releaseStatus: series.releaseStatus,
      tmdbId,
      userStatus,
      nextEpisodeId: null,
      episodes: [
        { id: ep1.id, seasonNumber: 1, episodeNumber: 1, title: null, overview: null, airDate: PAST, imageUrl: null, runtimeMinutes: null, watched: true },
      ],
    };
    return { series, row };
  }

  function buildMockTmdb(): TmdbClient {
    return {
      getShowDetails: jest.fn().mockResolvedValue({ id: 1, name: 'Mock Show', number_of_seasons: 1, status: 'Returning Series', first_air_date: '2020-01-01', genres: [], original_language: 'en', origin_country: ['US'] }),
      getSeasonsBatch: jest.fn().mockResolvedValue({
        'season/1': {
          id: 1,
          season_number: 1,
          episodes: [
            { id: 1, season_number: 1, episode_number: 1, name: 'Episode 1', air_date: PAST.toISOString().slice(0, 10) },
            { id: 2, season_number: 1, episode_number: 2, name: 'Episode 2', air_date: NEW_RELEASED.toISOString().slice(0, 10) },
          ],
        },
      }),
    } as unknown as TmdbClient;
  }

  function buildFailingMockTmdb(): TmdbClient {
    return {
      getShowDetails: jest.fn().mockRejectedValue(new TmdbRequestError('not found', 404, '/tv/1')),
      getSeasonsBatch: jest.fn(),
    } as unknown as TmdbClient;
  }

  it('inserts the new episode and recomputes progress for a WATCHING series (tracked status)', async () => {
    const user = await createFixtureUser();
    const { row } = await createFixtureSeries(user.id, UserSeriesStatus.WATCHING);

    const outcome = await refreshOneSeries({ prisma, tmdb: buildMockTmdb(), userId: user.id, series: row, apply: true });

    expect(outcome.kind).toBe('processed');
    if (outcome.kind !== 'processed') throw new Error('unreachable');
    expect(outcome.writeAttempted).toBe(true);
    expect(outcome.entry.classification).toBe('NEW_RELEASE_AVAILABLE');
    expect(outcome.entry.episodesInserted).toBe(1);
    expect(outcome.entry.progressRecomputed).toBe(true);
    expect(outcome.entry.progressChange?.userStatusTo).toBe(UserSeriesStatus.WATCHING);

    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: row.id } } });
    expect(progress.nextEpisodeId).not.toBeNull();
  });

  // The direct proof of Part 3's catalog/status separation, at the full
  // shared-pipeline level (fetch -> compare -> plan -> write), not just
  // inside applySeriesInsertPlan in isolation.
  it('inserts the new episode for a WATCHLIST series but leaves userStatus/nextEpisodeId completely untouched', async () => {
    const user = await createFixtureUser();
    const { row } = await createFixtureSeries(user.id, UserSeriesStatus.WATCHLIST);

    const outcome = await refreshOneSeries({ prisma, tmdb: buildMockTmdb(), userId: user.id, series: row, apply: true });

    expect(outcome.kind).toBe('processed');
    if (outcome.kind !== 'processed') throw new Error('unreachable');
    expect(outcome.entry.episodesInserted).toBe(1);
    expect(outcome.entry.progressRecomputed).toBe(false);
    expect(outcome.entry.progressSkippedReason).toContain('WATCHLIST');

    const insertedEpisode = await prisma.episode.findFirst({ where: { season: { seriesId: row.id }, episodeNumber: 2 } });
    expect(insertedEpisode).not.toBeNull();

    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: row.id } } });
    expect(progress.userStatus).toBe(UserSeriesStatus.WATCHLIST);
    expect(progress.nextEpisodeId).toBeNull();
  });

  it('makes no writes at all in dry-run mode (apply: false), regardless of status', async () => {
    const user = await createFixtureUser();
    const { row } = await createFixtureSeries(user.id, UserSeriesStatus.WATCHLIST);

    const outcome = await refreshOneSeries({ prisma, tmdb: buildMockTmdb(), userId: user.id, series: row, apply: false });

    expect(outcome.kind).toBe('processed');
    if (outcome.kind !== 'processed') throw new Error('unreachable');
    expect(outcome.writeAttempted).toBe(false);
    expect(outcome.entry.episodesInserted).toBe(0);
    expect(outcome.entry.progressSkippedReason).toContain('dry run');

    const episodeCount = await prisma.episode.count({ where: { season: { seriesId: row.id } } });
    expect(episodeCount).toBe(1); // only the original fixture episode
  });

  it('returns a structured error outcome (never throws) when the provider fetch fails, leaving the series unaffected', async () => {
    const user = await createFixtureUser();
    const { row } = await createFixtureSeries(user.id, UserSeriesStatus.WATCHING);

    const outcome = await refreshOneSeries({ prisma, tmdb: buildFailingMockTmdb(), userId: user.id, series: row, apply: true });

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('unreachable');
    expect(outcome.entry.seriesId).toBe(row.id);
    expect(outcome.entry.message).toContain('not found');

    const episodeCount = await prisma.episode.count({ where: { season: { seriesId: row.id } } });
    expect(episodeCount).toBe(1); // untouched
  });
});
