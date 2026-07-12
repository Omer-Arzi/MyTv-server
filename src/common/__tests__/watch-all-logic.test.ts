import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { checkWatchAllAllowed, planWatchAll, recomputeProgressAfterWatchAll, WatchAllEpisodeInput } from '../watch-all-logic';

const NOW = new Date('2026-07-05T12:00:00.000Z');
const PAST = new Date('2026-01-01');
const FUTURE = new Date('2027-01-01');

function ep(id: string, airDate: Date | null, alreadyWatched = false): WatchAllEpisodeInput {
  return { id, airDate, alreadyWatched };
}

describe('planWatchAll', () => {
  it('creates a watch only for released, unwatched episodes', () => {
    const plan = planWatchAll([ep('e1', PAST, false), ep('e2', PAST, true)], { includeUnknownAirDate: false }, NOW);
    expect(plan.toCreate).toEqual(['e1']);
    expect(plan.alreadyWatched).toEqual(['e2']);
  });

  it('excludes future episodes regardless of watched state', () => {
    const plan = planWatchAll([ep('e1', FUTURE, false)], { includeUnknownAirDate: false }, NOW);
    expect(plan.toCreate).toEqual([]);
    expect(plan.skippedFuture).toEqual(['e1']);
  });

  it('excludes null-airDate episodes by default', () => {
    const plan = planWatchAll([ep('e1', null, false)], { includeUnknownAirDate: false }, NOW);
    expect(plan.toCreate).toEqual([]);
    expect(plan.skippedUnknownAirDate).toEqual(['e1']);
  });

  it('includes null-airDate episodes when includeUnknownAirDate is true', () => {
    const plan = planWatchAll([ep('e1', null, false)], { includeUnknownAirDate: true }, NOW);
    expect(plan.toCreate).toEqual(['e1']);
    expect(plan.skippedUnknownAirDate).toEqual([]);
  });

  it('treats an already-watched null-airDate episode as alreadyWatched when included', () => {
    const plan = planWatchAll([ep('e1', null, true)], { includeUnknownAirDate: true }, NOW);
    expect(plan.alreadyWatched).toEqual(['e1']);
    expect(plan.toCreate).toEqual([]);
  });

  it('treats an airDate of exactly now as released', () => {
    const plan = planWatchAll([ep('e1', NOW, false)], { includeUnknownAirDate: false }, NOW);
    expect(plan.toCreate).toEqual(['e1']);
  });

  it('classifies a mixed batch correctly across all four buckets', () => {
    const plan = planWatchAll(
      [ep('released-new', PAST, false), ep('released-old', PAST, true), ep('future', FUTURE, false), ep('unknown', null, false)],
      { includeUnknownAirDate: false },
      NOW,
    );
    expect(plan.toCreate).toEqual(['released-new']);
    expect(plan.alreadyWatched).toEqual(['released-old']);
    expect(plan.skippedFuture).toEqual(['future']);
    expect(plan.skippedUnknownAirDate).toEqual(['unknown']);
  });

  it('returns empty buckets for an empty input list', () => {
    const plan = planWatchAll([], { includeUnknownAirDate: false }, NOW);
    expect(plan).toEqual({ toCreate: [], alreadyWatched: [], skippedFuture: [], skippedUnknownAirDate: [] });
  });
});

