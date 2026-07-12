// Regression coverage for the completed-series review batch fix: the apply
// transaction previously fetched the provider's live release status but
// never wrote it to Series.releaseStatus at all (a real, pre-existing gap —
// see docs/migration-workbench-guide.md). That meant a migration-derived
// COMPLETED userStatus (via statusOverride) could never survive a later
// progress-reconciliation pass, since deriveUserStatusFromNextEpisode reads
// Series.releaseStatus directly and has no notion of a migration override —
// reconciliation would silently "fix" COMPLETED back down to CAUGHT_UP.
// Proven live against the real dev DB during the actual batch (7 series,
// all now survive reconciliation); this test proves the same mechanism at
// the unit-test level with a mocked TmdbClient, so it's covered by `npm
// test` rather than only by that one-time live proof.
//
// No test file existed for run-provider-confirmation-for-decision.ts before
// this one — it's an I/O-heavy orchestration file (real Prisma transaction
// + a live provider fetch), tested via integration/live proof throughout
// this codebase rather than exhaustive unit coverage of every branch (its
// constituent pure functions — compareSeriesCatalog, classifyMigrationConfirmation,
// buildMigrationApplyPlan — already have their own dedicated unit tests).
// This file covers only the one new behavior this task added: the
// releaseStatus write and its idempotency.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, ReleaseStatus, User, UserSeriesStatus } from '@prisma/client';
import { TmdbClient } from '../../tmdb-enrichment/tmdb-client';
import { TvMazeClient } from '../../secondary-provider-audit/tvmaze-client';
import { loadSeriesHealthInputs } from '../load-series-health-inputs';
import { runProviderConfirmationForDecision } from '../run-provider-confirmation-for-decision';
import { ProviderConfirmationDecision } from '../provider-confirmation-decisions-logic';

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('runProviderConfirmationForDecision — Series.releaseStatus sync (integration, real Postgres + mocked TMDb)', () => {
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
    const user = await prisma.user.create({ data: { email: `release-status-sync-test-${randomUUID()}@example.com`, displayName: 'Release Status Sync Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  // A fully-watched, single-season local series with UNKNOWN releaseStatus
  // (the DevUserMiddleware-created default for every imported series in
  // this app) — matches the exact real-world shape of every series in the
  // actual completed-series batch this fix was built for.
  async function createFixtureSeries(userId: string, title: string) {
    const series = await prisma.series.create({ data: { title, releaseStatus: ReleaseStatus.UNKNOWN } });
    createdSeriesIds.push(series.id);
    const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const episodes = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        prisma.episode.create({ data: { seasonId: season.id, episodeNumber: i + 1, title: `Episode ${i + 1}`, airDate: new Date('2020-01-01') } }),
      ),
    );
    for (const ep of episodes) await prisma.episodeWatch.create({ data: { userId, episodeId: ep.id, watchedAt: new Date('2020-02-01') } });
    await prisma.userSeriesProgress.create({ data: { userId, seriesId: series.id, userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null } });
    return series;
  }

  function buildMockTmdb(title: string): TmdbClient {
    return {
      getShowDetails: jest.fn().mockResolvedValue({ id: 555, name: title, number_of_seasons: 1, status: 'Ended', first_air_date: '2018-01-01', genres: [], original_language: 'en', origin_country: ['US'] }),
      getSeasonsBatch: jest.fn().mockResolvedValue({
        'season/1': { id: 1, season_number: 1, episodes: [1, 2, 3].map((n) => ({ id: n, season_number: 1, episode_number: n, name: `Episode ${n}`, air_date: '2020-01-01' })) },
      }),
    } as unknown as TmdbClient;
  }

  it('writes Series.releaseStatus from the fetched provider status on a real apply, and records it in MigrationHistory', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries(user.id, 'Release Status Sync Fixture Show');
    const decision: ProviderConfirmationDecision = { title: series.title, decision: 'confirm', provider: 'tmdb', providerId: '555' };

    const before = await prisma.series.findUniqueOrThrow({ where: { id: series.id } });
    expect(before.releaseStatus).toBe(ReleaseStatus.UNKNOWN);

    const healthInputs = await loadSeriesHealthInputs(prisma, user.id);
    const outcome = await runProviderConfirmationForDecision({
      prisma,
      tmdb: buildMockTmdb(series.title),
      tvmaze: new TvMazeClient(),
      decision,
      healthInputs,
      userId: user.id,
      generatedAt: new Date(),
      apply: true,
      applyAutoSafeMigrations: true,
      maxSeasonZeroOrphans: 1,
    });

    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') throw new Error('expected applied');

    const after = await prisma.series.findUniqueOrThrow({ where: { id: series.id } });
    expect(after.releaseStatus).toBe(ReleaseStatus.ENDED);

    const history = await prisma.migrationHistory.findUniqueOrThrow({ where: { id: outcome.migrationHistoryId! } });
    expect(history.releaseStatusBefore).toBe(ReleaseStatus.UNKNOWN);
    expect(history.releaseStatusAfter).toBe(ReleaseStatus.ENDED);
  });

  it('is idempotent: re-running apply after releaseStatus already matches the provider creates no new MigrationHistory row', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries(user.id, 'Release Status Idempotency Fixture Show');
    const decision: ProviderConfirmationDecision = { title: series.title, decision: 'confirm', provider: 'tmdb', providerId: '555' };

    const healthInputsFirst = await loadSeriesHealthInputs(prisma, user.id);
    const firstOutcome = await runProviderConfirmationForDecision({
      prisma,
      tmdb: buildMockTmdb(series.title),
      tvmaze: new TvMazeClient(),
      decision,
      healthInputs: healthInputsFirst,
      userId: user.id,
      generatedAt: new Date(),
      apply: true,
      applyAutoSafeMigrations: true,
      maxSeasonZeroOrphans: 1,
    });
    expect(firstOutcome.kind).toBe('applied');

    const historyCountAfterFirst = await prisma.migrationHistory.count({ where: { seriesId: series.id } });
    expect(historyCountAfterFirst).toBe(1);

    // Re-run with fresh health inputs reflecting the now-synced releaseStatus.
    const healthInputsSecond = await loadSeriesHealthInputs(prisma, user.id);
    const secondOutcome = await runProviderConfirmationForDecision({
      prisma,
      tmdb: buildMockTmdb(series.title),
      tvmaze: new TvMazeClient(),
      decision,
      healthInputs: healthInputsSecond,
      userId: user.id,
      generatedAt: new Date(),
      apply: true,
      applyAutoSafeMigrations: true,
      maxSeasonZeroOrphans: 1,
    });

    expect(secondOutcome.kind).toBe('already-applied');
    const historyCountAfterSecond = await prisma.migrationHistory.count({ where: { seriesId: series.id } });
    expect(historyCountAfterSecond).toBe(1); // unchanged — no duplicate history row
  });

  it('does not write Series.releaseStatus at all when the provider status already matches (no-op field, no unnecessary write)', async () => {
    const user = await createFixtureUser();
    const series = await prisma.series.create({ data: { title: 'Already Synced Fixture Show', releaseStatus: ReleaseStatus.ENDED } });
    createdSeriesIds.push(series.id);
    const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const ep = await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 1, title: 'Episode 1', airDate: new Date('2020-01-01') } });
    await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: ep.id, watchedAt: new Date('2020-02-01') } });
    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.COMPLETED, nextEpisodeId: null } });
    await prisma.externalIds.create({ data: { seriesId: series.id, provider: 'tmdb', providerId: '555', tmdbId: '555' } });

    const mockTmdb: TmdbClient = {
      getShowDetails: jest.fn().mockResolvedValue({ id: 555, name: 'Already Synced Fixture Show', number_of_seasons: 1, status: 'Ended', first_air_date: '2018-01-01', genres: [], original_language: 'en', origin_country: ['US'] }),
      getSeasonsBatch: jest.fn().mockResolvedValue({ 'season/1': { id: 1, season_number: 1, episodes: [{ id: 1, season_number: 1, episode_number: 1, name: 'Episode 1', air_date: '2020-01-01' }] } }),
    } as unknown as TmdbClient;

    const decision: ProviderConfirmationDecision = { title: series.title, decision: 'confirm', provider: 'tmdb', providerId: '555' };
    const healthInputs = await loadSeriesHealthInputs(prisma, user.id);
    const outcome = await runProviderConfirmationForDecision({
      prisma,
      tmdb: mockTmdb,
      tvmaze: new TvMazeClient(),
      decision,
      healthInputs,
      userId: user.id,
      generatedAt: new Date(),
      apply: true,
      applyAutoSafeMigrations: true,
      maxSeasonZeroOrphans: 1,
    });

    expect(outcome.kind).toBe('already-applied');
    const historyCount = await prisma.migrationHistory.count({ where: { seriesId: series.id } });
    expect(historyCount).toBe(0);
  });

  // A batch of many decisions (the CLI pipeline's for-loop, and this task's
  // own 7-series apply batch) relies on this function NEVER throwing — it
  // must always resolve to a structured outcome, even when the live
  // provider fetch itself fails, so one series's failure can never abort
  // the rest of the batch. This is a pre-existing guarantee (the whole
  // function body is wrapped in try/catch), not something this task
  // introduced — this test just proves it holds for a real provider-fetch
  // failure specifically.
  it('never throws on a provider fetch failure — resolves to kind: "error" so the rest of a batch can continue', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries(user.id, 'Provider Fetch Failure Fixture Show');
    const decision: ProviderConfirmationDecision = { title: series.title, decision: 'confirm', provider: 'tmdb', providerId: '555' };

    const failingTmdb = {
      getShowDetails: jest.fn().mockRejectedValue(new Error('simulated TMDb outage')),
      getSeasonsBatch: jest.fn(),
    } as unknown as TmdbClient;

    const healthInputs = await loadSeriesHealthInputs(prisma, user.id);
    const outcome = await runProviderConfirmationForDecision({
      prisma,
      tmdb: failingTmdb,
      tvmaze: new TvMazeClient(),
      decision,
      healthInputs,
      userId: user.id,
      generatedAt: new Date(),
      apply: true,
      applyAutoSafeMigrations: true,
      maxSeasonZeroOrphans: 1,
    });

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('expected error');
    expect(outcome.entry.message).toContain('simulated TMDb outage');

    // Nothing written for this series — a failure never leaves a partial write.
    const historyCount = await prisma.migrationHistory.count({ where: { seriesId: series.id } });
    expect(historyCount).toBe(0);
  });
});
