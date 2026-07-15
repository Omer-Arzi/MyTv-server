// Regression coverage for a real incident (2026-07-12): confirming
// migration for "The Future Diary" failed with a raw, opaque Prisma error
// ("Invalid tx.externalIds.upsert() invocation ... Unique constraint failed
// on the fields: (`tmdbId`)") because it and "Mirai Nikki" — the same
// real-world show, imported as two separate local Series rows under
// different titles — both resolved to the same TMDb id. ExternalIds.tmdbId
// is globally unique, so the second confirm's upsert collided with the
// first series' already-confirmed row. run-provider-confirmation-for-decision.ts's
// catch block now detects this specific failure (Prisma P2002) and returns
// a clear, actionable message naming the conflicting series instead of the
// raw SQL/Prisma wording.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, ReleaseStatus, User, UserSeriesStatus } from '@prisma/client';
import { TmdbClient } from '../../tmdb-enrichment/tmdb-client';
import { TvMazeClient } from '../../secondary-provider-audit/tvmaze-client';
import { loadSeriesHealthInputs } from '../load-series-health-inputs';
import { findConflictingExternalIdsSeries, runProviderConfirmationForDecision } from '../run-provider-confirmation-for-decision';
import { ProviderConfirmationDecision } from '../provider-confirmation-decisions-logic';

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('runProviderConfirmationForDecision — duplicate-series identity conflict (integration, real Postgres + mocked TMDb)', () => {
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
    const user = await prisma.user.create({ data: { email: `identity-conflict-test-${randomUUID()}@example.com`, displayName: 'Identity Conflict Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeries(userId: string, title: string) {
    const series = await prisma.series.create({ data: { title: `${title} ${randomUUID()}`, releaseStatus: ReleaseStatus.UNKNOWN } });
    createdSeriesIds.push(series.id);
    await prisma.userSeriesProgress.create({ data: { userId, seriesId: series.id, userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: null } });
    return series;
  }

  function buildMockTmdb(providerTitle: string, tmdbId: number): TmdbClient {
    return {
      getShowDetails: jest.fn().mockResolvedValue({ id: tmdbId, name: providerTitle, number_of_seasons: 1, status: 'Ended', first_air_date: '2011-01-01', genres: [], original_language: 'ja', origin_country: ['JP'] }),
      getSeasonsBatch: jest.fn().mockResolvedValue({
        'season/1': { id: 1, season_number: 1, episodes: Array.from({ length: 26 }, (_, i) => ({ id: i + 1, season_number: 1, episode_number: i + 1, name: `Episode ${i + 1}`, air_date: '2011-01-01' })) },
      }),
    } as unknown as TmdbClient;
  }

  it('reports a clear, actionable error naming the conflicting series instead of a raw Prisma unique-constraint error', async () => {
    const user = await createFixtureUser();
    const tmdbId = `9${randomUUID().replace(/-/g, '').slice(0, 6)}`;

    // "Mirai Nikki" — already confirmed and fully migrated, holds tmdbId.
    const miraiNikki = await createFixtureSeries(user.id, 'Mirai Nikki');
    await prisma.externalIds.create({
      data: { seriesId: miraiNikki.id, tmdbId, provider: 'tmdb', providerId: tmdbId, matchConfidence: 1, matchSource: 'library-health:provider-confirmation-pipeline', matchedAt: new Date() },
    });

    // "The Future Diary" — the duplicate, being confirmed to the SAME real
    // show (same tmdbId) via the app, which is where the collision fires.
    const futureDiary = await createFixtureSeries(user.id, 'The Future Diary');
    const decision: ProviderConfirmationDecision = { title: futureDiary.title, decision: 'confirm', provider: 'tmdb', providerId: tmdbId, source: 'app-confirmation' };

    const healthInputs = await loadSeriesHealthInputs(prisma, user.id);
    const outcome = await runProviderConfirmationForDecision({
      prisma,
      tmdb: buildMockTmdb('Mirai Nikki', Number(tmdbId)),
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
    if (outcome.kind !== 'error') throw new Error('unreachable');
    expect(outcome.entry.message).toContain(miraiNikki.title);
    expect(outcome.entry.message).toContain('duplicate');
    expect(outcome.entry.message).not.toMatch(/tx\.externalIds\.upsert|PrismaClientKnownRequestError|Invalid `/i);

    // The colliding series' data must be completely untouched by the
    // failed attempt — no partial write, no orphaned decision confusion.
    const untouchedExternalIds = await prisma.externalIds.findUnique({ where: { seriesId: miraiNikki.id } });
    expect(untouchedExternalIds?.tmdbId).toBe(tmdbId);
    const futureDiaryExternalIds = await prisma.externalIds.findUnique({ where: { seriesId: futureDiary.id } });
    expect(futureDiaryExternalIds).toBeNull();
  });
});

describeIfDbConfigured('findConflictingExternalIdsSeries (integration, real Postgres)', () => {
  const prisma = new PrismaClient();
  const createdSeriesIds: string[] = [];

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    for (const seriesId of createdSeriesIds.splice(0)) {
      await prisma.series.deleteMany({ where: { id: seriesId } });
    }
  });

  async function createSeriesWithExternalIds(tmdbId: string | null, provider: string, providerId: string) {
    const series = await prisma.series.create({ data: { title: `Conflict Lookup Test ${randomUUID()}` } });
    createdSeriesIds.push(series.id);
    await prisma.externalIds.create({ data: { seriesId: series.id, tmdbId, provider, providerId, matchConfidence: 1, matchSource: 'test-fixture', matchedAt: new Date() } });
    return series;
  }

  it('finds the other series holding the same tmdbId', async () => {
    const tmdbId = `9${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const holder = await createSeriesWithExternalIds(tmdbId, 'tmdb', tmdbId);

    const conflict = await findConflictingExternalIdsSeries(prisma, { seriesId: 'some-other-series-id-not-in-db', provider: 'tmdb', providerId: tmdbId, tmdbId });
    expect(conflict).toEqual({ seriesId: holder.id, title: holder.title });
  });

  it('excludes the series itself — never reports a self-conflict', async () => {
    const tmdbId = `9${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const holder = await createSeriesWithExternalIds(tmdbId, 'tmdb', tmdbId);

    const conflict = await findConflictingExternalIdsSeries(prisma, { seriesId: holder.id, provider: 'tmdb', providerId: tmdbId, tmdbId });
    expect(conflict).toBeNull();
  });

  it('returns null when no other series holds this identity', async () => {
    const tmdbId = `9${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const conflict = await findConflictingExternalIdsSeries(prisma, { seriesId: 'irrelevant', provider: 'tmdb', providerId: tmdbId, tmdbId });
    expect(conflict).toBeNull();
  });
});
