// Integration coverage for the real incident that motivated this feature
// (mobile/docs/tab-restructure-todo.md's "how do I avoid this" follow-up):
// a genuinely new, safe season (Batman: Caped Crusader S2) sat blocked by
// episode-release-refresh's suspicious-bulk-insert guard with no way for
// the user to ever find out, because the Needs Attention list only ever
// reflected a static CLI report snapshot — it had no visibility into
// SeriesSyncStatus.lastRequiresManualReview, which the automatic scheduler
// sets in real time. sweepBlockedSeries() auto-applies the safe case;
// list() surfaces whatever it doesn't. Real Postgres, TMDb mocked at the
// global fetch level (same convention as episode-sync-scheduler's own
// integration test).

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, ReleaseStatus, User, UserSeriesStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { MigrationWorkbenchService } from '../migration-workbench.service';

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('MigrationWorkbenchService.sweepBlockedSeries / list() live-blocked surfacing (integration, real Postgres + mocked TMDb fetch)', () => {
  const prisma = new PrismaService();
  const service = new MigrationWorkbenchService(prisma);
  const createdUserIds: string[] = [];
  const createdSeriesIds: string[] = [];
  let fetchSpy: jest.SpyInstance;

  beforeAll(async () => {
    await prisma.$connect();
    if (!process.env.TMDB_ACCESS_TOKEN) process.env.TMDB_ACCESS_TOKEN = 'test-token-for-mocked-fetch';
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    for (const seriesId of createdSeriesIds.splice(0)) {
      await prisma.series.deleteMany({ where: { id: seriesId } });
    }
    for (const userId of createdUserIds.splice(0)) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  async function createFixtureUser(): Promise<User> {
    const user = await prisma.user.create({ data: { email: `sweep-blocked-test-${randomUUID()}@example.com`, displayName: 'Sweep Blocked Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  // Season 1 (2 watched eps) mirrors what the mocked provider will also
  // report for season 1 — a clean, fully-matching base — so the only
  // "new" thing a migration proposal finds is season 2, purely additive
  // (the Batman shape: existing local content matches perfectly, a whole
  // new season sits on top of it).
  async function createBlockedFixtureSeries(userId: string, tmdbId: string): Promise<{ seriesId: string; title: string }> {
    const title = `Sweep Blocked Test Series ${randomUUID()}`;
    const series = await prisma.series.create({ data: { title, releaseStatus: ReleaseStatus.RETURNING } });
    createdSeriesIds.push(series.id);
    await prisma.externalIds.create({ data: { seriesId: series.id, tmdbId } });
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const ep1 = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 1, title: 'Episode 1', airDate: new Date('2024-08-01') } });
    const ep2 = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 2, title: 'Episode 2', airDate: new Date('2024-08-01') } });
    await prisma.episodeWatch.create({ data: { userId, episodeId: ep1.id, watchedAt: new Date('2024-08-02') } });
    await prisma.episodeWatch.create({ data: { userId, episodeId: ep2.id, watchedAt: new Date('2024-08-02') } });
    await prisma.userSeriesProgress.create({ data: { userId, seriesId: series.id, userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null } });
    await prisma.providerIdentityDecision.create({
      data: { userId, seriesId: series.id, decision: 'confirm', provider: 'tmdb', providerId: tmdbId, source: 'app-confirmation', confidence: 0.9, migrationIntent: true, seasonShrinkReviewed: true },
    });
    await prisma.seriesSyncStatus.create({
      data: { seriesId: series.id, lastRequiresManualReview: true, lastEpisodeRefreshStatus: 'BLOCKED_MANUAL_REVIEW', refreshInProgress: false, updatedAt: new Date() },
    });
    return { seriesId: series.id, title };
  }

  // Season 1 identical to the fixture above (2 eps), plus a brand-new
  // season 2 (2 eps) — a purely additive, zero-orphan, high-confidence
  // shape that should classify READY_AUTOMATIC. providerTitle must match
  // the local series' own title exactly — identityBand's HIGH_CONFIDENCE
  // threshold is driven by real title-string similarity (titleSimilarity),
  // computed independently of the app-confirmation sanity-check bypass; a
  // mismatched "Mock Show" name lands BORDERLINE (READY_FOR_CONFIRMATION)
  // even with a confirmed decision, exactly like a real low-similarity
  // match would.
  function mockGlobalFetchWithSafeNewSeason(providerTitle: string) {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('external_ids')) {
        return new Response(JSON.stringify({ id: 1, name: providerTitle, number_of_seasons: 2, status: 'Returning Series', first_air_date: '2024-08-01', genres: [], original_language: 'en', origin_country: ['US'] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          'season/1': {
            id: 1,
            season_number: 1,
            episodes: [
              { id: 1, season_number: 1, episode_number: 1, name: 'Episode 1', air_date: '2024-08-01' },
              { id: 2, season_number: 1, episode_number: 2, name: 'Episode 2', air_date: '2024-08-01' },
            ],
          },
          'season/2': {
            id: 2,
            season_number: 2,
            episodes: [
              { id: 3, season_number: 2, episode_number: 1, name: 'S2 Episode 1', air_date: '2026-07-31' },
              { id: 4, season_number: 2, episode_number: 2, name: 'S2 Episode 2', air_date: '2026-07-31' },
            ],
          },
        }),
        { status: 200 },
      );
    });
  }

  // Genuinely blocked shape: local watched episode has no matching slot in
  // the (mocked) provider's response at all — a real numbering mismatch,
  // never auto-applicable.
  function mockGlobalFetchWithMismatch() {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('external_ids')) {
        return new Response(JSON.stringify({ id: 1, name: 'Mock Show', number_of_seasons: 1, status: 'Ended', first_air_date: '2024-08-01', genres: [], original_language: 'en', origin_country: ['US'] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          'season/1': {
            id: 1,
            season_number: 1,
            episodes: [{ id: 1, season_number: 1, episode_number: 1, name: 'Renumbered Episode', air_date: '2024-08-01' }],
          },
        }),
        { status: 200 },
      );
    });
  }

  it('auto-applies a safe blocked series and clears lastRequiresManualReview', async () => {
    const user = await createFixtureUser();
    const tmdbId = `9${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const { seriesId, title } = await createBlockedFixtureSeries(user.id, tmdbId);
    mockGlobalFetchWithSafeNewSeason(title);

    const summary = await service.sweepBlockedSeries(user.id);

    expect(summary).toEqual({ checked: 1, autoApplied: 1, alreadyResolved: 0, stillNeedsReview: 0, errored: 0 });

    const season2 = await prisma.season.findUnique({ where: { seriesId_seasonNumber: { seriesId, seasonNumber: 2 } }, include: { episodes: true } });
    expect(season2?.episodes).toHaveLength(2);

    const syncStatus = await prisma.seriesSyncStatus.findUniqueOrThrow({ where: { seriesId } });
    expect(syncStatus.lastRequiresManualReview).toBe(false);
  });

  // Regression test for a real bug caught via live testing against the dev
  // DB before this shipped: the first version of sweepBlockedSeries only
  // ever checked `proposal.eligible && category === 'READY_AUTOMATIC'` —
  // an already-fully-migrated series (eligible: false, by construction) hit
  // the `else` branch and stayed flagged forever, exactly the "still says
  // blocked when it's actually fine" bug this feature exists to fix.
  // Reproduces the real scenario exactly (this is how it was actually
  // found): apply once for real (e.g. an earlier sweep tick, or a manual
  // confirm), but leave SeriesSyncStatus.lastRequiresManualReview stale —
  // a second sweep pass over the same still-flagged series must find
  // nothing left to do and clear the flag anyway.
  it('clears the flag (as alreadyResolved, not stillNeedsReview) for a series that is already fully migrated', async () => {
    const user = await createFixtureUser();
    const tmdbId = `9${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const { seriesId, title } = await createBlockedFixtureSeries(user.id, tmdbId);
    mockGlobalFetchWithSafeNewSeason(title);
    await service.confirmMigration(user.id, seriesId);
    // confirmMigration doesn't touch SeriesSyncStatus at all (that's
    // Pipeline B's own bookkeeping) — re-flag it exactly as stale as the
    // real Batman case was found: migrated for real, flag never cleared.
    await prisma.seriesSyncStatus.update({ where: { seriesId }, data: { lastRequiresManualReview: true } });

    const summary = await service.sweepBlockedSeries(user.id);

    expect(summary).toEqual({ checked: 1, autoApplied: 0, alreadyResolved: 1, stillNeedsReview: 0, errored: 0 });

    const syncStatus = await prisma.seriesSyncStatus.findUniqueOrThrow({ where: { seriesId } });
    expect(syncStatus.lastRequiresManualReview).toBe(false);
  });

  it('leaves a genuinely blocked (non-automatic) series flagged and untouched', async () => {
    const user = await createFixtureUser();
    const tmdbId = `9${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const { seriesId } = await createBlockedFixtureSeries(user.id, tmdbId);
    mockGlobalFetchWithMismatch();

    const summary = await service.sweepBlockedSeries(user.id);

    expect(summary).toEqual({ checked: 1, autoApplied: 0, alreadyResolved: 0, stillNeedsReview: 1, errored: 0 });

    const syncStatus = await prisma.seriesSyncStatus.findUniqueOrThrow({ where: { seriesId } });
    expect(syncStatus.lastRequiresManualReview).toBe(true);

    const season2 = await prisma.season.findUnique({ where: { seriesId_seasonNumber: { seriesId, seasonNumber: 2 } } });
    expect(season2).toBeNull();
  });

  it('list() surfaces a live-blocked series the static cache has never heard of', async () => {
    const user = await createFixtureUser();
    const tmdbId = `9${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const { seriesId, title } = await createBlockedFixtureSeries(user.id, tmdbId);
    mockGlobalFetchWithMismatch();

    const items = await service.list(user.id);

    const item = items.find((i) => i.seriesId === seriesId);
    expect(item).toBeDefined();
    expect(item?.title).toBe(title);
  });

  it('list() does not surface a blocked series once it has been auto-resolved by the sweep', async () => {
    const user = await createFixtureUser();
    const tmdbId = `9${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const { seriesId, title } = await createBlockedFixtureSeries(user.id, tmdbId);
    mockGlobalFetchWithSafeNewSeason(title);

    await service.sweepBlockedSeries(user.id);
    const items = await service.list(user.id);

    expect(items.find((i) => i.seriesId === seriesId)).toBeUndefined();
  });
});
