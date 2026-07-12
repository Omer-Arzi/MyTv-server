import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { checkAutoApplySafety, hasProgressChanged, reconcileSeriesProgress } from '../progress-reconciliation-logic';
import { EPISODE_NUMBERING_RISK_LIST_TITLES } from '../../src/common/stale-series-trust';

const PAST = new Date('2000-01-01');
const FUTURE = new Date('2999-01-01');

function ep(id: string, airDate: Date | null, seasonNumber = 1) {
  return { id, airDate, seasonNumber };
}

function baseInput(overrides: Partial<Parameters<typeof reconcileSeriesProgress>[0]> = {}): Parameters<typeof reconcileSeriesProgress>[0] {
  return {
    currentUserStatus: UserSeriesStatus.CAUGHT_UP,
    currentNextEpisodeId: null,
    orderedEpisodes: [],
    watchedEpisodeIds: new Set<string>(),
    releaseStatus: ReleaseStatus.RETURNING,
    ...overrides,
  };
}

describe('reconcileSeriesProgress — protected/tracked gating', () => {
  it.each([UserSeriesStatus.PAUSED, UserSeriesStatus.DROPPED])('%s is protected — never recomputed', (status) => {
    const result = reconcileSeriesProgress(
      baseInput({ currentUserStatus: status, orderedEpisodes: [ep('e1', PAST)], watchedEpisodeIds: new Set() }),
    );
    expect(result.kind).toBe('protected');
  });

  it.each([UserSeriesStatus.WATCHLIST, UserSeriesStatus.UNKNOWN])('%s is not tracked — no next-episode concept applies', (status) => {
    const result = reconcileSeriesProgress(baseInput({ currentUserStatus: status }));
    expect(result.kind).toBe('not-tracked');
  });
});

describe('reconcileSeriesProgress — the X-Men \'97 case: a local future episode ages into released', () => {
  it('before the air date passes: no unwatched released episode exists -> stays CAUGHT_UP, unchanged', () => {
    const now = new Date('2026-07-06T00:00:00Z');
    const result = reconcileSeriesProgress(
      baseInput({
        currentUserStatus: UserSeriesStatus.CAUGHT_UP,
        currentNextEpisodeId: null,
        orderedEpisodes: [ep('s2e3', new Date('2026-07-01')), ep('s2e4', new Date('2026-07-08'))],
        watchedEpisodeIds: new Set(['s2e3']),
        releaseStatus: ReleaseStatus.RETURNING,
        now,
      }),
    );
    expect(result).toEqual({ kind: 'unchanged', computed: { userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null } });
  });

  it('after the air date passes: the same local episode is now released -> WATCHING, next episode set, classified as the stale-CAUGHT_UP mismatch', () => {
    const now = new Date('2026-07-11T00:00:00Z');
    const result = reconcileSeriesProgress(
      baseInput({
        currentUserStatus: UserSeriesStatus.CAUGHT_UP,
        currentNextEpisodeId: null,
        orderedEpisodes: [ep('s2e3', new Date('2026-07-01')), ep('s2e4', new Date('2026-07-08'))],
        watchedEpisodeIds: new Set(['s2e3']),
        releaseStatus: ReleaseStatus.RETURNING,
        now,
      }),
    );
    expect(result).toEqual({
      kind: 'changed',
      from: { userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null },
      to: { userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: 's2e4' },
      mismatchType: 'stale-caught-up-with-released-unwatched-episode',
    });
  });
});

