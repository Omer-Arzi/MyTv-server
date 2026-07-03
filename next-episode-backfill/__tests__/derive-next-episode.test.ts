import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { DeriveNextEpisodeInput, deriveNextEpisodeUpdate } from '../derive-next-episode';

function input(overrides: Partial<DeriveNextEpisodeInput> = {}): DeriveNextEpisodeInput {
  return {
    currentUserStatus: UserSeriesStatus.WATCHING,
    releaseStatus: ReleaseStatus.RETURNING,
    hasFullCatalog: true,
    orderedEpisodes: [{ id: 'ep-1' }, { id: 'ep-2' }, { id: 'ep-3' }],
    watchedEpisodeIds: new Set(['ep-1']),
    ...overrides,
  };
}

describe('deriveNextEpisodeUpdate — skipped statuses', () => {
  it.each([UserSeriesStatus.DROPPED, UserSeriesStatus.PAUSED, UserSeriesStatus.WATCHLIST, UserSeriesStatus.COMPLETED, UserSeriesStatus.UNKNOWN])(
    'skips %s unconditionally, even with a full catalog and an unwatched episode available',
    (status) => {
      const decision = deriveNextEpisodeUpdate(input({ currentUserStatus: status }));
      expect(decision.action).toBe('skip');
      expect(decision.nextEpisodeId).toBeNull();
      expect(decision.newUserStatus).toBeNull();
    },
  );

  it('never overrides DROPPED even when every episode is watched (would otherwise look "completed")', () => {
    const decision = deriveNextEpisodeUpdate(
      input({ currentUserStatus: UserSeriesStatus.DROPPED, watchedEpisodeIds: new Set(['ep-1', 'ep-2', 'ep-3']) }),
    );
    expect(decision.action).toBe('skip');
  });

  it('never overrides PAUSED', () => {
    const decision = deriveNextEpisodeUpdate(input({ currentUserStatus: UserSeriesStatus.PAUSED }));
    expect(decision.action).toBe('skip');
  });

  it('never overrides WATCHLIST', () => {
    const decision = deriveNextEpisodeUpdate(input({ currentUserStatus: UserSeriesStatus.WATCHLIST }));
    expect(decision.action).toBe('skip');
  });
});

describe('deriveNextEpisodeUpdate — incomplete catalog', () => {
  it('leaves a WATCHING row unchanged when no full catalog is known, even if MyTv has no unwatched episodes recorded', () => {
    const decision = deriveNextEpisodeUpdate(
      input({ hasFullCatalog: false, watchedEpisodeIds: new Set(['ep-1', 'ep-2', 'ep-3']) }),
    );
    expect(decision.action).toBe('unchanged-incomplete-catalog');
    expect(decision.nextEpisodeId).toBeNull();
    expect(decision.newUserStatus).toBeNull();
  });

  it('leaves a CAUGHT_UP row unchanged when no full catalog is known', () => {
    const decision = deriveNextEpisodeUpdate(input({ currentUserStatus: UserSeriesStatus.CAUGHT_UP, hasFullCatalog: false }));
    expect(decision.action).toBe('unchanged-incomplete-catalog');
  });

  it('does not guess a status transition just because MyTv is out of known episodes', () => {
    // The trap this guards against: MyTv's own (incomplete) episode list
    // has nothing left unwatched, which looks identical to "caught up" if
    // you don't know the catalog is incomplete.
    const decision = deriveNextEpisodeUpdate(input({ hasFullCatalog: false, orderedEpisodes: [{ id: 'ep-1' }], watchedEpisodeIds: new Set(['ep-1']) }));
    expect(decision.action).toBe('unchanged-incomplete-catalog');
    expect(decision.newUserStatus).toBeNull();
  });
});

describe('deriveNextEpisodeUpdate — WATCHING, full catalog, next episode found', () => {
  it('finds the next unwatched episode by seasonNumber/episodeNumber order', () => {
    const decision = deriveNextEpisodeUpdate(input());
    expect(decision.action).toBe('set-next-episode');
    expect(decision.nextEpisodeId).toBe('ep-2');
    expect(decision.newUserStatus).toBeNull(); // stays WATCHING implicitly
  });

  it('finds the first unwatched episode even with a gap earlier in the watched set', () => {
    // Watched ep-1 and ep-3 but not ep-2 — the correct "next" is ep-2, not
    // "whatever comes after the highest-numbered watched episode."
    const decision = deriveNextEpisodeUpdate(input({ watchedEpisodeIds: new Set(['ep-1', 'ep-3']) }));
    expect(decision.nextEpisodeId).toBe('ep-2');
  });

  it('finds episode 1 when nothing has been watched yet', () => {
    const decision = deriveNextEpisodeUpdate(input({ watchedEpisodeIds: new Set() }));
    expect(decision.nextEpisodeId).toBe('ep-1');
  });
});

