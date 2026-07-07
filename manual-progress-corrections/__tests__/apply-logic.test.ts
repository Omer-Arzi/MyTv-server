import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { CurrentSeriesState, evaluateMarkCaughtUpApply } from '../apply-logic';

function state(overrides: Partial<CurrentSeriesState> = {}): CurrentSeriesState {
  return {
    userStatus: UserSeriesStatus.WATCHING,
    nextEpisodeId: null,
    watchedEpisodeCount: 10,
    knownEpisodeCount: 10,
    releaseStatus: ReleaseStatus.UNKNOWN,
    ...overrides,
  };
}

describe('evaluateMarkCaughtUpApply', () => {
  it('applies when userStatus is WATCHING, nextEpisodeId is null, and all known episodes are watched', () => {
    const result = evaluateMarkCaughtUpApply({ decision: 'apply' }, state());
    expect(result.outcome).toBe('would_apply');
    expect(result.proposedUserStatus).toBe(UserSeriesStatus.CAUGHT_UP);
  });

  it('proposes COMPLETED when releaseStatus is ENDED', () => {
    const result = evaluateMarkCaughtUpApply({ decision: 'apply' }, state({ releaseStatus: ReleaseStatus.ENDED }));
    expect(result.outcome).toBe('would_apply');
    expect(result.proposedUserStatus).toBe(UserSeriesStatus.COMPLETED);
  });

  it.each(['skip', 'needs_mapping', 'report_only'])('never applies a "%s" decision regardless of current state', (decision) => {
    const result = evaluateMarkCaughtUpApply({ decision }, state());
    expect(result.outcome).toBe('skipped_not_apply_decision');
  });

  it('skips when there is no progress row at all', () => {
    const result = evaluateMarkCaughtUpApply({ decision: 'apply' }, null);
    expect(result.outcome).toBe('skipped_no_progress_row');
  });

  it('skips when current userStatus is no longer WATCHING', () => {
    const result = evaluateMarkCaughtUpApply({ decision: 'apply' }, state({ userStatus: UserSeriesStatus.CAUGHT_UP }));
    expect(result.outcome).toBe('skipped_not_watching');
  });

  it('skips when nextEpisodeId is no longer null', () => {
    const result = evaluateMarkCaughtUpApply({ decision: 'apply' }, state({ nextEpisodeId: 'some-episode-id' }));
    expect(result.outcome).toBe('skipped_next_episode_already_set');
  });

  it('skips when unwatched known episodes now exist', () => {
    const result = evaluateMarkCaughtUpApply({ decision: 'apply' }, state({ watchedEpisodeCount: 8, knownEpisodeCount: 10 }));
    expect(result.outcome).toBe('skipped_unwatched_episodes_exist');
  });
});
