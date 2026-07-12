// Integration test proving SearchService.addSearchResult's duplicate-
// prevention against real Postgres: adding a provider identity that
// already resolves to an existing Series (via ExternalIds) must reuse that
// series, never create a second one — the core safety property Phase 7 of
// this feature's architecture plan called out as previously nonexistent
// anywhere in this codebase. Same throwaway-fixture convention as this
// project's other integration tests.
//
// Deliberately does NOT exercise the "create a brand-new series" branch —
// that path calls a live TMDb API (SearchService constructs its own
// TmdbClient internally, same no-DI convention as MigrationWorkbenchService,
// so it can't be swapped for a fake here) and isn't appropriate for a
// database-only integration suite. That branch is covered by manual
// real-library validation instead (see the feature's final report).

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, Series, User } from '@prisma/client';
import { SearchService } from '../search.service';
import { WatchlistService } from '../../watchlist/watchlist.service';
import { PrismaService } from '../../../prisma/prisma.service';

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('SearchService.addSearchResult — duplicate prevention (integration, real Postgres)', () => {
  const prisma = new PrismaService();
  const service = new SearchService(prisma, new WatchlistService(prisma));
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
    const user = await prisma.user.create({ data: { email: `search-add-test-${randomUUID()}@example.com`, displayName: 'Search Add Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeriesWithExternalIds(tmdbId: string): Promise<Series> {
    const series = await prisma.series.create({ data: { title: `Search Add Test Series ${randomUUID()}` } });
    createdSeriesIds.push(series.id);
    await prisma.externalIds.create({ data: { seriesId: series.id, tmdbId, provider: 'tmdb', providerId: tmdbId, matchConfidence: 1, matchSource: 'test-fixture', matchedAt: new Date() } });
    return series;
  }

  it('reuses the existing series when the provider identity is already known — never creates a duplicate', async () => {
    const user = await createFixtureUser();
    const tmdbId = String(900000 + Math.floor(Math.random() * 99999));
    const existing = await createFixtureSeriesWithExternalIds(tmdbId);

    const result = await service.addSearchResult(user.id, 'tmdb', tmdbId);

    expect(result.series.id).toBe(existing.id);
    const seriesCount = await prisma.series.count({ where: { externalIds: { tmdbId } } });
    expect(seriesCount).toBe(1);

    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: existing.id } } });
    expect(progress.userStatus).toBe('WATCHLIST');
  });

  it('is idempotent across repeated calls — calling add twice for the same identity still results in exactly one series', async () => {
    const user = await createFixtureUser();
    const tmdbId = String(900000 + Math.floor(Math.random() * 99999));
    const existing = await createFixtureSeriesWithExternalIds(tmdbId);

    const first = await service.addSearchResult(user.id, 'tmdb', tmdbId);
    const second = await service.addSearchResult(user.id, 'tmdb', tmdbId);

    expect(first.series.id).toBe(existing.id);
    expect(second.series.id).toBe(existing.id);
    const seriesCount = await prisma.series.count({ where: { externalIds: { tmdbId } } });
    expect(seriesCount).toBe(1);

    const watchlistItemCount = await prisma.watchlistItem.count({ where: { userId: user.id, seriesId: existing.id } });
    expect(watchlistItemCount).toBe(1);
  });

  it('user isolation: adding the same provider identity for two different users creates two independent progress rows against one shared series', async () => {
    const userA = await createFixtureUser();
    const userB = await createFixtureUser();
    const tmdbId = String(900000 + Math.floor(Math.random() * 99999));
    const existing = await createFixtureSeriesWithExternalIds(tmdbId);

    await service.addSearchResult(userA.id, 'tmdb', tmdbId);
    await service.addSearchResult(userB.id, 'tmdb', tmdbId);

    const seriesCount = await prisma.series.count({ where: { externalIds: { tmdbId } } });
    expect(seriesCount).toBe(1);
    const progressCount = await prisma.userSeriesProgress.count({ where: { seriesId: existing.id } });
    expect(progressCount).toBe(2);
  });
});
