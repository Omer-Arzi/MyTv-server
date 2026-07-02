import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { BackfillDecisionInput, decideBackfillUserStatus } from '../backfill-status-model-logic';

const base: BackfillDecisionInput = {
  hasExistingProgressRow: false,
  onWatchlist: false,
  watchedCount: 0,
  isArchived: false,
  isForLater: false,
  hasTvTimeSignal: false,
  isImported: false,
  hasKnownNextEpisode: false,
  releaseStatus: ReleaseStatus.UNKNOWN,
};

describe('decideBackfillUserStatus', () => {
  it('skips series with no relationship at all', () => {
    expect(decideBackfillUserStatus(base)).toEqual({ action: 'skip' });
  });

  it('is DROPPED whenever TV Time is_archived is true, regardless of watch state', () => {
    const decision = decideBackfillUserStatus({ ...base, hasExistingProgressRow: true, watchedCount: 5, isArchived: true });
    expect(decision).toEqual({ action: 'set', userStatus: UserSeriesStatus.DROPPED, missingTvTimeSignal: false });
  });

  it('is DROPPED even when the series is also on the watchlist (archived wins)', () => {
    const decision = decideBackfillUserStatus({ ...base, onWatchlist: true, isForLater: true, isArchived: true });
    expect(decision.action === 'set' && decision.userStatus).toBe(UserSeriesStatus.DROPPED);
  });

  it('is WATCHING when a next episode is already known, regardless of import source', () => {
    const decision = decideBackfillUserStatus({ ...base, hasExistingProgressRow: true, hasKnownNextEpisode: true });
    expect(decision.action === 'set' && decision.userStatus).toBe(UserSeriesStatus.WATCHING);
  });

  it('uses WATCHING as a non-committal placeholder for imported, watched series with no known next episode', () => {
    const decision = decideBackfillUserStatus({
      ...base,
      hasExistingProgressRow: true,
      watchedCount: 12,
      isImported: true,
      hasTvTimeSignal: true,
    });
    expect(decision).toEqual({ action: 'set', userStatus: UserSeriesStatus.WATCHING, missingTvTimeSignal: false });
  });

  it('flags missingTvTimeSignal when an imported watched series has no matching TV Time row', () => {
    const decision = decideBackfillUserStatus({
      ...base,
      hasExistingProgressRow: true,
      watchedCount: 3,
      isImported: true,
      hasTvTimeSignal: false,
    });
    expect(decision).toEqual({ action: 'set', userStatus: UserSeriesStatus.WATCHING, missingTvTimeSignal: true });
  });

  it('derives CAUGHT_UP for organic watched series with an ongoing releaseStatus', () => {
    const decision = decideBackfillUserStatus({
      ...base,
      hasExistingProgressRow: true,
      watchedCount: 4,
      isImported: false,
      releaseStatus: ReleaseStatus.RETURNING,
    });
    expect(decision.action === 'set' && decision.userStatus).toBe(UserSeriesStatus.CAUGHT_UP);
  });

  it('derives COMPLETED for organic watched series whose release has ended', () => {
    const decision = decideBackfillUserStatus({
      ...base,
      hasExistingProgressRow: true,
      watchedCount: 4,
      isImported: false,
      releaseStatus: ReleaseStatus.ENDED,
    });
    expect(decision.action === 'set' && decision.userStatus).toBe(UserSeriesStatus.COMPLETED);
  });

  it('does not guess COMPLETED/CAUGHT_UP for imported series even with an ENDED releaseStatus, if the catalog is incomplete', () => {
    // isImported=true always wins the placeholder branch over the organic
    // derivation branch — the whole point of the placeholder rule.
    const decision = decideBackfillUserStatus({
      ...base,
      hasExistingProgressRow: true,
      watchedCount: 4,
      isImported: true,
      hasTvTimeSignal: true,
      releaseStatus: ReleaseStatus.ENDED,
    });
    expect(decision.action === 'set' && decision.userStatus).toBe(UserSeriesStatus.WATCHING);
  });

  it('is WATCHLIST for series with no watch activity that are on the watchlist', () => {
    const decision = decideBackfillUserStatus({ ...base, onWatchlist: true });
    expect(decision.action === 'set' && decision.userStatus).toBe(UserSeriesStatus.WATCHLIST);
  });

  it('is WATCHLIST from TV Time is_for_later even without an existing WatchlistItem row', () => {
    const decision = decideBackfillUserStatus({ ...base, hasExistingProgressRow: true, isForLater: true });
    expect(decision.action === 'set' && decision.userStatus).toBe(UserSeriesStatus.WATCHLIST);
  });

  it('falls back to UNKNOWN when a progress row exists but carries no usable signal', () => {
    const decision = decideBackfillUserStatus({ ...base, hasExistingProgressRow: true });
    expect(decision.action === 'set' && decision.userStatus).toBe(UserSeriesStatus.UNKNOWN);
  });
});
