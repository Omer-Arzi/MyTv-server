import { buildConfirmedSeriesApplyPlan, ConfirmedSeriesApplyPlan, isNoOpReapply, isSafeApplyClassification, resolvePreservedOrphanEpisodes, SAFE_APPLY_CLASSIFICATIONS } from '../apply-confirmed-provider-logic';
import { LocalEpisodeForApply, ProviderEpisodeForApply } from '../apply-friends-tvmaze-logic';
import { DryRunClassification } from '../provider-confirmation-decisions-logic';

describe('SAFE_APPLY_CLASSIFICATIONS / isSafeApplyClassification', () => {
  it('contains exactly the three classifications this task defines as safe to auto-apply', () => {
    expect([...SAFE_APPLY_CLASSIFICATIONS].sort()).toEqual(['SAFE_TO_APPLY_LATER', 'SAFE_WITH_LOCAL_SPECIAL_ORPHAN', 'SAFE_WITH_SPLIT_EPISODE_TAIL'].sort());
  });

  it.each(['SAFE_TO_APPLY_LATER', 'SAFE_WITH_LOCAL_SPECIAL_ORPHAN', 'SAFE_WITH_SPLIT_EPISODE_TAIL'] as DryRunClassification[])('%s is safe to auto-apply', (c) => {
    expect(isSafeApplyClassification(c)).toBe(true);
  });

  it.each(['BLOCKED_RISK', 'NEEDS_MANUAL_REVIEW', 'PROVIDER_NOT_FOUND', 'LOCAL_SERIES_NOT_FOUND'] as DryRunClassification[])('%s must never be auto-applied', (c) => {
    expect(isSafeApplyClassification(c)).toBe(false);
  });

  it('null (skip/defer/excluded — never classified) is never safe to auto-apply', () => {
    expect(isSafeApplyClassification(null)).toBe(false);
  });
});

describe('resolvePreservedOrphanEpisodes', () => {
  it('returns the season-0 orphans for SAFE_WITH_LOCAL_SPECIAL_ORPHAN', () => {
    const orphans = [{ id: 'x', seasonNumber: 0, episodeNumber: 6 }];
    const result = resolvePreservedOrphanEpisodes({ classification: 'SAFE_WITH_LOCAL_SPECIAL_ORPHAN', orphanSeasonZeroEpisodes: orphans, tailOrphanedEpisodes: null });
    expect(result).toBe(orphans);
  });

  it('returns the tail orphans for SAFE_WITH_SPLIT_EPISODE_TAIL', () => {
    const tail = [{ id: 'a', seasonNumber: 4, episodeNumber: 16 }];
    const result = resolvePreservedOrphanEpisodes({ classification: 'SAFE_WITH_SPLIT_EPISODE_TAIL', orphanSeasonZeroEpisodes: [], tailOrphanedEpisodes: tail });
    expect(result).toBe(tail);
  });

  it('returns an empty array for SAFE_TO_APPLY_LATER regardless of what is passed in', () => {
    const result = resolvePreservedOrphanEpisodes({
      classification: 'SAFE_TO_APPLY_LATER',
      orphanSeasonZeroEpisodes: [{ id: 'x', seasonNumber: 0, episodeNumber: 1 }],
      tailOrphanedEpisodes: [{ id: 'y', seasonNumber: 4, episodeNumber: 16 }],
    });
    expect(result).toEqual([]);
  });
});

describe('isNoOpReapply', () => {
  function noOpPlan(overrides: Partial<ConfirmedSeriesApplyPlan> = {}): ConfirmedSeriesApplyPlan {
    return {
      seriesId: 's1',
      title: 'Friends',
      provider: 'tvmaze',
      providerId: '431',
      externalIdsUpdate: { seriesId: 's1', provider: 'tvmaze', providerId: '431', tmdbId: undefined },
      posterUpdate: null,
      episodeUpdates: [],
      episodeUpdateCount: 0,
      preservedOrphanEpisodes: [],
      progressUpdate: { userId: 'u1', seriesId: 's1', userStatus: 'COMPLETED', nextEpisodeId: null, lastWatchedAtUnchanged: true },
      ...overrides,
    };
  }

  it('is a no-op re-apply when the provider already matches and the plan writes nothing new — the fix for repeat-run reporting', () => {
    const result = isNoOpReapply({ alreadyMatchedProvider: true, plan: noOpPlan(), wouldChangeProgress: false });
    expect(result).toBe(true);
  });

  it('is NOT a no-op when the provider is not already matched (first-time apply)', () => {
    const result = isNoOpReapply({ alreadyMatchedProvider: false, plan: noOpPlan(), wouldChangeProgress: false });
    expect(result).toBe(false);
  });

  it('is NOT a no-op when there are real episode updates pending, even if already matched', () => {
    const plan = noOpPlan({ episodeUpdateCount: 3 });
    expect(isNoOpReapply({ alreadyMatchedProvider: true, plan, wouldChangeProgress: false })).toBe(false);
  });

  it('is NOT a no-op when a poster update is pending, even if already matched', () => {
    const plan = noOpPlan({ posterUpdate: { from: null, to: 'https://example.com/poster.jpg', wouldChange: true } });
    expect(isNoOpReapply({ alreadyMatchedProvider: true, plan, wouldChangeProgress: false })).toBe(false);
  });

  it('is NOT a no-op when userStatus/nextEpisodeId would change, even if already matched and no episode/poster changes', () => {
    expect(isNoOpReapply({ alreadyMatchedProvider: true, plan: noOpPlan(), wouldChangeProgress: true })).toBe(false);
  });
});

