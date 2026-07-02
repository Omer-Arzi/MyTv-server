import { UserSeriesStatus } from '@prisma/client';
import { runApplyPlan } from '../apply-plan';
import { ApplyPlanCandidate, TmdbApplyPlan } from '../apply-plan-types';

function candidate(overrides: Partial<ApplyPlanCandidate> = {}): ApplyPlanCandidate {
  return {
    mytvSeriesId: 'series-1',
    mytvSeriesTitle: '07-Ghost',
    realTier: 'NEEDS_REVIEW',
    proposedTierAfterStructuralRule: 'AUTO_MATCH',
    tmdbId: '21855',
    tmdbTitle: '07-Ghost',
    tmdbYear: 2009,
    watchedEpisodeCount: 25,
    tmdbTotalEpisodeCount: 25,
    animeNumberingRiskDetected: false,
    closeCompetitorDetected: false,
    closeCompetitorReason: null,
    currentUserStatus: 'WATCHING',
    proposedUserStatusAfterEnrichment: 'COMPLETED',
    proposedReleaseStatus: 'ENDED',
    ...overrides,
  };
}

function plan(overrides: Partial<TmdbApplyPlan> = {}): TmdbApplyPlan {
  return {
    sourceBatchId: 'batch-1',
    writesToAppTables: false,
    appliedAnything: false,
    summary: {
      seriesConsidered: 1,
      realAutoMatchCount: 0,
      structuralAutoMatchProposedCount: 1,
      candidateUnionCount: 1,
      safeApplyCandidateCount: 1,
      excludedFromCandidateUnionCount: 0,
      manualReviewCounts: {},
      dataQualityIssueCount: 0,
    },
    safeApplyCandidates: [candidate()],
    excludedFromCandidateUnion: [],
    manualReview: {
      duplicate_title_year_suffix_collision: [],
      remake_reboot_collision: [],
      placeholder_title: [],
      anime_numbering_risk: [],
      watched_gt_total: [],
      close_competitor: [],
      no_match: [],
    },
    dangerousExamples: [],
    ...overrides,
  };
}

const showPayload = {
  id: 21855,
  name: '07-Ghost',
  overview: 'A story about a boy.',
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  status: 'Ended',
  number_of_seasons: 1,
  number_of_episodes: 25,
};

const seasonsBatchPayload = {
  'season/1': {
    id: 1,
    season_number: 1,
    name: 'Season 1',
    episodes: [{ id: 100, episode_number: 1, name: 'Ep 1', overview: 'The first episode.', air_date: '2009-04-09', season_number: 1, still_path: '/ep1.jpg' }],
  },
};

// A minimal fake Prisma client — just the methods apply-plan.ts actually
// calls. importRawRow.findFirst returns pre-canned cache hits so no TMDb
// network call is ever needed for these tests (also doubles as proof the
// apply step reuses the dry run's cache rather than re-fetching).
function makeFakePrisma(overrides: { userStatus?: UserSeriesStatus | null; seriesExists?: boolean } = {}) {
  const write = {
    seriesUpdate: jest.fn(),
    externalIdsUpsert: jest.fn(),
    seasonUpsert: jest.fn().mockResolvedValue({ id: 'season-db-id' }),
    episodeUpsert: jest.fn(),
    userSeriesProgressUpsert: jest.fn(),
    importBatchCreate: jest.fn().mockResolvedValue({ id: 'apply-batch-1' }),
    importBatchUpdate: jest.fn(),
    importIssueCreateMany: jest.fn(),
    importRawRowCreate: jest.fn(),
  };

  const txClient = {
    series: {
      findUnique: jest.fn().mockResolvedValue({ rawMetadata: {} }),
      update: write.seriesUpdate,
    },
    externalIds: { upsert: write.externalIdsUpsert },
    season: { upsert: write.seasonUpsert },
    episode: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: write.episodeUpsert,
    },
    userSeriesProgress: { upsert: write.userSeriesProgressUpsert },
    importIssue: { createMany: write.importIssueCreateMany },
    importBatch: { update: write.importBatchUpdate },
  };

  const prisma = {
    importRawRow: {
      findFirst: jest.fn((args: { where: { sourceFile: string } }) => {
        if (args.where.sourceFile.startsWith('tmdb:show:')) return Promise.resolve({ payload: showPayload, createdAt: new Date() });
        if (args.where.sourceFile.startsWith('tmdb:seasons:')) return Promise.resolve({ payload: seasonsBatchPayload, createdAt: new Date() });
        return Promise.resolve(null);
      }),
      create: write.importRawRowCreate,
    },
    series: {
      findUnique: jest.fn().mockResolvedValue(overrides.seriesExists === false ? null : { title: '07-Ghost', rawMetadata: {} }),
    },
    userSeriesProgress: {
      findUnique: jest.fn().mockResolvedValue(overrides.userStatus === undefined ? { userStatus: UserSeriesStatus.WATCHING } : overrides.userStatus === null ? null : { userStatus: overrides.userStatus }),
    },
    importBatch: { create: write.importBatchCreate },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) => fn(txClient)),
  };

  return { prisma, write, txClient };
}