describe('deriveNextEpisodeUpdate — CAUGHT_UP, full catalog, newly available episode', () => {
  it('sets nextEpisodeId on a CAUGHT_UP row and moves it to WATCHING when a new unwatched episode now exists', () => {
    // docs/status-model-plan.md §4: caught_up is only a valid state while
    // nextEpisodeId is null — a CAUGHT_UP row that gains a real next
    // episode must become WATCHING, same as every other "next episode
    // found" case (deriveUserStatusFromNextEpisode has no "stay CAUGHT_UP"
    // branch).
    const decision = deriveNextEpisodeUpdate(
      input({ currentUserStatus: UserSeriesStatus.CAUGHT_UP, watchedEpisodeIds: new Set(['ep-1', 'ep-2']) }),
    );
    expect(decision.action).toBe('set-next-episode');
    expect(decision.nextEpisodeId).toBe('ep-3');
    expect(decision.newUserStatus).toBe(UserSeriesStatus.WATCHING);
  });

  it('moves CAUGHT_UP -> WATCHING regardless of releaseStatus (RETURNING, IN_PRODUCTION, or even ENDED/CANCELLED/UNKNOWN)', () => {
    // A next episode existing is itself the strongest signal — it doesn't
    // matter what releaseStatus says, exactly like deriveUserStatusFromNextEpisode's
    // own unconditional "hasNextEpisode -> WATCHING" branch.
    for (const releaseStatus of [ReleaseStatus.RETURNING, ReleaseStatus.IN_PRODUCTION, ReleaseStatus.ENDED, ReleaseStatus.CANCELLED, ReleaseStatus.UNKNOWN]) {
      const decision = deriveNextEpisodeUpdate(
        input({ currentUserStatus: UserSeriesStatus.CAUGHT_UP, releaseStatus, watchedEpisodeIds: new Set(['ep-1', 'ep-2']) }),
      );
      expect(decision.newUserStatus).toBe(UserSeriesStatus.WATCHING);
    }
  });

  it('leaves a CAUGHT_UP row untouched (no-op) when nothing new is available', () => {
    const decision = deriveNextEpisodeUpdate(
      input({ currentUserStatus: UserSeriesStatus.CAUGHT_UP, watchedEpisodeIds: new Set(['ep-1', 'ep-2', 'ep-3']) }),
    );
    expect(decision.action).toBe('no-op-up-to-date');
    expect(decision.nextEpisodeId).toBeNull();
    expect(decision.newUserStatus).toBeNull();
  });
});

describe('deriveNextEpisodeUpdate — WATCHING, full catalog, nothing left unwatched', () => {
  const caughtUp = new Set(['ep-1', 'ep-2', 'ep-3']);

  it.each([ReleaseStatus.RETURNING, ReleaseStatus.IN_PRODUCTION])('moves WATCHING -> CAUGHT_UP when releaseStatus is %s', (releaseStatus) => {
    const decision = deriveNextEpisodeUpdate(input({ releaseStatus, watchedEpisodeIds: caughtUp }));
    expect(decision.action).toBe('mark-caught-up');
    expect(decision.newUserStatus).toBe(UserSeriesStatus.CAUGHT_UP);
    expect(decision.nextEpisodeId).toBeNull();
  });

  it.each([ReleaseStatus.ENDED, ReleaseStatus.CANCELLED])('moves WATCHING -> COMPLETED when releaseStatus is %s', (releaseStatus) => {
    const decision = deriveNextEpisodeUpdate(input({ releaseStatus, watchedEpisodeIds: caughtUp }));
    expect(decision.action).toBe('mark-completed');
    expect(decision.newUserStatus).toBe(UserSeriesStatus.COMPLETED);
    expect(decision.nextEpisodeId).toBeNull();
  });

  it('moves WATCHING -> CAUGHT_UP (not COMPLETED) when releaseStatus is UNKNOWN, matching markWatched\'s existing rule', () => {
    const decision = deriveNextEpisodeUpdate(input({ releaseStatus: ReleaseStatus.UNKNOWN, watchedEpisodeIds: caughtUp }));
    expect(decision.action).toBe('mark-caught-up');
    expect(decision.newUserStatus).toBe(UserSeriesStatus.CAUGHT_UP);
  });
});
