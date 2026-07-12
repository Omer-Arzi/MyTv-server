// Regression coverage for the Migration Confirmation investigation: a
// decision confirmed through the in-app Find Provider flow
// (source: 'app-confirmation') has its providerId selected from a
// rendered candidate list, never typed — a categorically stronger identity
// signal than provider-confirmation-decisions.json's hand-edited entries
// (source: 'cli-decisions-file'), which checkTitleYearSanity exists
// specifically to protect against (a typo'd/stale id). Real examples this
// fixed: local "Mirai Nikki" vs TMDb's English "The Future Diary"
// (similarity 0.13), local "Nisekoi: False Love" vs TMDb's short
// "Nisekoi" (similarity 0.37) — both correctly identified by a human via
// Find Provider, both previously re-blocked by the automated title check
// on every later proposal/apply call.
//
// See run-provider-confirmation-for-decision.releasestatus.integration.test.ts
// for why this file exists (I/O-heavy orchestration, tested via
// integration proof) and the shared fixture pattern reused here.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, ReleaseStatus, User, UserSeriesStatus } from '@prisma/client';
import { TmdbClient } from '../../tmdb-enrichment/tmdb-client';
import { TvMazeClient } from '../../secondary-provider-audit/tvmaze-client';
import { loadSeriesHealthInputs } from '../load-series-health-inputs';
import { runProviderConfirmationForDecision } from '../run-provider-confirmation-for-decision';
import { ProviderConfirmationDecision } from '../provider-confirmation-decisions-logic';

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('runProviderConfirmationForDecision — identity-trust bypass for app-confirmed decisions (integration, real Postgres + mocked TMDb)', () => {
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
    const user = await prisma.user.create({ data: { email: `identity-trust-test-${randomUUID()}@example.com`, displayName: 'Identity Trust Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  // "Mirai Nikki"-shaped fixture: local title has NO real English/TMDb-style
  // resemblance to the (mocked) provider's title — exactly the translated-title
  // pattern this fix addresses. Title is suffixed with a fresh UUID —
  // loadSeriesHealthInputs loads every series in the table regardless of
  // owner, and local = healthInputs.find(s => s.title === decision.title)
  // matches by exact title string, so a literal fixture title like "Mirai
  // Nikki" can collide with an unrelated real series of that exact name
  // and match the wrong row nondeterministically.
  async function createFixtureSeries(userId: string, title: string, watchedCount: number) {
    const series = await prisma.series.create({ data: { title: `${title} ${randomUUID()}`, releaseStatus: ReleaseStatus.UNKNOWN } });
    createdSeriesIds.push(series.id);
    if (watchedCount > 0) {
      const season = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
      const episodes = await Promise.all(
        Array.from({ length: watchedCount }, (_, i) => prisma.episode.create({ data: { seasonId: season.id, episodeNumber: i + 1, title: `Episode ${i + 1}`, airDate: new Date('2020-01-01') } })),
      );
      for (const ep of episodes) await prisma.episodeWatch.create({ data: { userId, episodeId: ep.id, watchedAt: new Date('2020-02-01') } });
    }
    await prisma.userSeriesProgress.create({ data: { userId, seriesId: series.id, userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null } });
    return series;
  }

  function buildMockTmdb(providerTitle: string, episodeCount: number, episodeNumberOffset = 0): TmdbClient {
    return {
      getShowDetails: jest.fn().mockResolvedValue({ id: 46671, name: providerTitle, number_of_seasons: 1, status: 'Ended', first_air_date: '2011-01-01', genres: [], original_language: 'ja', origin_country: ['JP'] }),
      getSeasonsBatch: jest.fn().mockResolvedValue({
        'season/1': {
          id: 1,
          season_number: 1,
          episodes: Array.from({ length: episodeCount }, (_, i) => ({ id: i + 1, season_number: 1, episode_number: i + 1 + episodeNumberOffset, name: `Episode ${i + 1}`, air_date: '2011-01-01' })),
        },
      }),
    } as unknown as TmdbClient;
  }

  it('bypasses the title/year sanity floor for an app-confirmed decision with a genuinely low title similarity, and applies successfully', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries(user.id, 'Mirai Nikki', 0);
    // ExternalIds.tmdbId is globally unique — a real, arbitrary-looking
    // providerId shared across fixtures (or matching a real dev-DB series)
    // risks a genuine unique-constraint race; each test gets its own.
    const decision: ProviderConfirmationDecision = { title: series.title, decision: 'confirm', provider: 'tmdb', providerId: `9${randomUUID().replace(/-/g, '').slice(0, 6)}`, source: 'app-confirmation' };

    const healthInputs = await loadSeriesHealthInputs(prisma, user.id);
    const outcome = await runProviderConfirmationForDecision({
      prisma,
      tmdb: buildMockTmdb('The Future Diary', 26),
      tvmaze: new TvMazeClient(),
      decision,
      healthInputs,
      userId: user.id,
      generatedAt: new Date(),
      apply: true,
      applyAutoSafeMigrations: true,
      maxSeasonZeroOrphans: 1,
    });

    expect(outcome.kind).not.toBe('blocked');
    expect(['applied', 'dry-run-safe']).toContain(outcome.kind);
  });

  it('does NOT bypass the same low-similarity case for a cli-decisions-file-sourced decision — still correctly blocked', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries(user.id, 'Mirai Nikki', 0);
    const decision: ProviderConfirmationDecision = { title: series.title, decision: 'confirm', provider: 'tmdb', providerId: '46671', source: 'cli-decisions-file' };

    const healthInputs = await loadSeriesHealthInputs(prisma, user.id);
    const outcome = await runProviderConfirmationForDecision({
      prisma,
      tmdb: buildMockTmdb('The Future Diary', 26),
      tvmaze: new TvMazeClient(),
      decision,
      healthInputs,
      userId: user.id,
      generatedAt: new Date(),
      apply: true,
      applyAutoSafeMigrations: true,
      maxSeasonZeroOrphans: 1,
    });

    expect(outcome.kind).toBe('blocked');
  });

  it('does NOT bypass the same low-similarity case when source is undefined (no decision provenance at all) — defaults to strict', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries(user.id, 'Mirai Nikki', 0);
    const decision: ProviderConfirmationDecision = { title: series.title, decision: 'confirm', provider: 'tmdb', providerId: '46671' };

    const healthInputs = await loadSeriesHealthInputs(prisma, user.id);
    const outcome = await runProviderConfirmationForDecision({
      prisma,
      tmdb: buildMockTmdb('The Future Diary', 26),
      tvmaze: new TvMazeClient(),
      decision,
      healthInputs,
      userId: user.id,
      generatedAt: new Date(),
      apply: true,
      applyAutoSafeMigrations: true,
      maxSeasonZeroOrphans: 1,
    });

    expect(outcome.kind).toBe('blocked');
  });

  it('preserves the DROPPED protected status through an app-confirmed low-similarity apply, and preserves real watched history as orphans rather than inventing matches', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries(user.id, 'Nisekoi: False Love', 5);
    await prisma.userSeriesProgress.update({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } }, data: { userStatus: UserSeriesStatus.DROPPED } });
    // migrationIntent set — real-season orphans (as opposed to benign
    // season-0 orphans) are only ever tolerated via migration mode, a
    // separate concern from the identity-trust bypass this test targets.
    const decision: ProviderConfirmationDecision = {
      title: series.title,
      decision: 'confirm',
      provider: 'tmdb',
      providerId: `9${randomUUID().replace(/-/g, '').slice(0, 6)}`,
      source: 'app-confirmation',
      migrationIntent: true,
    };

    const healthInputs = await loadSeriesHealthInputs(prisma, user.id);
    const outcome = await runProviderConfirmationForDecision({
      prisma,
      // Provider season 1 has 8 episodes (>= local's 5, so detectRealSeasonShrink
      // stays false — this test isolates the identity floor only) numbered
      // 6-13 (offset 5), so none overlap with local's 1-5 -> all 5 local
      // watched episodes become orphans, never invented as "matched".
      tmdb: buildMockTmdb('Nisekoi', 8, 5),
      tvmaze: new TvMazeClient(),
      decision,
      healthInputs,
      userId: user.id,
      generatedAt: new Date(),
      apply: true,
      applyAutoSafeMigrations: true,
      maxSeasonZeroOrphans: 1,
    });

    expect(outcome.kind).not.toBe('blocked');
    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progress.userStatus).toBe(UserSeriesStatus.DROPPED); // protected status survives even an identity-trust-bypassed apply

    const watchCount = await prisma.episodeWatch.count({ where: { userId: user.id } });
    expect(watchCount).toBe(5); // every real watch preserved, none lost, none invented
  });
});