const fakeTmdb = {
  getShowDetails: jest.fn(),
  getSeasonsBatch: jest.fn(),
} as unknown as import('../tmdb-client').TmdbClient;

describe('runApplyPlan — dry-run (default) behavior', () => {
  it('never writes anything to the database (no-op dry-run)', async () => {
    const { prisma, write } = makeFakePrisma();
    const result = await runApplyPlan(prisma as never, fakeTmdb, plan(), { userId: 'user-1', apply: false });

    expect(result.applied).toBe(false);
    expect(result.candidatesWritten).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
    expect(write.importRawRowCreate).not.toHaveBeenCalled();
    expect(write.seriesUpdate).not.toHaveBeenCalled();
    expect(write.externalIdsUpsert).not.toHaveBeenCalled();
    expect(write.seasonUpsert).not.toHaveBeenCalled();
    expect(write.episodeUpsert).not.toHaveBeenCalled();
    expect(write.userSeriesProgressUpsert).not.toHaveBeenCalled();
  });

  it('never calls the live TMDb client when cached data is available', async () => {
    const { prisma } = makeFakePrisma();
    await runApplyPlan(prisma as never, fakeTmdb, plan(), { userId: 'user-1', apply: false });

    expect(fakeTmdb.getShowDetails).not.toHaveBeenCalled();
    expect(fakeTmdb.getSeasonsBatch).not.toHaveBeenCalled();
  });

  it('reports exactly what would be updated, including the computed release status and episode list', async () => {
    const { prisma } = makeFakePrisma();
    const result = await runApplyPlan(prisma as never, fakeTmdb, plan(), { userId: 'user-1', apply: false });

    expect(result.candidatesReady).toBe(1);
    const [planned] = result.candidatesPlanned;
    expect(planned.status).toBe('ready');
    expect(planned.series!.releaseStatus).toBe('ENDED');
    expect(planned.series!.overview).toBe('A story about a boy.');
    expect(planned.episodes).toHaveLength(1);
    expect(planned.userStatus!.shouldUpdate).toBe(true);
    expect(planned.userStatus!.proposedUserStatus).toBe('COMPLETED');
  });
});

describe('runApplyPlan — refuses candidates outside safety/plan bounds', () => {
  it('refuses to apply a series id not in the plan', async () => {
    const { prisma } = makeFakePrisma();
    await expect(
      runApplyPlan(prisma as never, fakeTmdb, plan(), { userId: 'user-1', apply: false, seriesIds: ['not-in-plan'] }),
    ).rejects.toThrow(/not in tmdb-apply-plan\.json/);
  });

  it('refuses to apply an unsafe candidate (e.g. closeCompetitorDetected) even in dry-run', async () => {
    const { prisma } = makeFakePrisma();
    const unsafePlan = plan({ safeApplyCandidates: [candidate({ closeCompetitorDetected: true })] });

    await expect(runApplyPlan(prisma as never, fakeTmdb, unsafePlan, { userId: 'user-1', apply: false })).rejects.toThrow(/closeCompetitorDetected/);
  });

  it('fails the whole run rather than applying the safe candidates when only one is unsafe', async () => {
    const { prisma, write } = makeFakePrisma();
    const mixedPlan = plan({
      safeApplyCandidates: [candidate({ mytvSeriesId: 'series-1' }), candidate({ mytvSeriesId: 'series-2', watchedEpisodeCount: 999, tmdbTotalEpisodeCount: 25 })],
    });

    await expect(runApplyPlan(prisma as never, fakeTmdb, mixedPlan, { userId: 'user-1', apply: true })).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(write.seriesUpdate).not.toHaveBeenCalled();
  });
});