describe('recomputeProgressAfterWatchAll', () => {
  it('is WATCHING with the next unwatched released episode when one remains', () => {
    const result = recomputeProgressAfterWatchAll({
      releaseStatus: ReleaseStatus.RETURNING,
      orderedEpisodes: [
        { id: 'e1', airDate: PAST, seasonNumber: 1 },
        { id: 'e2', airDate: PAST, seasonNumber: 1 },
      ],
      watchedEpisodeIds: new Set(['e1']),
      now: NOW,
    });
    expect(result.nextEpisodeId).toBe('e2');
    expect(result.userStatus).toBe(UserSeriesStatus.WATCHING);
  });

  it('is CAUGHT_UP when nothing released remains unwatched and the series is still returning', () => {
    const result = recomputeProgressAfterWatchAll({
      releaseStatus: ReleaseStatus.RETURNING,
      orderedEpisodes: [{ id: 'e1', airDate: PAST, seasonNumber: 1 }],
      watchedEpisodeIds: new Set(['e1']),
      now: NOW,
    });
    expect(result.nextEpisodeId).toBeNull();
    expect(result.userStatus).toBe(UserSeriesStatus.CAUGHT_UP);
  });

  it('is COMPLETED when nothing released remains unwatched and the series has ended', () => {
    const result = recomputeProgressAfterWatchAll({
      releaseStatus: ReleaseStatus.ENDED,
      orderedEpisodes: [{ id: 'e1', airDate: PAST, seasonNumber: 1 }],
      watchedEpisodeIds: new Set(['e1']),
      now: NOW,
    });
    expect(result.userStatus).toBe(UserSeriesStatus.COMPLETED);
  });

  it('is COMPLETED when the series was cancelled', () => {
    const result = recomputeProgressAfterWatchAll({
      releaseStatus: ReleaseStatus.CANCELLED,
      orderedEpisodes: [{ id: 'e1', airDate: PAST, seasonNumber: 1 }],
      watchedEpisodeIds: new Set(['e1']),
      now: NOW,
    });
    expect(result.userStatus).toBe(UserSeriesStatus.COMPLETED);
  });

  it('ignores a future unwatched episode when deciding next/status', () => {
    const result = recomputeProgressAfterWatchAll({
      releaseStatus: ReleaseStatus.RETURNING,
      orderedEpisodes: [
        { id: 'e1', airDate: PAST, seasonNumber: 1 },
        { id: 'e2', airDate: FUTURE, seasonNumber: 1 },
      ],
      watchedEpisodeIds: new Set(['e1']),
      now: NOW,
    });
    expect(result.nextEpisodeId).toBeNull();
    expect(result.userStatus).toBe(UserSeriesStatus.CAUGHT_UP);
  });

  it('ignores a null-airDate unwatched episode when deciding next/status (always conservative, regardless of includeUnknownAirDate at mark-time)', () => {
    const result = recomputeProgressAfterWatchAll({
      releaseStatus: ReleaseStatus.RETURNING,
      orderedEpisodes: [
        { id: 'e1', airDate: PAST, seasonNumber: 1 },
        { id: 'e2', airDate: null, seasonNumber: 1 },
      ],
      watchedEpisodeIds: new Set(['e1']),
      now: NOW,
    });
    expect(result.nextEpisodeId).toBeNull();
    expect(result.userStatus).toBe(UserSeriesStatus.CAUGHT_UP);
  });
});

describe('checkWatchAllAllowed', () => {
  it('allows a WATCHING series without force', () => {
    expect(checkWatchAllAllowed({ currentUserStatus: UserSeriesStatus.WATCHING, force: false }).allowed).toBe(true);
  });

  it('allows a CAUGHT_UP series without force', () => {
    expect(checkWatchAllAllowed({ currentUserStatus: UserSeriesStatus.CAUGHT_UP, force: false }).allowed).toBe(true);
  });

  it('allows a WATCHLIST series without force (not protected)', () => {
    expect(checkWatchAllAllowed({ currentUserStatus: UserSeriesStatus.WATCHLIST, force: false }).allowed).toBe(true);
  });

  it('blocks a DROPPED series without force', () => {
    const result = checkWatchAllAllowed({ currentUserStatus: UserSeriesStatus.DROPPED, force: false });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/force=true/);
  });

  it('blocks a PAUSED series without force', () => {
    expect(checkWatchAllAllowed({ currentUserStatus: UserSeriesStatus.PAUSED, force: false }).allowed).toBe(false);
  });

  it('allows a DROPPED series when force is true', () => {
    expect(checkWatchAllAllowed({ currentUserStatus: UserSeriesStatus.DROPPED, force: true }).allowed).toBe(true);
  });

  it('allows a PAUSED series when force is true', () => {
    expect(checkWatchAllAllowed({ currentUserStatus: UserSeriesStatus.PAUSED, force: true }).allowed).toBe(true);
  });
});
