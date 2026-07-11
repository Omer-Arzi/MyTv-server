// Integration test for Phase 1 apply's one write path (applySeriesInsertPlan)
// against a real Postgres database — the same DATABASE_URL every other
// script in this repo uses (see .env). This is the first test in the repo
// to touch a real database rather than pure logic; every fixture here is a
// throwaway User + Series (unique, randomly-named per test) that gets
// deleted at the end of each test via cascade, and nothing pre-existing is
// ever read or written. If DATABASE_URL isn't configured at all, this file
// skips itself entirely rather than failing — see the guard below.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, ReleaseStatus, Series, User, UserSeriesStatus } from '@prisma/client';
import { applySeriesInsertPlan, PHASE1_APPLY_IMPORT_BATCH_ID } from '../apply-refresh-transaction';
import { EpisodeInsertPlan } from '../build-episode-insert-plan';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAST = new Date(Date.now() - 30 * DAY_MS);
const PAST_2 = new Date(Date.now() - 20 * DAY_MS);
const NEW_RELEASED = new Date(Date.now() - 1 * DAY_MS);

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('applySeriesInsertPlan (integration, real Postgres)', () => {
  const prisma = new PrismaClient();
  const createdUserIds: string[] = [];
  const createdSeriesIds: string[] = [];

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    // Deleting the throwaway Series cascades Season -> Episode ->
    // EpisodeWatch, and UserSeriesProgress (via its seriesId FK) — see
    // schema.prisma's onDelete: Cascade on every one of those relations.
    // Deleting the throwaway User afterward is then always safe (nothing
    // still references it).
    for (const seriesId of createdSeriesIds.splice(0)) {
      await prisma.series.deleteMany({ where: { id: seriesId } });
    }
    for (const userId of createdUserIds.splice(0)) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  async function createFixtureUser(): Promise<User> {
    const user = await prisma.user.create({
      data: { email: `episode-release-refresh-apply-test-${randomUUID()}@example.com`, displayName: 'Phase 1 Apply Integration Test User' },
    });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeries(releaseStatus: ReleaseStatus = ReleaseStatus.RETURNING): Promise<Series> {
    const series = await prisma.series.create({ data: { title: `Phase 1 Apply Test Series ${randomUUID()}`, releaseStatus } });
    createdSeriesIds.push(series.id);
    return series;
  }

  it('inserts a new released episode into an existing season, and progresses CAUGHT_UP -> WATCHING pointing at the new episode', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const ep1 = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 1, airDate: PAST } });
    await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: ep1.id, watchedAt: PAST_2 } });
    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null } });

    const insertPlan: EpisodeInsertPlan = {
      episodesToInsert: [{ seasonNumber: 1, episodeNumber: 2, title: 'New Episode', overview: 'An overview', airDate: NEW_RELEASED, imageUrl: 'https://img/still.jpg', runtimeMinutes: 24 }],
      seasonNumbersToCreate: [],
    };

    const result = await applySeriesInsertPlan(prisma, { userId: user.id, seriesId: series.id, insertPlan });

    expect(result.writeSkippedReason).toBeNull();
    expect(result.episodesInserted).toBe(1);
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.seasonsCreated).toEqual([]);
    expect(result.progressRecomputed).toBe(true);
    expect(result.progressChange?.userStatusFrom).toBe(UserSeriesStatus.CAUGHT_UP);
    expect(result.progressChange?.userStatusTo).toBe(UserSeriesStatus.WATCHING);

    const insertedEpisode = await prisma.episode.findUnique({ where: { seasonId_episodeNumber: { seasonId: season1.id, episodeNumber: 2 } } });
    expect(insertedEpisode).not.toBeNull();
    expect(insertedEpisode?.title).toBe('New Episode');
    expect(insertedEpisode?.runtimeMinutes).toBe(24);
    expect(insertedEpisode?.importBatchId).toBe(PHASE1_APPLY_IMPORT_BATCH_ID);

    const progress = await prisma.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progress?.userStatus).toBe(UserSeriesStatus.WATCHING);
    expect(progress?.nextEpisodeId).toBe(insertedEpisode!.id);
  });

  it('moves a COMPLETED series to WATCHING when a new released episode is inserted (the renewal case Phase 1 exists for)', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries(ReleaseStatus.ENDED);
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const ep1 = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 1, airDate: PAST } });
    await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: ep1.id, watchedAt: PAST_2 } });
    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.COMPLETED, nextEpisodeId: null } });

    const insertPlan: EpisodeInsertPlan = {
      episodesToInsert: [{ seasonNumber: 2, episodeNumber: 1, title: 'Surprise Revival', overview: null, airDate: NEW_RELEASED, imageUrl: null, runtimeMinutes: null }],
      seasonNumbersToCreate: [2],
    };

    const result = await applySeriesInsertPlan(prisma, { userId: user.id, seriesId: series.id, insertPlan });

    expect(result.seasonsCreated).toEqual([2]);
    expect(result.episodesInserted).toBe(1);
    expect(result.progressChange?.userStatusFrom).toBe(UserSeriesStatus.COMPLETED);
    expect(result.progressChange?.userStatusTo).toBe(UserSeriesStatus.WATCHING);

    const newSeason = await prisma.season.findUnique({ where: { seriesId_seasonNumber: { seriesId: series.id, seasonNumber: 2 } } });
    expect(newSeason).not.toBeNull();
    expect(newSeason?.importBatchId).toBe(PHASE1_APPLY_IMPORT_BATCH_ID);
  });

  it('leaves nextEpisodeId pointing at the earlier existing unwatched episode after a later new episode is inserted, and skips the progress write entirely since nothing actually changed (catalog changed / progress did not — docs/progress-reconciliation-architecture-todo.md Phase 4 case 2)', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const ep1 = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 1, airDate: PAST } });
    const ep2 = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 2, airDate: PAST_2 } }); // unwatched, already released
    await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: ep1.id, watchedAt: PAST } });
    const progressBefore = await prisma.userSeriesProgress.create({
      data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: ep2.id },
    });

    const insertPlan: EpisodeInsertPlan = {
      episodesToInsert: [{ seasonNumber: 1, episodeNumber: 3, title: 'Even Newer Episode', overview: null, airDate: NEW_RELEASED, imageUrl: null, runtimeMinutes: null }],
      seasonNumbersToCreate: [],
    };

    const result = await applySeriesInsertPlan(prisma, { userId: user.id, seriesId: series.id, insertPlan });

    // The episode WAS inserted (catalog changed)...
    expect(result.episodesInserted).toBe(1);
    // ...but recomputing lands on the exact same WATCHING/ep2.id already
    // stored (S1E2 is still the earliest unwatched released episode, not
    // the brand-new S1E3), so no progress write happens at all.
    expect(result.progressRecomputed).toBe(false);
    expect(result.progressChange).toBeNull();
    expect(result.progressSkippedReason).toMatch(/already matches what was stored/);

    const progressAfter = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { id: progressBefore.id } });
    expect(progressAfter.nextEpisodeId).toBe(ep2.id);
    expect(progressAfter.userStatus).toBe(UserSeriesStatus.WATCHING);
    // No write means no updatedAt bump either — the concrete proof this
    // was actually skipped, not just coincidentally re-written to the same
    // value.
    expect(progressAfter.updatedAt.getTime()).toBe(progressBefore.updatedAt.getTime());
  });

  it('never touches an existing Episode row or its EpisodeWatch row', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const ep1 = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 1, title: 'Original Title', overview: 'Original overview', airDate: PAST } });
    const watch = await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: ep1.id, watchedAt: PAST_2 } });
    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null } });

    const insertPlan: EpisodeInsertPlan = {
      episodesToInsert: [{ seasonNumber: 1, episodeNumber: 2, title: 'New Episode', overview: null, airDate: NEW_RELEASED, imageUrl: null, runtimeMinutes: null }],
      seasonNumbersToCreate: [],
    };

    await applySeriesInsertPlan(prisma, { userId: user.id, seriesId: series.id, insertPlan });

    const episodeAfter = await prisma.episode.findUniqueOrThrow({ where: { id: ep1.id } });
    expect(episodeAfter.title).toBe('Original Title');
    expect(episodeAfter.overview).toBe('Original overview');
    expect(episodeAfter.airDate?.getTime()).toBe(PAST.getTime());

    const watchAfter = await prisma.episodeWatch.findUniqueOrThrow({ where: { id: watch.id } });
    expect(watchAfter.watchedAt.getTime()).toBe(PAST_2.getTime());
  });

  it('handles a duplicate-episode collision gracefully via skipDuplicates, without aborting the rest of the insert', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const ep1 = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 1, airDate: PAST } });
    // Simulate a race: episode 2 already exists locally (e.g. another
    // process inserted it) even though our plan — built from a slightly
    // stale snapshot — still thinks it's new.
    const alreadyExisting = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 2, title: 'Already Here', airDate: PAST_2 } });
    await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: ep1.id, watchedAt: PAST } });
    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: alreadyExisting.id } });

    const insertPlan: EpisodeInsertPlan = {
      episodesToInsert: [
        { seasonNumber: 1, episodeNumber: 2, title: 'Colliding Episode', overview: null, airDate: NEW_RELEASED, imageUrl: null, runtimeMinutes: null },
        { seasonNumber: 1, episodeNumber: 3, title: 'Genuinely New Episode', overview: null, airDate: NEW_RELEASED, imageUrl: null, runtimeMinutes: null },
      ],
      seasonNumbersToCreate: [],
    };

    const result = await applySeriesInsertPlan(prisma, { userId: user.id, seriesId: series.id, insertPlan });

    expect(result.episodesInserted).toBe(1); // only S1E3
    expect(result.duplicatesSkipped).toBe(1); // S1E2 collision

    const episode2After = await prisma.episode.findUniqueOrThrow({ where: { id: alreadyExisting.id } });
    expect(episode2After.title).toBe('Already Here'); // untouched, never overwritten with "Colliding Episode"

    const episode3 = await prisma.episode.findUnique({ where: { seasonId_episodeNumber: { seasonId: season1.id, episodeNumber: 3 } } });
    expect(episode3).not.toBeNull();
    expect(episode3?.title).toBe('Genuinely New Episode');
  });

  it('does not recompute progress when every planned episode turns out to be a duplicate (zero actually inserted)', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const existing = await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 1, airDate: PAST } });
    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null } });

    const insertPlan: EpisodeInsertPlan = {
      episodesToInsert: [{ seasonNumber: 1, episodeNumber: 1, title: 'Collides With Existing', overview: null, airDate: NEW_RELEASED, imageUrl: null, runtimeMinutes: null }],
      seasonNumbersToCreate: [],
    };

    const result = await applySeriesInsertPlan(prisma, { userId: user.id, seriesId: series.id, insertPlan });

    expect(result.episodesInserted).toBe(0);
    expect(result.duplicatesSkipped).toBe(1);
    expect(result.progressRecomputed).toBe(false);
    expect(result.progressSkippedReason).toContain('no episodes were actually inserted');

    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progress.userStatus).toBe(UserSeriesStatus.CAUGHT_UP); // unchanged
    expect(existing.id).toBeTruthy();
  });

  // Fix #2: the live eligibility gate must guard EVERY write (season,
  // episode, AND progress) — not just the progress recompute. A series
  // that's raced to a protected status between candidate selection and
  // this transaction must receive zero writes of any kind.
  it('performs zero Season/Episode/Progress writes when the live userStatus has raced to a protected status', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    await prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: 1, airDate: PAST } });
    // Live status is DROPPED at write time — simulates the user dropping
    // the series between candidate selection (which would have required a
    // tracked status) and this transaction running.
    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.DROPPED, nextEpisodeId: null } });

    const insertPlan: EpisodeInsertPlan = {
      episodesToInsert: [{ seasonNumber: 2, episodeNumber: 1, title: 'New Episode', overview: null, airDate: NEW_RELEASED, imageUrl: null, runtimeMinutes: null }],
      seasonNumbersToCreate: [2],
    };

    const result = await applySeriesInsertPlan(prisma, { userId: user.id, seriesId: series.id, insertPlan });

    expect(result.writeSkippedReason).toContain('DROPPED');
    expect(result.episodesInserted).toBe(0);
    expect(result.seasonsCreated).toEqual([]);
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.progressRecomputed).toBe(false);
    expect(result.progressChange).toBeNull();

    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progress.userStatus).toBe(UserSeriesStatus.DROPPED); // left exactly as-is
    expect(progress.nextEpisodeId).toBeNull();

    // Zero Season writes — the brand-new season 2 this plan asked for was
    // never created.
    const season2 = await prisma.season.findUnique({ where: { seriesId_seasonNumber: { seriesId: series.id, seasonNumber: 2 } } });
    expect(season2).toBeNull();

    // Zero Episode writes.
    const seasonCount = await prisma.season.count({ where: { seriesId: series.id } });
    expect(seasonCount).toBe(1); // only the original season1 fixture
    const episodeCount = await prisma.episode.count({ where: { season: { seriesId: series.id } } });
    expect(episodeCount).toBe(1); // only the original ep1 fixture
  });

  // Fix #3: a missing UserSeriesProgress row (e.g. removed from tracking
  // entirely between candidate selection and this transaction) must be
  // handled as cleanly as a protected-status race — no non-null assertion,
  // no thrown exception, zero writes, a specific reported reason.
  it('performs zero writes and reports a specific reason when no UserSeriesProgress row exists at all', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();
    await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    // Deliberately no userSeriesProgress.create call at all.

    const insertPlan: EpisodeInsertPlan = {
      episodesToInsert: [{ seasonNumber: 1, episodeNumber: 1, title: 'New Episode', overview: null, airDate: NEW_RELEASED, imageUrl: null, runtimeMinutes: null }],
      seasonNumbersToCreate: [],
    };

    await expect(applySeriesInsertPlan(prisma, { userId: user.id, seriesId: series.id, insertPlan })).resolves.not.toThrow();

    const result = await applySeriesInsertPlan(prisma, { userId: user.id, seriesId: series.id, insertPlan });
    expect(result.writeSkippedReason).toContain('no UserSeriesProgress row found');
    expect(result.episodesInserted).toBe(0);
    expect(result.seasonsCreated).toEqual([]);
    expect(result.progressRecomputed).toBe(false);

    const episodeCount = await prisma.episode.count({ where: { season: { seriesId: series.id } } });
    expect(episodeCount).toBe(0);
  });

  // Fix #4: seasonsCreated must reflect actual DB writes, not the
  // pre-transaction plan. A season the plan thought was missing but that
  // actually already exists at write time (a "safe re-run" shape) must
  // never be reported as newly created, and episodes must still land in
  // the correct, pre-existing season.
  it('does not report an already-existing season as newly created (safe re-run shape)', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    // Season 2 already exists — as if an earlier, partially-completed run
    // already created it, or a concurrent writer did.
    const season2 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 2 } });
    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: null } });

    // The plan still (incorrectly, per a stale snapshot) believes season 2
    // needs to be created.
    const insertPlan: EpisodeInsertPlan = {
      episodesToInsert: [
        { seasonNumber: 1, episodeNumber: 1, title: 'S1E1', overview: null, airDate: NEW_RELEASED, imageUrl: null, runtimeMinutes: null },
        { seasonNumber: 2, episodeNumber: 1, title: 'S2E1', overview: null, airDate: NEW_RELEASED, imageUrl: null, runtimeMinutes: null },
      ],
      seasonNumbersToCreate: [2],
    };

    const result = await applySeriesInsertPlan(prisma, { userId: user.id, seriesId: series.id, insertPlan });

    // Season 1 was never in seasonNumbersToCreate and season 2 already
    // existed live — nothing was actually created.
    expect(result.seasonsCreated).toEqual([]);
    expect(result.episodesInserted).toBe(2);

    const s1e1 = await prisma.episode.findUnique({ where: { seasonId_episodeNumber: { seasonId: season1.id, episodeNumber: 1 } } });
    const s2e1 = await prisma.episode.findUnique({ where: { seasonId_episodeNumber: { seasonId: season2.id, episodeNumber: 1 } } });
    expect(s1e1).not.toBeNull();
    expect(s2e1).not.toBeNull(); // correctly landed in the pre-existing season 2, not a duplicate

    const seasonCount = await prisma.season.count({ where: { seriesId: series.id } });
    expect(seasonCount).toBe(2); // no extra season row was created
  });

  it('correctly reports seasonsCreated only for the seasons genuinely created this call, alongside pre-existing ones', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: null } });

    const insertPlan: EpisodeInsertPlan = {
      episodesToInsert: [
        { seasonNumber: 1, episodeNumber: 1, title: 'S1E1', overview: null, airDate: NEW_RELEASED, imageUrl: null, runtimeMinutes: null },
        { seasonNumber: 2, episodeNumber: 1, title: 'S2E1', overview: null, airDate: NEW_RELEASED, imageUrl: null, runtimeMinutes: null },
        { seasonNumber: 3, episodeNumber: 1, title: 'S3E1', overview: null, airDate: NEW_RELEASED, imageUrl: null, runtimeMinutes: null },
      ],
      seasonNumbersToCreate: [2, 3],
    };

    const result = await applySeriesInsertPlan(prisma, { userId: user.id, seriesId: series.id, insertPlan });

    expect(result.seasonsCreated).toEqual([2, 3]);
    expect(result.episodesInserted).toBe(3);

    const seasons = await prisma.season.findMany({ where: { seriesId: series.id }, orderBy: { seasonNumber: 'asc' } });
    expect(seasons.map((s) => s.seasonNumber)).toEqual([1, 2, 3]);
    expect(seasons.find((s) => s.seasonNumber === 2)?.importBatchId).toBe(PHASE1_APPLY_IMPORT_BATCH_ID);
    expect(seasons.find((s) => s.seasonNumber === 1)?.importBatchId).toBeNull(); // pre-existing season untouched
    void season1;
  });
});