describe('runApplyPlan — real apply (--apply)', () => {
  it('writes Series/ExternalIds/Season/Episode and updates userStatus inside one transaction', async () => {
    const { prisma, write } = makeFakePrisma({ userStatus: UserSeriesStatus.WATCHING });
    const result = await runApplyPlan(prisma as never, fakeTmdb, plan(), { userId: 'user-1', apply: true });

    expect(result.applied).toBe(true);
    expect(result.candidatesWritten).toBe(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(write.seriesUpdate).toHaveBeenCalledTimes(1);
    expect(write.externalIdsUpsert).toHaveBeenCalledTimes(1);
    expect(write.seasonUpsert).toHaveBeenCalledTimes(1);
    expect(write.episodeUpsert).toHaveBeenCalledTimes(1);
    expect(write.userSeriesProgressUpsert).toHaveBeenCalledTimes(1);

    const seriesUpdateArgs = write.seriesUpdate.mock.calls[0][0];
    expect(seriesUpdateArgs.data.releaseStatus).toBe('ENDED');

    const userStatusArgs = write.userSeriesProgressUpsert.mock.calls[0][0];
    expect(userStatusArgs.update.userStatus).toBe('COMPLETED');
  });

  it('preserves DROPPED and never calls userSeriesProgress.upsert, even though the plan proposes COMPLETED', async () => {
    const { prisma, write } = makeFakePrisma({ userStatus: UserSeriesStatus.DROPPED });
    await runApplyPlan(prisma as never, fakeTmdb, plan(), { userId: 'user-1', apply: true });

    expect(write.userSeriesProgressUpsert).not.toHaveBeenCalled();
    // Series/ExternalIds/Season/Episode metadata still gets applied — only
    // the personal userStatus is protected.
    expect(write.seriesUpdate).toHaveBeenCalledTimes(1);
  });

  it('preserves PAUSED', async () => {
    const { prisma, write } = makeFakePrisma({ userStatus: UserSeriesStatus.PAUSED });
    await runApplyPlan(prisma as never, fakeTmdb, plan(), { userId: 'user-1', apply: true });
    expect(write.userSeriesProgressUpsert).not.toHaveBeenCalled();
  });

  it('preserves WATCHLIST', async () => {
    const { prisma, write } = makeFakePrisma({ userStatus: UserSeriesStatus.WATCHLIST });
    await runApplyPlan(prisma as never, fakeTmdb, plan(), { userId: 'user-1', apply: true });
    expect(write.userSeriesProgressUpsert).not.toHaveBeenCalled();
  });

  it('does not update userStatus when already at the proposed status', async () => {
    const { prisma, write } = makeFakePrisma({ userStatus: UserSeriesStatus.COMPLETED });
    await runApplyPlan(prisma as never, fakeTmdb, plan(), { userId: 'user-1', apply: true });
    expect(write.userSeriesProgressUpsert).not.toHaveBeenCalled();
  });

  it('updates WATCHING -> CAUGHT_UP when the plan proposes it', async () => {
    const { prisma, write } = makeFakePrisma({ userStatus: UserSeriesStatus.WATCHING });
    const caughtUpPlan = plan({ safeApplyCandidates: [candidate({ proposedUserStatusAfterEnrichment: 'CAUGHT_UP', proposedReleaseStatus: 'RETURNING' })] });

    await runApplyPlan(prisma as never, fakeTmdb, caughtUpPlan, { userId: 'user-1', apply: true });

    expect(write.userSeriesProgressUpsert).toHaveBeenCalledTimes(1);
    expect(write.userSeriesProgressUpsert.mock.calls[0][0].update.userStatus).toBe('CAUGHT_UP');
  });
});
