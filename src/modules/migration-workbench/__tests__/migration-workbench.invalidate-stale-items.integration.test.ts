// Regression coverage for the Needs Attention staleness bug: list() used to
// serve the library-health CLI pipeline's cached manifest/report verbatim,
// with no cross-check against ProviderIdentityDecision/MigrationHistory, so
// a series confirmed+migrated entirely in-app stayed stuck in the Workbench
// until someone manually re-ran the CLI pipeline. invalidateStaleItems() is
// the fix — tested directly (bypassing list()'s hardcoded
// library-health/output/*.json file reads, which aren't the part under
// test) against real Postgres, same throwaway-fixture convention as this
// module's other integration tests.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, Series, User } from '@prisma/client';
import { MigrationWorkbenchService } from '../migration-workbench.service';
import { MigrationWorkbenchItem } from '../migration-workbench-logic';
import { PrismaService } from '../../../prisma/prisma.service';

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('MigrationWorkbenchService — Needs Attention staleness invalidation (integration, real Postgres)', () => {
  const prisma = new PrismaService();
  const service = new MigrationWorkbenchService(prisma);
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
    const user = await prisma.user.create({ data: { email: `stale-items-test-${randomUUID()}@example.com`, displayName: 'Stale Items Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeries(title: string): Promise<Series> {
    const series = await prisma.series.create({ data: { title } });
    createdSeriesIds.push(series.id);
    return series;
  }

  function invalidate(userId: string, items: MigrationWorkbenchItem[]): Promise<MigrationWorkbenchItem[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (service as any).invalidateStaleItems(userId, items);
  }

  it('drops an item entirely when a non-rolled-back MigrationHistory row exists — the reported "confirmed and migrated, still stuck" bug', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries('Confirmed And Migrated Series');
    await prisma.migrationHistory.create({
      data: {
        userId: user.id,
        seriesId: series.id,
        seriesTitle: series.title,
        classification: 'AUTO_MIGRATE',
        sourceCategory: 'READY_AUTOMATIC',
        providerAfter: { provider: 'tmdb', providerId: '1', tmdbId: '1' },
        userStatusBefore: 'WATCHING',
        userStatusAfter: 'CAUGHT_UP',
        episodesInsertedIds: [],
        episodesUpdatedIds: [],
        preservedOrphanEpisodeIds: [],
        watchedMappingCount: 0,
        verificationPassed: true,
        verificationDetail: [],
      },
    });

    const item: MigrationWorkbenchItem = { seriesId: series.id, title: series.title, category: 'READY_AUTOMATIC', reason: 'stale cached reason', proposal: null };
    const result = await invalidate(user.id, [item]);

    expect(result).toEqual([]);
  });

  it('does NOT drop an item whose only MigrationHistory has been rolled back — rollback must make a series reappear as unresolved, not stay hidden', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries('Rolled Back Migration Series');
    await prisma.migrationHistory.create({
      data: {
        userId: user.id,
        seriesId: series.id,
        seriesTitle: series.title,
        classification: 'AUTO_MIGRATE',
        sourceCategory: 'READY_AUTOMATIC',
        providerAfter: { provider: 'tmdb', providerId: '1', tmdbId: '1' },
        userStatusBefore: 'WATCHING',
        userStatusAfter: 'CAUGHT_UP',
        episodesInsertedIds: [],
        episodesUpdatedIds: [],
        preservedOrphanEpisodeIds: [],
        watchedMappingCount: 0,
        verificationPassed: true,
        verificationDetail: [],
        rolledBackAt: new Date(),
        rollbackReason: 'test rollback',
      },
    });

    const item: MigrationWorkbenchItem = { seriesId: series.id, title: series.title, category: 'READY_AUTOMATIC', reason: 'still unresolved after rollback', proposal: null };
    const result = await invalidate(user.id, [item]);

    expect(result).toEqual([item]);
  });

  it('leaves a genuinely unresolved item (no decision, no migration history) completely unchanged', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries('Genuinely Unresolved Series');

    const item: MigrationWorkbenchItem = { seriesId: series.id, title: series.title, category: 'NO_RELIABLE_PROVIDER', reason: 'no confirmed provider match and no decisions-file entry at all.', proposal: null };
    const result = await invalidate(user.id, [item]);

    expect(result).toEqual([item]);
  });

  it('attempts a live recompute for a NO_RELIABLE_PROVIDER item with a confirmed decision, and falls back to the cached item without crashing when the recompute fails', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries('Confirmed Identity No Token Series');
    await prisma.providerIdentityDecision.create({
      data: { userId: user.id, seriesId: series.id, decision: 'confirm', provider: 'tmdb', providerId: '999999', source: 'app-confirmation', confidence: 0.8 },
    });

    const originalToken = process.env.TMDB_ACCESS_TOKEN;
    delete process.env.TMDB_ACCESS_TOKEN; // forces getProposal() to throw, exercising the catch-and-keep-cached fallback

    try {
      const item: MigrationWorkbenchItem = { seriesId: series.id, title: series.title, category: 'NO_RELIABLE_PROVIDER', reason: 'no confirmed provider match and no decisions-file entry at all.', proposal: null };
      const result = await invalidate(user.id, [item]);

      expect(result).toEqual([item]);
    } finally {
      if (originalToken !== undefined) process.env.TMDB_ACCESS_TOKEN = originalToken;
    }
  });

  it('does not contradiction-flag a NO_RELIABLE_PROVIDER item that has no decision and no matched ExternalIds, even alongside other flagged items', async () => {
    const user = await createFixtureUser();
    const unresolved = await createFixtureSeries('Still Unresolved Sibling Series');
    const migrated = await createFixtureSeries('Migrated Sibling Series');
    await prisma.migrationHistory.create({
      data: {
        userId: user.id,
        seriesId: migrated.id,
        seriesTitle: migrated.title,
        classification: 'AUTO_MIGRATE',
        sourceCategory: 'READY_AUTOMATIC',
        providerAfter: { provider: 'tmdb', providerId: '2', tmdbId: '2' },
        userStatusBefore: 'WATCHING',
        userStatusAfter: 'CAUGHT_UP',
        episodesInsertedIds: [],
        episodesUpdatedIds: [],
        preservedOrphanEpisodeIds: [],
        watchedMappingCount: 0,
        verificationPassed: true,
        verificationDetail: [],
      },
    });

    const unresolvedItem: MigrationWorkbenchItem = { seriesId: unresolved.id, title: unresolved.title, category: 'NO_RELIABLE_PROVIDER', reason: 'no confirmed provider match and no decisions-file entry at all.', proposal: null };
    const migratedItem: MigrationWorkbenchItem = { seriesId: migrated.id, title: migrated.title, category: 'READY_AUTOMATIC', reason: 'stale', proposal: null };
    const result = await invalidate(user.id, [unresolvedItem, migratedItem]);

    expect(result).toEqual([unresolvedItem]);
  });
});
