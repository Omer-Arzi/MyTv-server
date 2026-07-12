import { buildMigrationCatalogInsertPlan, computeMatchedEpisodeCounts } from '../migration-catalog-plan-logic';
import { NewEpisodeFound, ProviderEpisodeInput } from '../../episode-release-refresh/refresh-logic';

const PAST = new Date('2020-01-01');

function newEp(seasonNumber: number, episodeNumber: number, released = true): NewEpisodeFound {
  return { seasonNumber, episodeNumber, title: null, airDate: PAST, released };
}

function providerEp(seasonNumber: number, episodeNumber: number): ProviderEpisodeInput {
  return { seasonNumber, episodeNumber, title: null, overview: null, airDate: PAST, imageUrl: null, runtimeMinutes: null };
}

describe('buildMigrationCatalogInsertPlan', () => {
  it('plans missing released episodes with no classification gate at all — unlike Phase 1, works regardless of volume', () => {
    // A House-shaped gap: 90 missing episodes across 4 new seasons — this
    // would be SUSPICIOUS_BULK_INSERT-blocked in episode-release-refresh,
    // but Pipeline A's whole purpose is exactly this kind of catalog
    // completion once identity is confirmed.
    const newEpisodes = Array.from({ length: 90 }, (_, i) => newEp(5 + Math.floor(i / 25), 1 + (i % 25)));
    const providerEpisodes = newEpisodes.map((e) => providerEp(e.seasonNumber, e.episodeNumber));
    const plan = buildMigrationCatalogInsertPlan({ newEpisodes, providerEpisodes, localSeasonNumbers: [1, 2, 3, 4] });
    expect(plan.episodesToInsert).toHaveLength(90);
    expect(plan.seasonNumbersToCreate.length).toBeGreaterThan(0);
  });

  it('excludes future (unreleased) episodes, same as Phase 1', () => {
    const newEpisodes = [newEp(1, 1, true), newEp(1, 2, false)];
    const providerEpisodes = [providerEp(1, 1), providerEp(1, 2)];
    const plan = buildMigrationCatalogInsertPlan({ newEpisodes, providerEpisodes, localSeasonNumbers: [1] });
    expect(plan.episodesToInsert).toHaveLength(1);
    expect(plan.episodesToInsert[0].episodeNumber).toBe(1);
  });

  it('includes season 0 episodes without exclusion — a deliberate divergence from Phase 1s SEASON_ZERO_PROPOSED coverage-gap block', () => {
    const newEpisodes = [newEp(0, 1, true)];
    const providerEpisodes = [providerEp(0, 1)];
    const plan = buildMigrationCatalogInsertPlan({ newEpisodes, providerEpisodes, localSeasonNumbers: [0, 1] });
    expect(plan.episodesToInsert).toHaveLength(1);
    expect(plan.episodesToInsert[0].seasonNumber).toBe(0);
  });
});

describe('computeMatchedEpisodeCounts', () => {
  it('counts only local episodes that have a provider counterpart, ignoring orphans entirely', () => {
    const local = [
      { seasonNumber: 1, episodeNumber: 1, watched: true },
      { seasonNumber: 1, episodeNumber: 2, watched: false },
      { seasonNumber: 9, episodeNumber: 999, watched: true }, // orphan — no provider match
    ];
    const provider = [{ seasonNumber: 1, episodeNumber: 1 }, { seasonNumber: 1, episodeNumber: 2 }];
    const result = computeMatchedEpisodeCounts(local, provider);
    expect(result.matchedTotalCount).toBe(2);
    expect(result.matchedWatchedCount).toBe(1);
  });

  it('returns zero/zero when nothing matches at all', () => {
    const result = computeMatchedEpisodeCounts([{ seasonNumber: 1, episodeNumber: 1, watched: true }], [{ seasonNumber: 2, episodeNumber: 1 }]);
    expect(result).toEqual({ matchedWatchedCount: 0, matchedTotalCount: 0 });
  });

  it('reflects full coverage when every local episode is matched and watched', () => {
    const local = Array.from({ length: 24 }, (_, i) => ({ seasonNumber: 1, episodeNumber: i + 1, watched: true }));
    const provider = local.map((e) => ({ seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber }));
    const result = computeMatchedEpisodeCounts(local, provider);
    expect(result).toEqual({ matchedWatchedCount: 24, matchedTotalCount: 24 });
  });

  // Season 0 (Specials) never participates in derived progress — an
  // unwatched Special must never keep resolveObjectiveMigrationStatus
  // (migration-policy-logic.ts) from deriving COMPLETED/CAUGHT_UP for a
  // Migration Workbench proposal.
  it('excludes Season 0 from both matchedTotalCount and matchedWatchedCount, even when matched and watched', () => {
    const local = [
      { seasonNumber: 1, episodeNumber: 1, watched: true },
      { seasonNumber: 1, episodeNumber: 2, watched: true },
      { seasonNumber: 0, episodeNumber: 1, watched: true },
    ];
    const provider = [
      { seasonNumber: 1, episodeNumber: 1 },
      { seasonNumber: 1, episodeNumber: 2 },
      { seasonNumber: 0, episodeNumber: 1 },
    ];
    const result = computeMatchedEpisodeCounts(local, provider);
    expect(result).toEqual({ matchedWatchedCount: 2, matchedTotalCount: 2 });
  });

  it('reflects "full coverage" (100% watched) when only an unwatched Season 0 Special remains, all canonical episodes watched', () => {
    const local = [
      { seasonNumber: 1, episodeNumber: 1, watched: true },
      { seasonNumber: 1, episodeNumber: 2, watched: true },
      { seasonNumber: 0, episodeNumber: 1, watched: false },
      { seasonNumber: 0, episodeNumber: 2, watched: false },
    ];
    const provider = [
      { seasonNumber: 1, episodeNumber: 1 },
      { seasonNumber: 1, episodeNumber: 2 },
      { seasonNumber: 0, episodeNumber: 1 },
      { seasonNumber: 0, episodeNumber: 2 },
    ];
    const result = computeMatchedEpisodeCounts(local, provider);
    // matchedWatchedCount === matchedTotalCount -> resolveObjectiveMigrationStatus
    // derives COMPLETED/CAUGHT_UP, unblocked by the 2 unwatched Specials.
    expect(result).toEqual({ matchedWatchedCount: 2, matchedTotalCount: 2 });
  });
});
