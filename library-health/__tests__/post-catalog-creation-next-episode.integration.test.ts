// Integration test proving the Castlevania-bug fix's id-resolution
// mechanism actually works against a real Postgres database: after
// createMissingSeasonsAndEpisodes creates a brand-new, unwatched, released
// season, the same tx.episode.findFirst lookup run-provider-confirmation-pipeline.ts
// uses to resolve the real nextEpisodeId for a proposed-next episode that
// didn't exist yet at classification time correctly finds the newly
// created row — proving the mechanism (not just the pure decision
// function, already covered by migration-policy-logic.test.ts) is sound.
//
// Mirrors catalog-reconciliation-transaction.integration.test.ts's exact
// convention: does not import from run-provider-confirmation-pipeline.ts
// (it has main() at module scope), instead replicates the specific
// sequence being tested against a real, throwaway fixture.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient, ReleaseStatus, Series, User, UserSeriesStatus } from '@prisma/client';
import { createMissingSeasonsAndEpisodes } from '../../episode-release-refresh/season-episode-writer';
import { EpisodeInsertPlan } from '../../episode-release-refresh/build-episode-insert-plan';
import { CATALOG_RECONCILIATION_IMPORT_BATCH_ID } from '../migration-catalog-plan-logic';
import { shouldForceWatchingForPendingNextEpisode } from '../migration-policy-logic';

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;
const PAST = new Date('2020-01-01');

describeIfDbConfigured('post-catalog-creation next-episode resolution (integration, real Postgres)', () => {
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
    const user = await prisma.user.create({ data: { email: `next-episode-fix-test-${randomUUID()}@example.com`, displayName: 'Next Episode Fix Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeries(): Promise<Series> {
    const series = await prisma.series.create({ data: { title: `Next Episode Fix Test Series ${randomUUID()}`, releaseStatus: ReleaseStatus.RETURNING } });
    createdSeriesIds.push(series.id);
    return series;
  }

  it('resolves the real newly-created episode id as nextEpisodeId, exactly reproducing the Castlevania scenario (12 watched in S1-2, 20 new unwatched released in S3-4, currently WATCHING)', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();
    const season1 = await prisma.season.create({ data: { seriesId: series.id, seasonNumber: 1 } });
    const watchedEpisodes = await Promise.all(
      Array.from({ length: 12 }, (_, i) => i + 1).map((n) => prisma.episode.create({ data: { seasonId: season1.id, episodeNumber: n, airDate: PAST } })),
    );
    for (const ep of watchedEpisodes) {
      await prisma.episodeWatch.create({ data: { userId: user.id, episodeId: ep.id, watchedAt: PAST } });
    }
    await prisma.userSeriesProgress.create({ data: { userId: user.id, seriesId: series.id, userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: null } });

    // 20 new released episodes across seasons 3-4 — mirrors Castlevania's
    // real Batch 2 shape exactly (seasonsToCreate: [3,4], episodesToCreate: 20).
    const insertPlan: EpisodeInsertPlan = {
      episodesToInsert: [
        ...Array.from({ length: 10 }, (_, i) => ({ seasonNumber: 3, episodeNumber: i + 1, title: `S3E${i + 1}`, overview: null, airDate: PAST, imageUrl: null, runtimeMinutes: 24 })),
        ...Array.from({ length: 10 }, (_, i) => ({ seasonNumber: 4, episodeNumber: i + 1, title: `S4E${i + 1}`, overview: null, airDate: PAST, imageUrl: null, runtimeMinutes: 24 })),
      ],
      seasonNumbersToCreate: [3, 4],
    };

    // Pre-transaction: this is what comparison.proposedNext* would report —
    // the first unwatched released slot across the merged (local + new)
    // catalog is S3E1, and it doesn't exist locally yet (isNew: true).
    const hasProposedNextEpisode = true;
    const proposedNextIsNew = true;
    const proposedNextSeasonNumber = 3;
    const proposedNextEpisodeNumber = 1;

    const shouldCorrect = shouldForceWatchingForPendingNextEpisode({
      hasProposedNextEpisode,
      liveUserStatus: UserSeriesStatus.WATCHING,
      explicitStatusOverrideGiven: false,
    });
    expect(shouldCorrect).toBe(true);

    let finalStatus: UserSeriesStatus = UserSeriesStatus.WATCHING;
    let finalNextEpisodeId: string | null = null;

    await prisma.$transaction(async (tx) => {
      await createMissingSeasonsAndEpisodes(tx, { seriesId: series.id, insertPlan, importBatchId: CATALOG_RECONCILIATION_IMPORT_BATCH_ID });

      // The exact lookup run-provider-confirmation-pipeline.ts performs
      // once shouldForceWatchingForPendingNextEpisode says yes and the
      // proposed next is a brand-new episode.
      if (proposedNextIsNew) {
        const createdNext = await tx.episode.findFirst({
          where: { season: { seriesId: series.id, seasonNumber: proposedNextSeasonNumber }, episodeNumber: proposedNextEpisodeNumber },
          select: { id: true },
        });
        finalNextEpisodeId = createdNext?.id ?? null;
      }

      await tx.userSeriesProgress.update({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } }, data: { userStatus: finalStatus, nextEpisodeId: finalNextEpisodeId } });
    });

    expect(finalStatus).toBe(UserSeriesStatus.WATCHING);
    expect(finalNextEpisodeId).not.toBeNull();

    // Verify the resolved id really is S3E1 — not some other episode.
    const resolvedEpisode = await prisma.episode.findUniqueOrThrow({ where: { id: finalNextEpisodeId! } });
    const resolvedSeason = await prisma.season.findUniqueOrThrow({ where: { id: resolvedEpisode.seasonId } });
    expect(resolvedSeason.seasonNumber).toBe(3);
    expect(resolvedEpisode.episodeNumber).toBe(1);
    expect(resolvedEpisode.importBatchId).toBe(CATALOG_RECONCILIATION_IMPORT_BATCH_ID);

    const progress = await prisma.userSeriesProgress.findUniqueOrThrow({ where: { userId_seriesId: { userId: user.id, seriesId: series.id } } });
    expect(progress.userStatus).toBe(UserSeriesStatus.WATCHING);
    expect(progress.nextEpisodeId).toBe(finalNextEpisodeId);
  });
});
