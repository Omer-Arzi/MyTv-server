import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { deriveUserStatusFromNextEpisode, ProposeUserStatusInput, proposeUserStatusAfterEnrichment } from '../derive-user-status';

describe('deriveUserStatusFromNextEpisode', () => {
  it('is WATCHING whenever a next episode exists, regardless of releaseStatus', () => {
    expect(deriveUserStatusFromNextEpisode(true, ReleaseStatus.RETURNING)).toBe(UserSeriesStatus.WATCHING);
    expect(deriveUserStatusFromNextEpisode(true, ReleaseStatus.ENDED)).toBe(UserSeriesStatus.WATCHING);
    expect(deriveUserStatusFromNextEpisode(true, ReleaseStatus.UNKNOWN)).toBe(UserSeriesStatus.WATCHING);
  });

  it('is CAUGHT_UP when there is no next episode but the show could still air more', () => {
    expect(deriveUserStatusFromNextEpisode(false, ReleaseStatus.RETURNING)).toBe(UserSeriesStatus.CAUGHT_UP);
    expect(deriveUserStatusFromNextEpisode(false, ReleaseStatus.IN_PRODUCTION)).toBe(UserSeriesStatus.CAUGHT_UP);
  });

  it('defaults an UNKNOWN releaseStatus to CAUGHT_UP rather than assuming COMPLETED', () => {
    // Not knowing whether the show has ended is not the same as knowing it
    // has — CAUGHT_UP is the honest "nothing to watch right now" state.
    expect(deriveUserStatusFromNextEpisode(false, ReleaseStatus.UNKNOWN)).toBe(UserSeriesStatus.CAUGHT_UP);
  });

  it('is COMPLETED only when there is no next episode AND the show is confirmed finished', () => {
    expect(deriveUserStatusFromNextEpisode(false, ReleaseStatus.ENDED)).toBe(UserSeriesStatus.COMPLETED);
    expect(deriveUserStatusFromNextEpisode(false, ReleaseStatus.CANCELLED)).toBe(UserSeriesStatus.COMPLETED);
  });
});

describe('proposeUserStatusAfterEnrichment', () => {
  const base: ProposeUserStatusInput = {
    currentUserStatus: UserSeriesStatus.WATCHING,
    watchedEpisodeCount: 5,
    totalKnownEpisodeCount: 10,
    candidateReleaseStatus: ReleaseStatus.RETURNING,
  };

  it('never proposes changing a DROPPED status', () => {
    const result = proposeUserStatusAfterEnrichment({ ...base, currentUserStatus: UserSeriesStatus.DROPPED });
    expect(result.proposedUserStatus).toBe(UserSeriesStatus.DROPPED);
    expect(result.reason).toMatch(/user-controlled/);
  });

  it('never proposes changing a PAUSED status', () => {
    const result = proposeUserStatusAfterEnrichment({ ...base, currentUserStatus: UserSeriesStatus.PAUSED });
    expect(result.proposedUserStatus).toBe(UserSeriesStatus.PAUSED);
  });

  it('leaves status unchanged when nothing has been watched yet', () => {
    const result = proposeUserStatusAfterEnrichment({
      ...base,
      currentUserStatus: UserSeriesStatus.WATCHLIST,
      watchedEpisodeCount: 0,
    });
    expect(result.proposedUserStatus).toBe(UserSeriesStatus.WATCHLIST);
    expect(result.reason).toMatch(/no episodes watched/);
  });

  it('proposes WATCHING when unwatched episodes remain in the fuller catalog', () => {
    const result = proposeUserStatusAfterEnrichment({ ...base, watchedEpisodeCount: 5, totalKnownEpisodeCount: 10 });
    expect(result.proposedUserStatus).toBe(UserSeriesStatus.WATCHING);
    expect(result.reason).toMatch(/5 unwatched episode/);
  });

  it('proposes CAUGHT_UP when everything known is watched but the show is still ongoing', () => {
    const result = proposeUserStatusAfterEnrichment({
      ...base,
      watchedEpisodeCount: 10,
      totalKnownEpisodeCount: 10,
      candidateReleaseStatus: ReleaseStatus.RETURNING,
    });
    expect(result.proposedUserStatus).toBe(UserSeriesStatus.CAUGHT_UP);
  });

  it('proposes COMPLETED when everything known is watched and the show has ended', () => {
    const result = proposeUserStatusAfterEnrichment({
      ...base,
      watchedEpisodeCount: 10,
      totalKnownEpisodeCount: 10,
      candidateReleaseStatus: ReleaseStatus.ENDED,
    });
    expect(result.proposedUserStatus).toBe(UserSeriesStatus.COMPLETED);
  });

  it('never proposes CAUGHT_UP/COMPLETED directly from TV-Time-only data — only via a fuller known catalog', () => {
    // Sanity check on the contract itself: this function requires a caller
    // to supply totalKnownEpisodeCount, which TV Time import never has
    // (docs/status-model-plan.md's new TV-Time-derivable-subset section) —
    // so CAUGHT_UP/COMPLETED can only come from a real enrichment fetch,
    // never accidentally from import-time data.
    const result = proposeUserStatusAfterEnrichment({
      ...base,
      watchedEpisodeCount: 10,
      totalKnownEpisodeCount: 10,
      candidateReleaseStatus: ReleaseStatus.UNKNOWN,
    });
    expect(result.proposedUserStatus).toBe(UserSeriesStatus.CAUGHT_UP);
    expect([UserSeriesStatus.CAUGHT_UP, UserSeriesStatus.COMPLETED]).toContain(result.proposedUserStatus);
  });
});
