import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { deriveUserStatusFromNextEpisode } from '../derive-user-status';

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
