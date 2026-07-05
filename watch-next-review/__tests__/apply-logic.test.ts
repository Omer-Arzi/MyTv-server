import { evaluateMarkCaughtUpDecision, DecisionToEvaluate, CurrentProgressState } from '../apply-logic';

function decision(overrides: Partial<DecisionToEvaluate> = {}): DecisionToEvaluate {
  return { decision: 'mark_caught_up', reviewedUserStatus: 'WATCHING', reviewedNextEpisodeId: 'episode-1', ...overrides };
}

function current(overrides: Partial<CurrentProgressState> = {}): CurrentProgressState {
  return { userStatus: 'WATCHING', nextEpisodeId: 'episode-1', ...overrides };
}

describe('evaluateMarkCaughtUpDecision', () => {
  it('would_apply when userStatus is still WATCHING and nextEpisodeId still matches', () => {
    expect(evaluateMarkCaughtUpDecision(decision(), current()).outcome).toBe('would_apply');
  });

  it('skips non-mark_caught_up decisions without touching the database state', () => {
    const result = evaluateMarkCaughtUpDecision(decision({ decision: 'ignore_for_now' }), current());
    expect(result.outcome).toBe('skipped_not_mark_caught_up');
  });

  it('skips when there is no progress row anymore', () => {
    const result = evaluateMarkCaughtUpDecision(decision(), null);
    expect(result.outcome).toBe('skipped_no_progress_row');
  });

  it('skips as stale when userStatus is no longer WATCHING', () => {
    const result = evaluateMarkCaughtUpDecision(decision(), current({ userStatus: 'CAUGHT_UP' }));
    expect(result.outcome).toBe('skipped_stale_user_status');
  });

  it('skips as stale when nextEpisodeId no longer matches (user watched further)', () => {
    const result = evaluateMarkCaughtUpDecision(decision(), current({ nextEpisodeId: 'episode-2' }));
    expect(result.outcome).toBe('skipped_stale_next_episode');
  });

  it('skips as stale when nextEpisodeId has been cleared to null', () => {
    const result = evaluateMarkCaughtUpDecision(decision(), current({ nextEpisodeId: null }));
    expect(result.outcome).toBe('skipped_stale_next_episode');
  });
});