describe('reconcileSeriesProgress — status derivation correctness', () => {
  it('returning show with no released unwatched episodes -> CAUGHT_UP', () => {
    const result = reconcileSeriesProgress(
      baseInput({
        currentUserStatus: UserSeriesStatus.WATCHING,
        currentNextEpisodeId: 'stale-id',
        orderedEpisodes: [ep('e1', PAST)],
        watchedEpisodeIds: new Set(['e1']),
        releaseStatus: ReleaseStatus.RETURNING,
      }),
    );
    expect(result.kind).toBe('changed');
    if (result.kind === 'changed') {
      expect(result.to).toEqual({ userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null });
      expect(result.mismatchType).toBe('stale-watching-with-no-released-unwatched-episode');
    }
  });

  it('ended show with no released unwatched episodes -> COMPLETED', () => {
    const result = reconcileSeriesProgress(
      baseInput({
        currentUserStatus: UserSeriesStatus.WATCHING,
        currentNextEpisodeId: 'stale-id',
        orderedEpisodes: [ep('e1', PAST)],
        watchedEpisodeIds: new Set(['e1']),
        releaseStatus: ReleaseStatus.ENDED,
      }),
    );
    expect(result.kind).toBe('changed');
    if (result.kind === 'changed') {
      expect(result.to).toEqual({ userStatus: UserSeriesStatus.COMPLETED, nextEpisodeId: null });
      expect(result.mismatchType).toBe('stale-watching-with-no-released-unwatched-episode');
    }
  });

  it('unreleased episodes never become nextEpisodeId', () => {
    const result = reconcileSeriesProgress(
      baseInput({
        currentUserStatus: UserSeriesStatus.CAUGHT_UP,
        currentNextEpisodeId: null,
        orderedEpisodes: [ep('e1', FUTURE)],
        watchedEpisodeIds: new Set(),
        releaseStatus: ReleaseStatus.RETURNING,
      }),
    );
    expect(result).toEqual({ kind: 'unchanged', computed: { userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null } });
  });

  it('a stale/null nextEpisodeId is corrected when a released unwatched episode already exists', () => {
    const result = reconcileSeriesProgress(
      baseInput({
        currentUserStatus: UserSeriesStatus.WATCHING,
        currentNextEpisodeId: null,
        orderedEpisodes: [ep('e1', PAST), ep('e2', PAST)],
        watchedEpisodeIds: new Set(['e1']),
        releaseStatus: ReleaseStatus.RETURNING,
      }),
    );
    expect(result.kind).toBe('changed');
    if (result.kind === 'changed') {
      expect(result.to).toEqual({ userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: 'e2' });
      expect(result.mismatchType).toBe('wrong-or-null-next-episode-id');
    }
  });

  it('stale COMPLETED: catalog now shows an unwatched released episode -> reclassified, mismatchType stale-completed', () => {
    const result = reconcileSeriesProgress(
      baseInput({
        currentUserStatus: UserSeriesStatus.COMPLETED,
        currentNextEpisodeId: null,
        orderedEpisodes: [ep('e1', PAST), ep('e2', PAST)],
        watchedEpisodeIds: new Set(['e1']),
        releaseStatus: ReleaseStatus.RETURNING,
      }),
    );
    expect(result.kind).toBe('changed');
    if (result.kind === 'changed') {
      expect(result.to).toEqual({ userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: 'e2' });
      expect(result.mismatchType).toBe('stale-completed');
    }
  });

  it('same status, different nextEpisodeId (not from/to status change) is classified wrong-or-null-next-episode-id even for COMPLETED', () => {
    const result = reconcileSeriesProgress(
      baseInput({
        currentUserStatus: UserSeriesStatus.COMPLETED,
        currentNextEpisodeId: 'ghost-episode-id',
        orderedEpisodes: [ep('e1', PAST)],
        watchedEpisodeIds: new Set(['e1']),
        releaseStatus: ReleaseStatus.ENDED,
      }),
    );
    expect(result).toEqual({
      kind: 'changed',
      from: { userStatus: UserSeriesStatus.COMPLETED, nextEpisodeId: 'ghost-episode-id' },
      to: { userStatus: UserSeriesStatus.COMPLETED, nextEpisodeId: null },
      mismatchType: 'wrong-or-null-next-episode-id',
    });
  });

  it('genuinely no mismatch: WATCHING stays WATCHING with the same next episode -> unchanged', () => {
    const result = reconcileSeriesProgress(
      baseInput({
        currentUserStatus: UserSeriesStatus.WATCHING,
        currentNextEpisodeId: 'e2',
        orderedEpisodes: [ep('e1', PAST), ep('e2', PAST)],
        watchedEpisodeIds: new Set(['e1']),
        releaseStatus: ReleaseStatus.RETURNING,
      }),
    );
    expect(result).toEqual({ kind: 'unchanged', computed: { userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: 'e2' } });
  });
});

