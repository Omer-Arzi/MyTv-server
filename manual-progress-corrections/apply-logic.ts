// Pure eligibility logic for applying a manual progress correction decision.
// No I/O — testable without a database. Same rationale as
// watch-next-review/apply-logic.ts: time passes between plan generation and
// apply, so this re-checks CURRENT state rather than trusting whatever was
// true when the plan/decisions file was written — a stale decision should be
// skipped, never forced.

import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { deriveStatusAfterMarkAllWatched } from './plan-logic';

export type ApplyOutcome =
  | 'would_apply'
  | 'applied'
  | 'skipped_not_apply_decision'
  | 'skipped_no_progress_row'
  | 'skipped_not_watching'
  | 'skipped_next_episode_already_set'
  | 'skipped_unwatched_episodes_exist';

export interface DecisionRow {
  decision: string; // 'apply' | 'skip' | 'needs_mapping' | 'report_only'
}

export interface CurrentSeriesState {
  userStatus: UserSeriesStatus;
  nextEpisodeId: string | null;
  watchedEpisodeCount: number;
  knownEpisodeCount: number;
  releaseStatus: ReleaseStatus;
}

export interface EvaluatedApply {
  outcome: ApplyOutcome;
  reason: string;
  proposedUserStatus?: UserSeriesStatus;
}

// Only ever acts on decision === "apply"; every other decision value
// (skip/needs_mapping/report_only) is informational only and never triggers
// a write, regardless of current DB state.
export function evaluateMarkCaughtUpApply(row: DecisionRow, current: CurrentSeriesState | null): EvaluatedApply {
  if (row.decision !== 'apply') {
    return { outcome: 'skipped_not_apply_decision', reason: `decision is "${row.decision}", not "apply" — no action taken` };
  }

  if (!current) {
    return { outcome: 'skipped_no_progress_row', reason: 'no UserSeriesProgress row found for this series/user anymore' };
  }

  if (current.userStatus !== UserSeriesStatus.WATCHING) {
    return {
      outcome: 'skipped_not_watching',
      reason: `current userStatus is ${current.userStatus}, not WATCHING — state has changed since the plan was generated, skipping to avoid clobbering it`,
    };
  }

  if (current.nextEpisodeId !== null) {
    return {
      outcome: 'skipped_next_episode_already_set',
      reason: 'nextEpisodeId is no longer null — a real next episode now exists (e.g. via backfill/enrichment) since the plan was generated; skipping rather than overriding it',
    };
  }

  if (current.watchedEpisodeCount < current.knownEpisodeCount) {
    return {
      outcome: 'skipped_unwatched_episodes_exist',
      reason: `${current.knownEpisodeCount - current.watchedEpisodeCount} known episode(s) are now unwatched (the catalog changed since the plan was generated) — skipping rather than silently marking them watched`,
    };
  }

  const proposedUserStatus = deriveStatusAfterMarkAllWatched(current.releaseStatus);
  return {
    outcome: 'would_apply',
    reason: `userStatus is still WATCHING, nextEpisodeId is still null, and all ${current.knownEpisodeCount} known episodes are watched — safe to set userStatus to ${proposedUserStatus}`,
    proposedUserStatus,
  };
}
