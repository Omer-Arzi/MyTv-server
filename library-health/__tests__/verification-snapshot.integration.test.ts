// Integration test proving the Phase 7 verification layer works end to end
// against a real Postgres database: capture a "before" snapshot, run the
// same catalog-reconciliation transaction
// catalog-reconciliation-transaction.integration.test.ts exercises, capture
// an "after" snapshot, then confirm verifySeriesPostApply reports every
// check as PASS for a genuinely correct apply — and FAILs a specific check
// when the transaction is deliberately made to skip preserving an orphan,
// proving the layer would actually catch a real regression, not just a
// hand-constructed fixture one.
//
// Same isolated-fixture convention as the other integration tests in this
// directory: throwaway User + Series, cascade-deleted in afterEach, skips
// itself if DATABASE_URL isn't configured.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, ReleaseStatus, Series, User, UserSeriesStatus } from '@prisma/client';
import { createMissingSeasonsAndEpisodes } from '../../episode-release-refresh/season-episode-writer';
import { EpisodeInsertPlan } from '../../episode-release-refresh/build-episode-insert-plan';
import { resolveObjectiveMigrationStatus } from '../migration-policy-logic';
import { CATALOG_RECONCILIATION_IMPORT_BATCH_ID } from '../migration-catalog-plan-logic';
import { captureSeriesSnapshot } from '../verification-snapshot';
import { verifySeriesPostApply } from '../verification-logic';

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;
const PAST = new Date('2020-01-01');

describeIfDbConfigured('post-apply verification (integration, real Postgres)', () => {
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
    const user = await prisma.user.create({ data: { email: `verification-test-${randomUUID()}@example.com`, displayName: 'Verification Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeries(): Promise<Series> {
    const series = await prisma.series.create({ data: { title: `Verification Test Series ${randomUUID()}`, releaseStatus: ReleaseStatus.ENDED } });
    createdSeriesIds.push(series.id);
    return series;
  }

  async function setUpFixture() {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const matchedEpisodes = await Promise.all([1, 2, 3].map((n) => prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: n, airDate: PAST } })));
    for (const ep of matchedEpisodes) {
      await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: ep.id, watchedAt: PAST } });
    }
    const orphanEpisode = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 99, title: 'Local Only Special', airDate: PAST } });
    await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: orphanEpisode.id, watchedAt: PAST } });
    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: null } });

    const insertPlan: EpisodeInsertPlan = {
      episodesToInsert: [
        { seasonNumber: 2, episodeNumber: 1, title: 'New Season Ep 1', overview: null, airDate: PAST, imageUrl: null, runtimeMinutes: 24 },
        { seasonNumber: 2, episodeNumber: 2, title: 'New Season Ep 2', overview: null, airDate: PAST, imageUrl: null, runtimeMinutes: 24 },
      ],
      seasonNumbersToCreate: [2],
    };

    return { user, series, orphanEpisode, insertPlan };
  }

  it('reports every check as PASS for a genuinely correct catalog-reconciliation apply', async () => {
    const { user, series, orphanEpisode, insertPlan } = await setUpFixture();

    const before = await captureSeriesSnapshot(prisma, series.id, user.id);

    const objectiveStatus = resolveObjectiveMigrationStatus({
      matchedWatchedCount: 3,
      matchedTotalCount: 3,
      currentUserStatus: UserSeriesStatus.WATCHING,
      providerReleaseStatus: ReleaseStatus.ENDED,
    });

    await prisma.$transaction(async (tx) => {
      await createMissingSeasonsAndEpisodes(tx, { seriesId: series.id, insertPlan, importBatchId: CATALOG_RECONCILIATION_IMPORT_BATCH_ID });
      await tx.userSeriesProgress.update({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } }, data: { userStatus: objectiveStatus.resolvedUserStatus, nextEpisodeId: null } });
    });

    const after = await captureSeriesSnapshot(prisma, series.id, user.id);

    const result = verifySeriesPostApply(before, after, {
      seriesId: series.id,
      expectedImportBatchId: CATALOG_RECONCILIATION_IMPORT_BATCH_ID,
      expectedNewSeasonNumbers: [2],
      expectedNewEpisodeCount: 2,
      preservedOrphanEpisodeIds: [orphanEpisode.id],
      expectedUserStatus: UserSeriesStatus.COMPLETED,
      expectedNextEpisodeId: null,
    });

    expect(result.passed).toBe(true);
    expect(result.checks.filter((c) => c.status === 'FAIL')).toHaveLength(0);
  });

  it('reports a FAIL on preserved-orphans-untouched if a real apply were to mutate the orphan (simulated corruption after a correct apply)', async () => {
    const { user, series, orphanEpisode, insertPlan } = await setUpFixture();

    const before = await captureSeriesSnapshot(prisma, series.id, user.id);

    await prisma.$transaction(async (tx) => {
      await createMissingSeasonsAndEpisodes(tx, { seriesId: series.id, insertPlan, importBatchId: CATALOG_RECONCILIATION_IMPORT_BATCH_ID });
      // Deliberately corrupt the orphan the way a real regression might —
      // this is exactly what buildMigrationApplyPlan's own invariant is
      // supposed to make impossible from the application layer; this test
      // proves the independent verification layer would ALSO have caught
      // it if that invariant were ever bypassed or the write path changed.
      await tx.episode.update({ where: { id: orphanEpisode.id }, data: { episodeNumber: 100 } });
      await tx.userSeriesProgress.update({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } }, data: { userStatus: UserSeriesStatus.COMPLETED, nextEpisodeId: null } });
    });

    const after = await captureSeriesSnapshot(prisma, series.id, user.id);

    const result = verifySeriesPostApply(before, after, {
      seriesId: series.id,
      expectedImportBatchId: CATALOG_RECONCILIATION_IMPORT_BATCH_ID,
      expectedNewSeasonNumbers: [2],
      expectedNewEpisodeCount: 2,
      preservedOrphanEpisodeIds: [orphanEpisode.id],
      expectedUserStatus: UserSeriesStatus.COMPLETED,
      expectedNextEpisodeId: null,
    });

    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name === 'preserved-orphans-untouched')?.status).toBe('FAIL');
  });
});
