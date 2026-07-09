import {
  buildFriendsApplyPlan,
  FRIENDS_TARGET,
  LocalEpisodeForApply,
  planEpisodeUpdate,
  planEpisodeUpdates,
  planPosterUpdate,
  ProviderEpisodeForApply,
  stripHtml,
  validateFriendsTvmazeApply,
} from '../apply-friends-tvmaze-logic';

function validGuardInput() {
  return {
    localTitle: FRIENDS_TARGET.title,
    provider: FRIENDS_TARGET.provider as string,
    providerId: FRIENDS_TARGET.providerId,
    dryRunClassification: 'SAFE_TO_APPLY_LATER',
    localSeasonCount: FRIENDS_TARGET.seasonCount,
    providerSeasonCount: FRIENDS_TARGET.seasonCount,
    localEpisodeCount: FRIENDS_TARGET.episodeCount,
    providerEpisodeCount: FRIENDS_TARGET.episodeCount,
    orphanedWatchedEpisodeCount: 0,
  };
}

describe('validateFriendsTvmazeApply', () => {
  it('allows the exact expected Friends/TVmaze-431 case', () => {
    const result = validateFriendsTvmazeApply(validGuardInput());
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('refuses a wrong local title', () => {
    const result = validateFriendsTvmazeApply({ ...validGuardInput(), localTitle: 'Seinfeld' });
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.includes('local title'))).toBe(true);
  });

  it('refuses a wrong provider', () => {
    const result = validateFriendsTvmazeApply({ ...validGuardInput(), provider: 'tmdb' });
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.includes('provider must be'))).toBe(true);
  });

  it('refuses a wrong providerId', () => {
    const result = validateFriendsTvmazeApply({ ...validGuardInput(), providerId: '46948' }); // the unrelated 1979 "Friends"
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.includes('providerId'))).toBe(true);
  });

  it('refuses when the dry-run classification is not SAFE_TO_APPLY_LATER', () => {
    const result = validateFriendsTvmazeApply({ ...validGuardInput(), dryRunClassification: 'SAFE_WITH_LOCAL_SPECIAL_ORPHAN' });
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.includes('SAFE_TO_APPLY_LATER'))).toBe(true);
  });

  it('refuses a season count mismatch on either side', () => {
    expect(validateFriendsTvmazeApply({ ...validGuardInput(), localSeasonCount: 9 }).allowed).toBe(false);
    expect(validateFriendsTvmazeApply({ ...validGuardInput(), providerSeasonCount: 11 }).allowed).toBe(false);
  });

  it('refuses an episode count mismatch on either side', () => {
    expect(validateFriendsTvmazeApply({ ...validGuardInput(), localEpisodeCount: 235 }).allowed).toBe(false);
    expect(validateFriendsTvmazeApply({ ...validGuardInput(), providerEpisodeCount: 237 }).allowed).toBe(false);
  });

  it('refuses any non-zero orphaned watched episode count', () => {
    const result = validateFriendsTvmazeApply({ ...validGuardInput(), orphanedWatchedEpisodeCount: 1 });
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.includes('orphaned'))).toBe(true);
  });

  it('refuses a known risk-listed title even if it happened to be named "Friends" hypothetically', () => {
    // Sanity: this exercises the risk-list gate itself, independent of the
    // title-equality gate above (both would fire together for a real
    // mismatch, but this confirms the risk-list check runs at all).
    const result = validateFriendsTvmazeApply({ ...validGuardInput(), localTitle: 'Jujutsu Kaisen' });
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.includes('risk list'))).toBe(true);
  });

  it('accumulates multiple violations at once rather than stopping at the first', () => {
    const result = validateFriendsTvmazeApply({ ...validGuardInput(), localTitle: 'Seinfeld', provider: 'tmdb', orphanedWatchedEpisodeCount: 2 });
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });
});

describe('stripHtml', () => {
  it('strips tags and decodes common entities', () => {
    expect(stripHtml('<p>Ross &amp; Rachel finally get together.</p>')).toBe('Ross & Rachel finally get together.');
  });

  it('returns null for null input', () => {
    expect(stripHtml(null)).toBeNull();
  });

  it('returns null for a tag-only/empty string', () => {
    expect(stripHtml('<p></p>')).toBeNull();
  });
});

