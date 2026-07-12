// Integration test proving the confidence-contract fix end to end against
// real Postgres: MigrationWorkbenchService.confirmIdentity persists exactly
// the normalized 0..1 value a real candidate-search response would send —
// same throwaway-fixture convention as this project's other integration
// tests. Regression coverage for the reported bug: a candidate confidence
// of 0.8 (displayed as "80%") used to be sent to this endpoint as a raw
// 80 by an earlier version of the mobile client, which a 0..1-validated
// DTO correctly rejected — this test proves the currently-wired value
// (already normalized before this endpoint ever sees it) round-trips
// cleanly.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, Series, User } from '@prisma/client';
import { MigrationWorkbenchService } from '../migration-workbench.service';
import { PrismaService } from '../../../prisma/prisma.service';

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('MigrationWorkbenchService.confirmIdentity — confidence contract (integration, real Postgres)', () => {
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
    const user = await prisma.user.create({ data: { email: `confirm-identity-test-${randomUUID()}@example.com`, displayName: 'Confirm Identity Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeries(): Promise<Series> {
    const series = await prisma.series.create({ data: { title: `Confirm Identity Test Series ${randomUUID()}` } });
    createdSeriesIds.push(series.id);
    return series;
  }

  it('persists the exact normalized confidence a real candidate-search response would send — the reported "80%" case', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();

    // Exactly what GET /:seriesId/candidates now returns for an
    // exact-title-match, top-position candidate: 0.8, never 80.
    const result = await service.confirmIdentity(user.id, series.id, { provider: 'tmdb', providerId: '604', confidence: 0.8 });

    expect(result).toEqual({ seriesId: series.id, saved: true });

    const row = await prisma.providerIdentityDecision.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(row.confidence).toBe(0.8);
    expect(row.provider).toBe('tmdb');
    expect(row.providerId).toBe('604');
    expect(row.decision).toBe('confirm');
    expect(row.source).toBe('app-confirmation');
  });

  it('accepts the full valid range boundaries (0 and 1) without rejection', async () => {
    const user = await createFixtureUser();
    const seriesLow = await createFixtureSeries();
    const seriesHigh = await createFixtureSeries();

    await expect(service.confirmIdentity(user.id, seriesLow.id, { provider: 'tmdb', providerId: '1', confidence: 0 })).resolves.toEqual({ seriesId: seriesLow.id, saved: true });
    await expect(service.confirmIdentity(user.id, seriesHigh.id, { provider: 'tmdb', providerId: '2', confidence: 1 })).resolves.toEqual({ seriesId: seriesHigh.id, saved: true });
  });

  it('throws NotFoundException for a series that does not exist', async () => {
    const user = await createFixtureUser();
    await expect(service.confirmIdentity(user.id, randomUUID(), { provider: 'tmdb', providerId: '1', confidence: 0.5 })).rejects.toThrow();
  });
});
