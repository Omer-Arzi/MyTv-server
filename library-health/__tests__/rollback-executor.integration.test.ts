// Integration test proving the Phase 8 rollback executor's refusal rules
// are real against a live database, not just pure-logic assertions: a
// successful rollback actually deletes only the rows this batch created and
// restores progress; an attempted rollback on a series whose newly-created
// episode has since been watched THROWS and writes nothing; an attempted
// rollback on a series whose progress has drifted since the apply THROWS
// and writes nothing; and pre-existing (non-batch) rows are never touched
// by a rollback, even when eligible.
//
// Same throwaway-fixture convention as the other integration tests in this
// directory.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, ReleaseStatus, Series, User, UserSeriesStatus } from '@prisma/client';
import { createMissingSeasonsAndEpisodes } from '../../episode-release-refresh/season-episode-writer';
import { EpisodeInsertPlan } from '../../episode-release-refresh/build-episode-insert-plan';
import { CATALOG_RECONCILIATION_IMPORT_BATCH_ID } from '../migration-catalog-plan-logic';
import { evaluateRollbackEligibility, RollbackManifestEntry } from '../rollback-logic';
import { executeRollback, RollbackRefusedError } from '../rollback-executor';

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;
const PAST = new Date('2020-01-01');

describeIfDbConfigured('rollback executor (integration, real Postgres)', () => {
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
    const user = await prisma.user.create({ data: { email: `rollback-test-${randomUUID()}@example.com`, displayName: 'Rollback Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeries(): Promise<Series> {
    const series = await prisma.series.create({ data: { title: `Rollback Test Series ${randomUUID()}`, releaseStatus: ReleaseStatus.ENDED } });
    createdSeriesIds.push(series.id);
    return series;
  }

  // Sets up: a pre-existing watched orphan (must survive any rollback), and
  // runs the real catalog-reconciliation apply (season 2, 2 new episodes,
  // WATCHING -> COMPLETED), mirroring what run-provider-confirmation-pipeline.ts
  // does for a real auto-migrate-eligible title.
  async function setUpAppliedFixture() {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
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

    await prisma.$transaction(async (tx) => {
      await createMissingSeasonsAndEpisodes(tx, { seriesId: series.id, insertPlan, importBatchId: CATALOG_RECONCILIATION_IMPORT_BATCH_ID });
      await tx.userSeriesProgress.update({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } }, data: { userStatus: UserSeriesStatus.COMPLETED, nextEpisodeId: null } });
    });

    const manifestEntry: RollbackManifestEntry = {
      seriesId: series.id,
      title: series.title,
      importBatchId: CATALOG_RECONCILIATION_IMPORT_BATCH_ID,
      priorUserStatus: UserSeriesStatus.WATCHING,
      priorNextEpisodeId: null,
      appliedUserStatus: UserSeriesStatus.COMPLETED,
      appliedNextEpisodeId: null,
      createdSeasonNumbers: [2],
      createdEpisodeCount: 2,
      episodeMetadataUpdateCount: 0,
      hasReversibleChanges: true,
      unsupportedChangeNote: null,
    };

    return { user, series, orphanEpisode, manifestEntry };
  }

  it('rolls back cleanly when eligible: deletes only the batch-created rows and restores prior progress, leaving pre-existing rows untouched', async () => {
    const { user, series, orphanEpisode, manifestEntry } = await setUpAppliedFixture();

    const createdEpisodes = await prisma.episode.findMany({ where: { importBatchId: CATALOG_RECONCILIATION_IMPORT_BATCH_ID, season: { seriesId: series.id } } });
    expect(createdEpisodes).toHaveLength(2);

    const eligibility = evaluateRollbackEligibility({
      entry: manifestEntry,
      currentUserStatus: UserSeriesStatus.COMPLETED,
      currentNextEpisodeId: null,
      createdEpisodesWithWatches: [],
    });
    expect(eligibility.eligible).toBe(true);

    const result = await prisma.$transaction((tx) => executeRollback(tx, user.id, manifestEntry, eligibility));
    expect(result.episodesDeleted).toBe(2);
    expect(result.seasonsDeleted).toBe(1);
    expect(result.progressRestored).toBe(true);

    const remainingEpisodes = await prisma.episode.findMany({ where: { importBatchId: CATALOG_RECONCILIATION_IMPORT_BATCH_ID, season: { seriesId: series.id } } });
    expect(remainingEpisodes).toHaveLength(0);
    const remainingSeason2 = await prisma.season.findUnique({ where: { seriesId_seasonNumber: { seriesId: series.id, seasonNumber: 2 } } });
    expect(remainingSeason2).toBeNull();

    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progress.userStatus).toBe(UserSeriesStatus.WATCHING);
    expect(progress.nextEpisodeId).toBeNull();

    // The pre-existing orphan (never part of this batch) must survive completely untouched.
    const orphanAfter = await prisma.episode.findUniqueOrThrow({ where: { id: orphanEpisode.id } });
    expect(orphanAfter.title).toBe('Local Only Special');
    const orphanWatch = await prisma.episodeWatch.findUnique({ where: { userId_episodeId: { userId: user.id, episodeId: orphanEpisode.id } } });
    expect(orphanWatch).not.toBeNull();
  });

  it('refuses and writes nothing when a batch-created episode has since been watched', async () => {
    const { user, series, manifestEntry } = await setUpAppliedFixture();

    const createdEpisode = await prisma.episode.findFirstOrThrow({ where: { importBatchId: CATALOG_RECONCILIATION_IMPORT_BATCH_ID, season: { seriesId: series.id } } });
    await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: createdEpisode.id, watchedAt: new Date() } });

    const eligibility = evaluateRollbackEligibility({
      entry: manifestEntry,
      currentUserStatus: UserSeriesStatus.COMPLETED,
      currentNextEpisodeId: null,
      createdEpisodesWithWatches: [createdEpisode.id],
    });
    expect(eligibility.eligible).toBe(false);

    await expect(prisma.$transaction((tx) => executeRollback(tx, user.id, manifestEntry, eligibility))).rejects.toThrow(RollbackRefusedError);

    // Nothing was deleted or changed — the created episode (now watched) still exists.
    const stillThere = await prisma.episode.findUnique({ where: { id: createdEpisode.id } });
    expect(stillThere).not.toBeNull();
    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progress.userStatus).toBe(UserSeriesStatus.COMPLETED); // unchanged — rollback never ran
  });

  it('refuses and writes nothing when progress has drifted since the apply (user changed status manually afterward)', async () => {
    const { user, series, manifestEntry } = await setUpAppliedFixture();

    // Simulate a manual status change that happened after the batch applied.
    await prisma.userSeriesProgress.update({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } }, data: { userStatus: UserSeriesStatus.DROPPED } });

    const eligibility = evaluateRollbackEligibility({
      entry: manifestEntry,
      currentUserStatus: UserSeriesStatus.DROPPED,
      currentNextEpisodeId: null,
      createdEpisodesWithWatches: [],
    });
    expect(eligibility.eligible).toBe(false);

    await expect(prisma.$transaction((tx) => executeRollback(tx, user.id, manifestEntry, eligibility))).rejects.toThrow(RollbackRefusedError);

    const createdEpisodesStill = await prisma.episode.findMany({ where: { importBatchId: CATALOG_RECONCILIATION_IMPORT_BATCH_ID, season: { seriesId: series.id } } });
    expect(createdEpisodesStill).toHaveLength(2); // rollback never ran, nothing deleted
    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progress.userStatus).toBe(UserSeriesStatus.DROPPED); // the manual change is preserved, not silently overwritten
  });

  it('re-verifies eligibility live inside the transaction even if a stale eligible=true result is passed in', async () => {
    const { user, series, manifestEntry } = await setUpAppliedFixture();

    const createdEpisode = await prisma.episode.findFirstOrThrow({ where: { importBatchId: CATALOG_RECONCILIATION_IMPORT_BATCH_ID, season: { seriesId: series.id } } });
    // A watch appears AFTER eligibility was computed (stale check) — the
    // executor's own live re-check inside the transaction must still catch it.
    const staleEligibility = evaluateRollbackEligibility({ entry: manifestEntry, currentUserStatus: UserSeriesStatus.COMPLETED, currentNextEpisodeId: null, createdEpisodesWithWatches: [] });
    expect(staleEligibility.eligible).toBe(true);

    await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: createdEpisode.id, watchedAt: new Date() } });

    await expect(prisma.$transaction((tx) => executeRollback(tx, user.id, manifestEntry, staleEligibility))).rejects.toThrow(RollbackRefusedError);

    const stillThere = await prisma.episode.findUnique({ where: { id: createdEpisode.id } });
    expect(stillThere).not.toBeNull();
  });
});