describe('planEpisodeUpdate / planEpisodeUpdates', () => {
  const localBase: LocalEpisodeForApply = { id: 'ep-1', seasonNumber: 1, episodeNumber: 1, title: null, overview: null, airDate: null, runtimeMinutes: null };
  const providerBase: ProviderEpisodeForApply = { seasonNumber: 1, episodeNumber: 1, title: 'The Pilot', overviewHtml: '<p>Ross moves in.</p>', airDate: '1994-09-22', runtimeMinutes: 22 };

  it('backfills every field when local has nothing and provider has real data', () => {
    const result = planEpisodeUpdate(localBase, providerBase);
    expect(result.changes).toEqual({ title: 'The Pilot', overview: 'Ross moves in.', airDate: '1994-09-22', runtimeMinutes: 22 });
  });

  it('never overwrites an existing local value with a provider null', () => {
    const local: LocalEpisodeForApply = { ...localBase, title: 'Existing Title', overview: 'Existing overview', airDate: '1994-09-22', runtimeMinutes: 22 };
    const provider: ProviderEpisodeForApply = { ...providerBase, title: null, overviewHtml: null, airDate: null, runtimeMinutes: null };
    const result = planEpisodeUpdate(local, provider);
    expect(result.changes).toEqual({});
  });

  it('produces no changes when local already matches provider exactly', () => {
    const local: LocalEpisodeForApply = { ...localBase, title: 'The Pilot', overview: 'Ross moves in.', airDate: '1994-09-22', runtimeMinutes: 22 };
    const result = planEpisodeUpdate(local, providerBase);
    expect(result.changes).toEqual({});
  });

  it('only updates the fields that actually differ', () => {
    const local: LocalEpisodeForApply = { ...localBase, title: 'The Pilot', overview: null, airDate: '1994-09-22', runtimeMinutes: null };
    const result = planEpisodeUpdate(local, providerBase);
    expect(result.changes).toEqual({ overview: 'Ross moves in.', runtimeMinutes: 22 });
  });

  it('never touches imageUrl — not present in EpisodeFieldChanges at all', () => {
    const result = planEpisodeUpdate(localBase, providerBase);
    expect(result.changes).not.toHaveProperty('imageUrl');
  });

  it('planEpisodeUpdates skips a local episode with no provider counterpart rather than guessing', () => {
    const results = planEpisodeUpdates([localBase, { ...localBase, id: 'ep-2', seasonNumber: 99, episodeNumber: 1 }], [providerBase]);
    expect(results).toHaveLength(1);
    expect(results[0].episodeId).toBe('ep-1');
  });
});

describe('planPosterUpdate', () => {
  it('proposes setting the poster when local has none and provider has one', () => {
    const result = planPosterUpdate(null, 'https://static.tvmaze.com/poster.jpg');
    expect(result).toEqual({ from: null, to: 'https://static.tvmaze.com/poster.jpg', wouldChange: true });
  });

  it('never overwrites an existing local poster', () => {
    expect(planPosterUpdate('https://existing.example.com/poster.jpg', 'https://static.tvmaze.com/poster.jpg')).toBeNull();
  });

  it('returns null when the provider has no poster either', () => {
    expect(planPosterUpdate(null, null)).toBeNull();
  });
});

describe('buildFriendsApplyPlan', () => {
  it('assembles a full plan with the expected shape', () => {
    const plan = buildFriendsApplyPlan({
      userId: 'user-1',
      seriesId: 'series-1',
      currentPosterUrl: null,
      providerPosterUrl: 'https://static.tvmaze.com/poster.jpg',
      localEpisodes: [{ id: 'ep-1', seasonNumber: 1, episodeNumber: 1, title: null, overview: null, airDate: null, runtimeMinutes: null }],
      providerEpisodes: [{ seasonNumber: 1, episodeNumber: 1, title: 'The Pilot', overviewHtml: '<p>Ross moves in.</p>', airDate: '1994-09-22', runtimeMinutes: 22 }],
      proposedUserStatus: 'COMPLETED',
      proposedNextEpisodeId: null,
    });

    expect(plan.externalIdsUpdate).toEqual({ seriesId: 'series-1', provider: 'tvmaze', providerId: '431' });
    expect(plan.posterUpdate).toEqual({ from: null, to: 'https://static.tvmaze.com/poster.jpg', wouldChange: true });
    expect(plan.episodeUpdateCount).toBe(1);
    expect(plan.episodeUpdates[0].changes).toEqual({ title: 'The Pilot', overview: 'Ross moves in.', airDate: '1994-09-22', runtimeMinutes: 22 });
    expect(plan.progressUpdate).toEqual({ userId: 'user-1', seriesId: 'series-1', userStatus: 'COMPLETED', nextEpisodeId: null, lastWatchedAtUnchanged: true });
  });

  it('excludes episodes with zero actual field changes from episodeUpdates', () => {
    const plan = buildFriendsApplyPlan({
      userId: 'user-1',
      seriesId: 'series-1',
      currentPosterUrl: 'https://existing.example.com/poster.jpg',
      providerPosterUrl: 'https://static.tvmaze.com/poster.jpg',
      localEpisodes: [{ id: 'ep-1', seasonNumber: 1, episodeNumber: 1, title: 'Same', overview: 'Same overview', airDate: '2020-01-01', runtimeMinutes: 30 }],
      providerEpisodes: [{ seasonNumber: 1, episodeNumber: 1, title: 'Same', overviewHtml: 'Same overview', airDate: '2020-01-01', runtimeMinutes: 30 }],
      proposedUserStatus: 'COMPLETED',
      proposedNextEpisodeId: null,
    });

    expect(plan.episodeUpdateCount).toBe(0);
    expect(plan.episodeUpdates).toEqual([]);
    expect(plan.posterUpdate).toBeNull(); // existing poster preserved
  });

  it('never deletes anything — the plan shape has no delete-capable field at all', () => {
    const plan = buildFriendsApplyPlan({
      userId: 'user-1',
      seriesId: 'series-1',
      currentPosterUrl: null,
      providerPosterUrl: null,
      localEpisodes: [],
      providerEpisodes: [],
      proposedUserStatus: 'COMPLETED',
      proposedNextEpisodeId: null,
    });
    // Structural assertion: every key on the plan is additive/update-only.
    expect(Object.keys(plan).sort()).toEqual(['episodeUpdateCount', 'episodeUpdates', 'externalIdsUpdate', 'posterUpdate', 'progressUpdate', 'seriesId'].sort());
  });
});