describe('buildConfirmedSeriesApplyPlan', () => {
  const localEpisodes: LocalEpisodeForApply[] = [
    { id: 'ep-1', seasonNumber: 1, episodeNumber: 1, title: null, overview: null, airDate: null, runtimeMinutes: null },
    // A tail orphan the plan must never touch — no provider counterpart at all.
    { id: 'ep-2', seasonNumber: 1, episodeNumber: 2, title: null, overview: null, airDate: null, runtimeMinutes: null },
  ];
  const providerEpisodes: ProviderEpisodeForApply[] = [
    { seasonNumber: 1, episodeNumber: 1, title: 'Pilot', overviewHtml: '<p>It begins.</p>', airDate: '2020-01-01', runtimeMinutes: 30 },
  ];

  it('builds ExternalIds, poster, matched-episode, and progress updates', () => {
    const plan = buildConfirmedSeriesApplyPlan({
      seriesId: 'series-1',
      title: 'Some Show',
      provider: 'tmdb',
      providerId: '999',
      userId: 'user-1',
      currentPosterUrl: null,
      providerPosterUrl: 'https://example.com/poster.jpg',
      localEpisodes,
      providerEpisodes,
      preservedOrphanEpisodes: [{ id: 'ep-2', seasonNumber: 1, episodeNumber: 2 }],
      proposedUserStatus: 'WATCHING',
      proposedNextEpisodeId: null,
    });

    expect(plan.externalIdsUpdate).toEqual({ seriesId: 'series-1', provider: 'tmdb', providerId: '999', tmdbId: '999' });
    expect(plan.posterUpdate).toEqual({ from: null, to: 'https://example.com/poster.jpg', wouldChange: true });
    expect(plan.episodeUpdateCount).toBe(1);
    expect(plan.episodeUpdates[0].episodeId).toBe('ep-1');
    expect(plan.preservedOrphanEpisodes).toEqual([{ id: 'ep-2', seasonNumber: 1, episodeNumber: 2 }]);
    expect(plan.progressUpdate).toEqual({ userId: 'user-1', seriesId: 'series-1', userStatus: 'WATCHING', nextEpisodeId: null, lastWatchedAtUnchanged: true });
  });

  it('never includes a preserved orphan episode id among episodeUpdates', () => {
    const plan = buildConfirmedSeriesApplyPlan({
      seriesId: 'series-1',
      title: 'Some Show',
      provider: 'tmdb',
      providerId: '999',
      userId: 'user-1',
      currentPosterUrl: 'https://existing.example.com/poster.jpg',
      providerPosterUrl: 'https://example.com/poster.jpg',
      localEpisodes,
      providerEpisodes,
      preservedOrphanEpisodes: [{ id: 'ep-2', seasonNumber: 1, episodeNumber: 2 }],
      proposedUserStatus: 'WATCHING',
      proposedNextEpisodeId: null,
    });

    const updatedIds = plan.episodeUpdates.map((u) => u.episodeId);
    expect(updatedIds).not.toContain('ep-2');
    expect(plan.posterUpdate).toBeNull(); // existing poster preserved, not overwritten
  });

  it('the plan shape has no delete-capable field — only additive/update-only keys', () => {
    const plan = buildConfirmedSeriesApplyPlan({
      seriesId: 'series-1',
      title: 'Some Show',
      provider: 'tvmaze',
      providerId: '1',
      userId: 'user-1',
      currentPosterUrl: null,
      providerPosterUrl: null,
      localEpisodes: [],
      providerEpisodes: [],
      preservedOrphanEpisodes: [],
      proposedUserStatus: 'COMPLETED',
      proposedNextEpisodeId: null,
    });
    expect(Object.keys(plan).sort()).toEqual(
      ['seriesId', 'title', 'provider', 'providerId', 'externalIdsUpdate', 'posterUpdate', 'episodeUpdates', 'episodeUpdateCount', 'preservedOrphanEpisodes', 'progressUpdate'].sort(),
    );
  });

  it('sets externalIdsUpdate.tmdbId to the providerId for a tmdb match — the dedicated column health-logic.ts/episode-release-refresh/the app DTO actually read', () => {
    const plan = buildConfirmedSeriesApplyPlan({
      seriesId: 'series-1', title: 'Some Show', provider: 'tmdb', providerId: '71728', userId: 'user-1',
      currentPosterUrl: null, providerPosterUrl: null, localEpisodes: [], providerEpisodes: [],
      preservedOrphanEpisodes: [], proposedUserStatus: 'WATCHING', proposedNextEpisodeId: null,
    });
    expect(plan.externalIdsUpdate.tmdbId).toBe('71728');
  });

  it('leaves externalIdsUpdate.tmdbId undefined for a tvmaze match — no dedicated column exists to write into', () => {
    const plan = buildConfirmedSeriesApplyPlan({
      seriesId: 'series-1', title: 'Some Show', provider: 'tvmaze', providerId: '431', userId: 'user-1',
      currentPosterUrl: null, providerPosterUrl: null, localEpisodes: [], providerEpisodes: [],
      preservedOrphanEpisodes: [], proposedUserStatus: 'WATCHING', proposedNextEpisodeId: null,
    });
    expect(plan.externalIdsUpdate.tmdbId).toBeUndefined();
  });
});