describe('reconcileSeriesProgress — Season 0 (Specials) never participates in derived progress', () => {
  it('ended show, all canonical episodes watched, unwatched Specials only -> reconciles to COMPLETED', () => {
    const result = reconcileSeriesProgress(
      baseInput({
        currentUserStatus: UserSeriesStatus.WATCHING,
        currentNextEpisodeId: 'special-1',
        orderedEpisodes: [ep('special-1', PAST, 0), ep('e1', PAST, 1), ep('e2', PAST, 1)],
        watchedEpisodeIds: new Set(['e1', 'e2']),
        releaseStatus: ReleaseStatus.ENDED,
      }),
    );
    expect(result).toEqual({
      kind: 'changed',
      from: { userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: 'special-1' },
      to: { userStatus: UserSeriesStatus.COMPLETED, nextEpisodeId: null },
      mismatchType: 'stale-watching-with-no-released-unwatched-episode',
    });
  });

  it('returning show, all currently-released canonical episodes watched, unwatched Specials only -> reconciles to CAUGHT_UP', () => {
    const result = reconcileSeriesProgress(
      baseInput({
        currentUserStatus: UserSeriesStatus.WATCHING,
        currentNextEpisodeId: 'special-1',
        orderedEpisodes: [ep('special-1', PAST, 0), ep('e1', PAST, 1), ep('e2', PAST, 1)],
        watchedEpisodeIds: new Set(['e1', 'e2']),
        releaseStatus: ReleaseStatus.RETURNING,
      }),
    );
    expect(result).toEqual({
      kind: 'changed',
      from: { userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: 'special-1' },
      to: { userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null },
      mismatchType: 'stale-watching-with-no-released-unwatched-episode',
    });
  });

  it('a released, unwatched canonical episode is still found as next -> WATCHING, Season 0 ignored regardless of position', () => {
    const result = reconcileSeriesProgress(
      baseInput({
        currentUserStatus: UserSeriesStatus.CAUGHT_UP,
        currentNextEpisodeId: null,
        orderedEpisodes: [ep('e1', PAST, 1), ep('special-1', PAST, 0), ep('s2e5', PAST, 2)],
        watchedEpisodeIds: new Set(['e1']),
        releaseStatus: ReleaseStatus.RETURNING,
      }),
    );
    expect(result).toEqual({
      kind: 'changed',
      from: { userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null },
      to: { userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: 's2e5' },
      mismatchType: 'stale-caught-up-with-released-unwatched-episode',
    });
  });
});

describe('hasProgressChanged', () => {
  it('false when both fields match', () => {
    expect(hasProgressChanged({ userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: 'e1' }, { userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: 'e1' })).toBe(false);
  });
  it('true when userStatus differs', () => {
    expect(hasProgressChanged({ userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: 'e1' }, { userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: 'e1' })).toBe(true);
  });
  it('true when nextEpisodeId differs', () => {
    expect(hasProgressChanged({ userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: 'e1' }, { userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: 'e2' })).toBe(true);
  });
});

describe('checkAutoApplySafety', () => {
  it('flags a risk-listed title as unsafe to auto-apply', () => {
    const result = checkAutoApplySafety(EPISODE_NUMBERING_RISK_LIST_TITLES[0]);
    expect(result.safe).toBe(false);
  });
  it('allows a title with no known risk flags', () => {
    const result = checkAutoApplySafety("X-Men '97");
    expect(result.safe).toBe(true);
  });
});
