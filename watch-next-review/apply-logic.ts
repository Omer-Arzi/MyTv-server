// Pure eligibility logic for applying a mark_caught_up decision. No I/O —
// testable without a database. The whole point of re-checking here (rather
// than trusting whatever was true when the decision was written) is that
// time passes between review and apply — the user might mark an episode
// watched, or something else might change nextEpisodeId — and applying a
// now-stale decision could silently clobber newer, more correct state.

import { ManualDecision } from './reports';

export type ApplyOutcome =
  | 'would_apply'
  | 'applied'
  | 'skipped_not_mark_caught_up'
  | 'skipped_no_progress_row'
  | 'skipped_stale_user_status'
  | 'skipped_stale_next_episode';

export interface ApplyDecisionResult {
  outcome: ApplyOutcome;
  reason: string;
}

export interface DecisionToEvaluate {
  decision: ManualDecision;
  reviewedUserStatus: string;
  reviewedNextEpisodeId: string;
}

export interface CurrentProgressState {
  userStatus: string;
  nextEpisodeId: string | null;
}

export function evaluateMarkCaughtUpDecision(decision: DecisionToEvaluate, current: CurrentProgressState | null): ApplyDecisionResult {
  if (decision.decision !== 'mark_caught_up') {
    return { outcome: 'skipped_not_mark_caught_up', reason: `decision is "${decision.decision}", not mark_caught_up — no action taken` };
  }

  if (!current) {
    return { outcome: 'skipped_no_progress_row', reason: 'no UserSeriesProgress row found for this series/user anymore' };
  }

  if (current.userStatus !== 'WATCHING') {
    return {
      outcome: 'skipped_stale_user_status',
      reason: `current userStatus is ${current.userStatus}, not WATCHING (was WATCHING when reviewed) — state has changed since review, skipping to avoid clobbering it`,
    };
  }

  if (current.nextEpisodeId !== decision.reviewedNextEpisodeId) {
    return {
      outcome: 'skipped_stale_next_episode',
      reason: `current nextEpisodeId (${current.nextEpisodeId ?? 'null'}) no longer matches the reviewed value (${decision.reviewedNextEpisodeId}) — the user may have watched further since review, skipping`,
    };
  }

  return { outcome: 'would_apply', reason: 'userStatus is still WATCHING and nextEpisodeId still matches the reviewed value — safe to mark caught up' };
}
