// Integration test proving the NEW combination this task adds actually
// works together against a real Postgres database: creating missing
// Season/Episode rows (season-episode-writer.ts, reused from
// episode-release-refresh) in the SAME transaction as an ExternalIds
// upsert, matched-episode preservation, and an objectively-resolved
// UserSeriesProgress update (migration-policy-logic.ts) — the exact
// sequence run-provider-confirmation-pipeline.ts's apply transaction now
// performs for an auto-migrate-eligible title.
//
// Does not exercise the full pipeline script end-to-end (that requires a
// live TMDb/TVmaze fetch — covered instead by this task's real,
// TMDb-backed full-library DRY RUN, never a real apply). This test proves
// the write-path composition itself: given already-computed inputs, do
// catalog creation + status resolution + provenance tagging all correctly
// land together in one atomic unit, against a real throwaway fixture.
//
// Same isolated-fixture convention as apply-refresh-transaction.integration.test.ts:
// throwaway User + Series, cascade-deleted in afterEach, skips itself if
// DATABASE_URL isn't configured.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, ReleaseStatus, Series, User, UserSeriesStatus } from '@prisma/client';
import { createMissingSeasonsAndEpisodes } from '../../episode-release-refresh/season-episode-writer';
import { EpisodeInsertPlan } from '../../episode-release-refresh/build-episode-insert-plan';
import { resolveObjectiveMigrationStatus } from '../migration-policy-logic';
import { CATALOG_RECONCILIATION_IMPORT_BATCH_ID } from '../migration-catalog-plan-logic';

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;
const PAST = new Date('2020-01-01');

describeIfDbConfigured('catalog reconciliation transaction (integration, real Postgres)', () => {
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
    const user = await prisma.user.create({ data: { email: `catalog-reconciliation-test-${randomUUID()}@example.com`, displayName: 'Catalog Reconciliation Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeries(releaseStatus: ReleaseStatus = ReleaseStatus.ENDED): Promise<Series> {
    const series = await prisma.series.create({ data: { title: `Catalog Reconciliation Test Series ${randomUUID()}`, releaseStatus } });
    createdSeriesIds.push(series.id);
    return series;
  }

  it('creates missing seasons/episodes and objectively derives COMPLETED, all in one transaction, tagged with the catalog-reconciliation provenance marker', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries(ReleaseStatus.ENDED);
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    // 3 matched, all watched locally — mirrors the Chunibyo-style "fully
    // watched what the provider recognizes" case.
    const matchedEpisodes = await Promise.all([1, 2, 3].map((n) => prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: n, airDate: PAST } })));
    for (const ep of matchedEpisodes) {
      await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: ep.id, watchedAt: PAST } });
    }
    // An orphan: watched locally, no provider counterpart — must survive untouched.
    const orphanEpisode = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 99, title: 'Local Only Special', airDate: PAST } });
    await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: orphanEpisode.id, watchedAt: PAST } });

    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: null } });

    // The provider has a whole new season (season 2, 2 episodes) the local
    // catalog is missing entirely — exactly the "large catalog gap" case
    // SUSPICIOUS_BULK_INSERT would block in episode-release-refresh, now
    // reconciled here instead.
    const insertPlan: EpisodeInsertPlan = {
      episodesToInsert: [
        { seasonNumber: 2, episodeNumber: 1, title: 'New Season Ep 1', overview: null, airDate: PAST, imageUrl: null, runtimeMinutes: 24 },
        { seasonNumber: 2, episodeNumber: 2, title: 'New Season Ep 2', overview: null, airDate: PAST, imageUrl: null, runtimeMinutes: 24 },
      ],
      seasonNumbersToCreate: [2],
    };

    const objectiveStatus = resolveObjectiveMigrationStatus({
      matchedWatchedCount: 3,
      matchedTotalCount: 3,
      currentUserStatus: UserSeriesStatus.WATCHING,
      providerReleaseStatus: ReleaseStatus.ENDED,
    });
    expect(objectiveStatus.resolvedUserStatus).toBe(UserSeriesStatus.COMPLETED);

    // Mirrors exactly what run-provider-confirmation-pipeline.ts's
    // transaction does for an auto-migrate-eligible title: ExternalIds
    // upsert, catalog creation, then a progress write using the
    // objectively-resolved status — composed here directly against a real
    // DB rather than through the full (TMDb-fetching) orchestrator.
    await prisma.$transaction(async (tx) => {
      await tx.externalIds.upsert({
        where: { seriesId: series.id },
        create: { seriesId: series.id, provider: 'tmdb', providerId: '99999', tmdbId: '99999', matchSource: 'library-health:provider-confirmation-pipeline:auto-migration', matchConfidence: 1, matchedAt: new Date() },
        update: { provider: 'tmdb', providerId: '99999', tmdbId: '99999', matchSource: 'library-health:provider-confirmation-pipeline:auto-migration', matchConfidence: 1, matchedAt: new Date() },
      });

      const result = await createMissingSeasonsAndEpisodes(tx, { seriesId: series.id, insertPlan, importBatchId: CATALOG_RECONCILIATION_IMPORT_BATCH_ID });
      expect(result.seasonsCreated).toEqual([2]);
      expect(result.episodesInserted).toBe(2);

      await tx.userSeriesProgress.update({
        where: { userId_seriesId: { userId: user.id, seriesId: series.id } },
        data: { userStatus: objectiveStatus.resolvedUserStatus, nextEpisodeId: null },
      });
    });

    // --- Verify everything landed correctly, together, in one shot. ---
    const externalIds = await prisma.externalIds.findUniqueOrThrow({ where: { seriesId: series.id } });
    expect(externalIds.tmdbId).toBe('99999');
    expect(externalIds.matchSource).toBe('library-health:provider-confirmation-pipeline:auto-migration');

    const season2 = await prisma.season.findUniqueOrThrow({ where: { seriesId_seasonNumber: { seriesId: series.id, seasonNumber: 2 } } });
    expect(season2.importBatchId).toBe(CATALOG_RECONCILIATION_IMPORT_BATCH_ID);

    const newEpisodes = await prisma.episode.findMany({ where: { seasonId: season2.id }, orderBy: { episodeNumber: 'asc' } });
    expect(newEpisodes).toHaveLength(2);
    expect(newEpisodes.every((e) => e.importBatchId === CATALOG_RECONCILIATION_IMPORT_BATCH_ID)).toBe(true);

    // The orphan is completely untouched — same id, same title, still watched.
    const orphanAfter = await prisma.episode.findUniqueOrThrow({ where: { id: orphanEpisode.id } });
    expect(orphanAfter.title).toBe('Local Only Special');
    const orphanWatch = await prisma.episodeWatch.findUnique({ where: { userId_episodeId: { userId: user.id, episodeId: orphanEpisode.id } } });
    expect(orphanWatch).not.toBeNull();

    // The 3 originally-matched episodes are untouched too — never updated.
    for (const ep of matchedEpisodes) {
      const after = await prisma.episode.findUniqueOrThrow({ where: { id: ep.id } });
      expect(after.airDate?.getTime()).toBe(PAST.getTime());
    }

    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progress.userStatus).toBe(UserSeriesStatus.COMPLETED);

    // The newly-created episodes are NOT automatically watched.
    const newEpisodeWatches = await prisma.episodeWatch.findMany({ where: { episodeId: { in: newEpisodes.map((e) => e.id) } } });
    expect(newEpisodeWatches).toHaveLength(0);
  });
});
