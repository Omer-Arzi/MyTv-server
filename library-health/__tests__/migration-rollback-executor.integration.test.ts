// Integration test proving the MigrationHistory-based rollback executor's
// refusal rules and restore/delete behavior against a live database — same
// throwaway-fixture convention as rollback-executor.integration.test.ts.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient, ReleaseStatus, Series, User, UserSeriesStatus } from '@prisma/client';
import { createMissingSeasonsAndEpisodes } from '../../episode-release-refresh/season-episode-writer';
import { EpisodeInsertPlan } from '../../episode-release-refresh/build-episode-insert-plan';
import { CATALOG_RECONCILIATION_IMPORT_BATCH_ID } from '../migration-catalog-plan-logic';
import { executeMigrationRollback, MigrationRollbackRefusedError } from '../migration-rollback-executor';

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;
const PAST = new Date('2020-01-01');

describeIfDbConfigured('migration rollback executor (integration, real Postgres)', () => {
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
    const user = await prisma.user.create({ data: { email: `migration-rollback-test-${randomUUID()}@example.com`, displayName: 'Migration Rollback Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeries(): Promise<Series> {
    const series = await prisma.series.create({ data: { title: `Migration Rollback Test Series ${randomUUID()}`, releaseStatus: ReleaseStatus.ENDED } });
    createdSeriesIds.push(series.id);
    return series;
  }

  // Sets up: a pre-existing watched orphan (must survive any rollback), a
  // real ExternalIds row (so "provider restore" has something to reverse),
  // 2 newly-inserted episodes, and a matching MigrationHistory row — the
  // exact shape run-provider-confirmation-for-decision.ts's apply
  // transaction produces.
  async function setUpAppliedFixture() {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const orphanEpisode = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 99, title: 'Local Only Special', airDate: PAST } });
    await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: orphanEpisode.id, watchedAt: PAST } });
    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: null } });
    await prisma.externalIds.create({ data: { seriesId: series.id, provider: 'tmdb', providerId: '999', tmdbId: '999' } });

    const insertPlan: EpisodeInsertPlan = {
      episodesToInsert: [
        { seasonNumber: 2, episodeNumber: 1, title: 'New Season Ep 1', overview: null, airDate: PAST, imageUrl: null, runtimeMinutes: 24 },
        { seasonNumber: 2, episodeNumber: 2, title: 'New Season Ep 2', overview: null, airDate: PAST, imageUrl: null, runtimeMinutes: 24 },
      ],
      seasonNumbersToCreate: [2],
    };

    const insertedEpisodeIds = await prisma.$transaction(async (tx) => {
      const result = await createMissingSeasonsAndEpisodes(tx, { seriesId: series.id, insertPlan, importBatchId: CATALOG_RECONCILIATION_IMPORT_BATCH_ID });
      await tx.userSeriesProgress.update({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } }, data: { userStatus: UserSeriesStatus.COMPLETED, nextEpisodeId: null } });
      return result.episodeIdsInserted;
    });

    const history = await prisma.migrationHistory.create({
      data: {
        userId: user.id,
        seriesId: series.id,
        seriesTitle: series.title,
        classification: 'AUTO_MIGRATE',
        sourceCategory: 'READY_AUTOMATIC',
        providerBefore: { provider: 'old-provider', providerId: '111', tmdbId: null },
        providerAfter: { provider: 'tmdb', providerId: '999', tmdbId: '999' },
        userStatusBefore: UserSeriesStatus.WATCHING,
        userStatusAfter: UserSeriesStatus.COMPLETED,
        nextEpisodeIdBefore: null,
        nextEpisodeIdAfter: null,
        episodesInsertedIds: insertedEpisodeIds,
        episodesUpdatedIds: [],
        preservedOrphanEpisodeIds: [orphanEpisode.id],
        watchedMappingCount: 0,
        verificationPassed: true,
        verificationDetail: [],
      },
    });

    return { user, series, orphanEpisode, insertedEpisodeIds, history };
  }

  it('rolls back cleanly when eligible: deletes only the inserted episodes, restores progress and provider, leaves pre-existing rows untouched', async () => {
    const { user, series, orphanEpisode, insertedEpisodeIds, history } = await setUpAppliedFixture();
    expect(insertedEpisodeIds).toHaveLength(2);

    const result = await prisma.$transaction((tx) => executeMigrationRollback(tx, user.id, history));
    expect(result.episodesDeleted).toBe(2);
    expect(result.progressRestored).toBe(true);
    expect(result.providerRestored).toBe(true);

    const remaining = await prisma.episode.findMany({ where: { id: { in: insertedEpisodeIds } } });
    expect(remaining).toHaveLength(0);

    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progress.userStatus).toBe(UserSeriesStatus.WATCHING);
    expect(progress.nextEpisodeId).toBeNull();

    const externalIds = await prisma.externalIds.findUniqueOrThrow({ where: { seriesId: series.id } });
    expect(externalIds.provider).toBe('old-provider');
    expect(externalIds.providerId).toBe('111');
    expect(externalIds.tmdbId).toBeNull();

    const historyAfter = await prisma.migrationHistory.findUniqueOrThrow({ where: { id: history.id } });
    expect(historyAfter.rolledBackAt).not.toBeNull();

    // Pre-existing orphan (never part of this migration) must survive untouched, watch history intact.
    const orphanAfter = await prisma.episode.findUniqueOrThrow({ where: { id: orphanEpisode.id } });
    expect(orphanAfter.title).toBe('Local Only Special');
    const orphanWatch = await prisma.episodeWatch.findUnique({ where: { userId_episodeId: { userId: user.id, episodeId: orphanEpisode.id } } });
    expect(orphanWatch).not.toBeNull();
  });

  it('deletes the ExternalIds row entirely when providerBefore was null (no prior confirmed match)', async () => {
    const { user, series, history } = await setUpAppliedFixture();
    await prisma.migrationHistory.update({ where: { id: history.id }, data: { providerBefore: Prisma.JsonNull } });
    const historyWithNullBefore = await prisma.migrationHistory.findUniqueOrThrow({ where: { id: history.id } });

    await prisma.$transaction((tx) => executeMigrationRollback(tx, user.id, historyWithNullBefore));

    const externalIds = await prisma.externalIds.findUnique({ where: { seriesId: series.id } });
    expect(externalIds).toBeNull();
  });

  it('refuses and writes nothing when an inserted episode has since been watched', async () => {
    const { user, series, insertedEpisodeIds, history } = await setUpAppliedFixture();
    await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: insertedEpisodeIds[0], watchedAt: new Date() } });

    await expect(prisma.$transaction((tx) => executeMigrationRollback(tx, user.id, history))).rejects.toThrow(MigrationRollbackRefusedError);

    // Nothing written: episode still exists, progress unchanged, history not marked rolled back.
    const stillThere = await prisma.episode.findUnique({ where: { id: insertedEpisodeIds[0] } });
    expect(stillThere).not.toBeNull();
    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progress.userStatus).toBe(UserSeriesStatus.COMPLETED);
    const historyAfter = await prisma.migrationHistory.findUniqueOrThrow({ where: { id: history.id } });
    expect(historyAfter.rolledBackAt).toBeNull();
  });

  it('refuses and writes nothing when progress has drifted since the migration', async () => {
    const { user, series, history } = await setUpAppliedFixture();
    // Simulate later activity: user manually moved on to DROPPED.
    await prisma.userSeriesProgress.update({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } }, data: { userStatus: UserSeriesStatus.DROPPED } });

    await expect(prisma.$transaction((tx) => executeMigrationRollback(tx, user.id, history))).rejects.toThrow(MigrationRollbackRefusedError);

    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progress.userStatus).toBe(UserSeriesStatus.DROPPED);
  });

  it('is idempotent: a second rollback attempt on an already-rolled-back migration is refused, not repeated', async () => {
    const { user, history } = await setUpAppliedFixture();

    await prisma.$transaction((tx) => executeMigrationRollback(tx, user.id, history));
    const historyAfterFirst = await prisma.migrationHistory.findUniqueOrThrow({ where: { id: history.id } });

    await expect(prisma.$transaction((tx) => executeMigrationRollback(tx, user.id, historyAfterFirst))).rejects.toThrow(MigrationRollbackRefusedError);
  });

  // Regression coverage for the completed-series review batch fix: the
  // apply transaction now writes Series.releaseStatus from the live
  // provider fetch (previously never written at all, which is why a
  // migration-derived COMPLETED status couldn't survive progress
  // reconciliation — see run-provider-confirmation-for-decision.ts). Since
  // apply can now change this column, rollback must restore it too.
  it('restores Series.releaseStatus to releaseStatusBefore when the migration changed it', async () => {
    const { user, series, history } = await setUpAppliedFixture();
    // Simulate the fixed apply path: the migration changed releaseStatus
    // from RETURNING (before) to ENDED (after, matching the live series
    // row right now).
    await prisma.migrationHistory.update({ where: { id: history.id }, data: { releaseStatusBefore: ReleaseStatus.RETURNING, releaseStatusAfter: ReleaseStatus.ENDED } });
    await prisma.series.update({ where: { id: series.id }, data: { releaseStatus: ReleaseStatus.ENDED } });
    const historyWithReleaseStatusChange = await prisma.migrationHistory.findUniqueOrThrow({ where: { id: history.id } });

    await prisma.$transaction((tx) => executeMigrationRollback(tx, user.id, historyWithReleaseStatusChange));

    const seriesAfter = await prisma.series.findUniqueOrThrow({ where: { id: series.id } });
    expect(seriesAfter.releaseStatus).toBe(ReleaseStatus.RETURNING);
  });

  it('leaves Series.releaseStatus untouched when the migration never changed it (releaseStatusBefore === releaseStatusAfter)', async () => {
    const { user, series, history } = await setUpAppliedFixture();
    await prisma.migrationHistory.update({ where: { id: history.id }, data: { releaseStatusBefore: ReleaseStatus.ENDED, releaseStatusAfter: ReleaseStatus.ENDED } });
    const historyUnchanged = await prisma.migrationHistory.findUniqueOrThrow({ where: { id: history.id } });

    await prisma.$transaction((tx) => executeMigrationRollback(tx, user.id, historyUnchanged));

    const seriesAfter = await prisma.series.findUniqueOrThrow({ where: { id: series.id } });
    expect(seriesAfter.releaseStatus).toBe(ReleaseStatus.ENDED); // createFixtureSeries's original value, never touched
  });
});
