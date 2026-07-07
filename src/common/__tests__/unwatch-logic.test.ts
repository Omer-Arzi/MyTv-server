import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { checkUnwatchAllowed, recomputeProgressAfterUnwatch } from '../unwatch-logic';

const NOW = new Date('2026-07-05T12:00:00.000Z');
const PAST = new Date('2026-01-01');
const FUTURE = new Date('2027-01-01');

describe('checkUnwatchAllowed', () => {
  it('allows a plain watch with no attached user content', () => {
    const result = checkUnwatchAllowed({ hasNote: false, hasRating: false, hasEmotion: false, force: false });
    expect(result.allowed).toBe(true);
  });

  it('blocks a watch with a note when force is not set', () => {
    const result = checkUnwatchAllowed({ hasNote: true, hasRating: false, hasEmotion: false, force: false });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/note/);
    expect(result.reason).toMatch(/force=true/);
  });

  it('blocks a watch with a rating when force is not set', () => {
    const result = checkUnwatchAllowed({ hasNote: false, hasRating: true, hasEmotion: false, force: false });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/rating/);
  });

  it('blocks a watch with an emotion reaction when force is not set', () => {
    const result = checkUnwatchAllowed({ hasNote: false, hasRating: false, hasEmotion: true, force: false });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/emotion/);
  });

  it('mentions every attached kind when more than one is present', () => {
    const result = checkUnwatchAllowed({ hasNote: true, hasRating: true, hasEmotion: true, force: false });
    expect(result.reason).toMatch(/note/);
    expect(result.reason).toMatch(/rating/);
    expect(result.reason).toMatch(/emotion/);
  });

  it('allows a watch with attached content when force is true', () => {
    const result = checkUnwatchAllowed({ hasNote: true, hasRating: true, hasEmotion: true, force: true });
    expect(result.allowed).toBe(true);
  });
});

describe('recomputeProgressAfterUnwatch', () => {
  it('points nextEpisodeId at the unwatched episode when it is the earliest released unwatched one', () => {
    const result = recomputeProgressAfterUnwatch({
      releaseStatus: ReleaseStatus.RETURNING,
      currentUserStatus: UserSeriesStatus.CAUGHT_UP,
      orderedEpisodes: [
        { id: 'e1', airDate: PAST },
        { id: 'e2', airDate: PAST },
      ],
      // e1 was just unwatched — e2 is still watched.
      watchedEpisodeIdsAfterRemoval: new Set(['e2']),
      now: NOW,
    });
    expect(result.computedNextEpisodeId).toBe('e1');
    expect(result.computedUserStatus).toBe(UserSeriesStatus.WATCHING);
    expect(result.hasRemainingReleasedUnwatched).toBe(true);
    expect(result.statusPreserved).toBe(false);
  });

  it('makes an older unwatched episode next even when a later episode is still watched', () => {
    const result = recomputeProgressAfterUnwatch({
      releaseStatus: ReleaseStatus.RETURNING,
      currentUserStatus: UserSeriesStatus.WATCHING,
      orderedEpisodes: [
        { id: 'e1', airDate: PAST },
        { id: 'e2', airDate: PAST },
        { id: 'e3', airDate: PAST },
      ],
      // e2 was unwatched; e1 and e3 remain watched — e2 is the earliest gap.
      watchedEpisodeIdsAfterRemoval: new Set(['e1', 'e3']),
      now: NOW,
    });
    expect(result.computedNextEpisodeId).toBe('e2');
  });

  it('is CAUGHT_UP when no released unwatched episode remains and the series is still returning', () => {
    const result = recomputeProgressAfterUnwatch({
      releaseStatus: ReleaseStatus.RETURNING,
      currentUserStatus: UserSeriesStatus.COMPLETED,
      orderedEpisodes: [{ id: 'e1', airDate: PAST }],
      watchedEpisodeIdsAfterRemoval: new Set(['e1']),
      now: NOW,
    });
    expect(result.computedNextEpisodeId).toBeNull();
    expect(result.computedUserStatus).toBe(UserSeriesStatus.CAUGHT_UP);
    expect(result.hasRemainingReleasedUnwatched).toBe(false);
  });

  it('is COMPLETED when no released unwatched episode remains and the series has ended', () => {
    const result = recomputeProgressAfterUnwatch({
      releaseStatus: ReleaseStatus.ENDED,
      currentUserStatus: UserSeriesStatus.COMPLETED,
      orderedEpisodes: [{ id: 'e1', airDate: PAST }],
      watchedEpisodeIdsAfterRemoval: new Set(['e1']),
      now: NOW,
    });
    expect(result.computedUserStatus).toBe(UserSeriesStatus.COMPLETED);
  });

  it('ignores a future unwatched episode when deciding next/status', () => {
    const result = recomputeProgressAfterUnwatch({
      releaseStatus: ReleaseStatus.RETURNING,
      currentUserStatus: UserSeriesStatus.CAUGHT_UP,
      orderedEpisodes: [
        { id: 'e1', airDate: FUTURE },
        { id: 'e2', airDate: PAST },
      ],
      watchedEpisodeIdsAfterRemoval: new Set(['e2']),
      now: NOW,
    });
    expect(result.computedNextEpisodeId).toBeNull();
    expect(result.hasRemainingReleasedUnwatched).toBe(false);
  });

  it('preserves DROPPED and does not report a computed userStatus as authoritative', () => {
    const result = recomputeProgressAfterUnwatch({
      releaseStatus: ReleaseStatus.RETURNING,
      currentUserStatus: UserSeriesStatus.DROPPED,
      orderedEpisodes: [{ id: 'e1', airDate: PAST }],
      watchedEpisodeIdsAfterRemoval: new Set(),
      now: NOW,
    });
    expect(result.statusPreserved).toBe(true);
    expect(result.computedUserStatus).toBe(UserSeriesStatus.DROPPED);
    // Still reports the underlying fact accurately even though preserved.
    expect(result.hasRemainingReleasedUnwatched).toBe(true);
  });

  it('preserves PAUSED the same way', () => {
    const result = recomputeProgressAfterUnwatch({
      releaseStatus: ReleaseStatus.RETURNING,
      currentUserStatus: UserSeriesStatus.PAUSED,
      orderedEpisodes: [{ id: 'e1', airDate: PAST }],
      watchedEpisodeIdsAfterRemoval: new Set(['e1']),
      now: NOW,
    });
    expect(result.statusPreserved).toBe(true);
    expect(result.computedUserStatus).toBe(UserSeriesStatus.PAUSED);
  });

  it('does not preserve WATCHLIST — recomputes normally', () => {
    const result = recomputeProgressAfterUnwatch({
      releaseStatus: ReleaseStatus.RETURNING,
      currentUserStatus: UserSeriesStatus.WATCHLIST,
      orderedEpisodes: [{ id: 'e1', airDate: PAST }],
      watchedEpisodeIdsAfterRemoval: new Set(),
      now: NOW,
    });
    expect(result.statusPreserved).toBe(false);
    expect(result.computedUserStatus).toBe(UserSeriesStatus.WATCHING);
  });
});
