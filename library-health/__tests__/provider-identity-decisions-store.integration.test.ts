// Integration test for the runtime-safe provider-decision persistence
// layer — proves the CLI pipeline and the in-app Migration Workbench read
// the exact same table, decisions persist durably, and one user's decision
// never leaks into another user's read. Same throwaway-fixture convention
// as this project's other integration tests.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { findDecisionForSeries, loadDecisionsFromDb, saveProviderIdentityDecision } from '../provider-identity-decisions-store';

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('provider-identity-decisions-store (integration, real Postgres)', () => {
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

  async function createFixtureUser() {
    const user = await prisma.user.create({ data: { email: `decisions-store-test-${randomUUID()}@example.com`, displayName: 'Decisions Store Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeries(title: string) {
    const series = await prisma.series.create({ data: { title } });
    createdSeriesIds.push(series.id);
    return series;
  }

  it('persists an explicit app confirmation durably, retrievable by findDecisionForSeries', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries('Persistence Test Show');

    await saveProviderIdentityDecision(prisma, { userId: user.id, seriesId: series.id, provider: 'tmdb', providerId: '999', confidence: 0.91 });

    const result = await findDecisionForSeries(prisma, user.id, series.id);
    expect(result.hasRecord).toBe(true);
    expect(result.decision).toEqual({
      title: 'Persistence Test Show',
      decision: 'confirm',
      provider: 'tmdb',
      providerId: '999',
      migrationIntent: false,
      statusOverride: undefined,
      notes: undefined,
    });
  });

  it('returns hasRecord: false and a null decision when nothing has been decided', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries('Undecided Show');

    const result = await findDecisionForSeries(prisma, user.id, series.id);
    expect(result.hasRecord).toBe(false);
    expect(result.decision).toBeNull();
  });

  it('isolates decisions per user — the same series can have independent decisions for two different users', async () => {
    const userA = await createFixtureUser();
    const userB = await createFixtureUser();
    const series = await createFixtureSeries('Shared Catalog Show');

    await saveProviderIdentityDecision(prisma, { userId: userA.id, seriesId: series.id, provider: 'tmdb', providerId: '111', confidence: 0.9 });

    const resultA = await findDecisionForSeries(prisma, userA.id, series.id);
    const resultB = await findDecisionForSeries(prisma, userB.id, series.id);

    expect(resultA.hasRecord).toBe(true);
    expect(resultA.decision?.providerId).toBe('111');
    expect(resultB.hasRecord).toBe(false);
  });

  it('loadDecisionsFromDb (the CLI pipeline\'s read path) sees exactly what saveProviderIdentityDecision (the app\'s write path) wrote — one shared source of truth', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries('Shared Source Of Truth Show');

    await saveProviderIdentityDecision(prisma, { userId: user.id, seriesId: series.id, provider: 'tmdb', providerId: '222', confidence: 0.95 });

    const allDecisions = await loadDecisionsFromDb(prisma, user.id);
    const match = allDecisions.find((d) => d.title === 'Shared Source Of Truth Show');
    expect(match).toEqual({
      title: 'Shared Source Of Truth Show',
      decision: 'confirm',
      provider: 'tmdb',
      providerId: '222',
      migrationIntent: false,
      statusOverride: undefined,
      notes: undefined,
    });
  });

  it('re-confirming the same series updates the existing row rather than creating a duplicate', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries('Re-confirm Test Show');

    await saveProviderIdentityDecision(prisma, { userId: user.id, seriesId: series.id, provider: 'tmdb', providerId: '111', confidence: 0.7 });
    await saveProviderIdentityDecision(prisma, { userId: user.id, seriesId: series.id, provider: 'tmdb', providerId: '333', confidence: 0.98 });

    const rows = await prisma.providerIdentityDecision.findMany({ where: { userId: user.id, seriesId: series.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].providerId).toBe('333');
    expect(rows[0].source).toBe('app-confirmation');
  });
});
