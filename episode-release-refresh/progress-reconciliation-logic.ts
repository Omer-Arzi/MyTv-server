// Pure logic for the progress-reconciliation operation
// (docs/progress-reconciliation-architecture-todo.md) — no I/O, no Prisma,
// no TMDb. Determines, from ALREADY-LOCAL data only (episode catalog, watch
// history, release status), what a tracked series' UserSeriesProgress
// SHOULD be right now, independent of whether any new provider episode was
// just inserted. This is what makes progress reconciliation a first-class
// operation rather than a side effect of episode insertion: it never
// touches Season/Episode, never calls TMDb, and can run for every tracked
// series in the library in one fast, offline pass (see
// run-progress-reconciliation.ts).
//
// Built entirely out of the project's existing canonical derivation
// helpers — deriveActiveProgress (src/modules/series/series-query-helpers.ts,
// itself findFirstUnwatchedEpisodeId + deriveUserStatusFromNextEpisode) —
// no new derivation math anywhere in this file.

import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { deriveActiveProgress, OrderedEpisodeForNextLookup } from '../src/modules/series/series-query-helpers';
import { isUntrustedNextEpisodeTitle } from '../src/common/stale-series-trust';
import { TRACKED_USER_STATUSES } from './refresh-logic';

// Explicit user intent — never auto-overridden by any automated process in
// this codebase (matches PROTECTED_USER_STATUSES in
// src/common/derive-user-status.ts, PROTECTED_MIGRATION_STATUSES in
// library-health/migration-confirmation-logic.ts, and the PROTECTED_STATUSES
// used by watch-all-logic.ts/unwatch-logic.ts — every existing automated
// UserSeriesProgress writer already agrees on exactly this pair). Kept as
// its own named export here (rather than importing one of the other
// modules' local copies) for the same reason those modules each keep their
// own: this is data, not logic, and each pipeline's copy is meant to be
// independently auditable against its own file — see
// docs/progress-reconciliation-architecture-todo.md Phase 3 for the full,
// justified protected/tracked-status table.
export const PROTECTED_RECONCILIATION_STATUSES: UserSeriesStatus[] = [UserSeriesStatus.DROPPED, UserSeriesStatus.PAUSED];

export type ProgressMismatchType =
  // stored CAUGHT_UP, computed WATCHING — a released episode became
  // available and nothing recomputed (X-Men '97's exact case).
  | 'stale-caught-up-with-released-unwatched-episode'
  // stored WATCHING, computed CAUGHT_UP or COMPLETED — everything
  // currently released is already watched, but the row still points at a
  // (watched, or otherwise stale) "next" episode.
  | 'stale-watching-with-no-released-unwatched-episode'
  // stored COMPLETED, computed WATCHING or CAUGHT_UP — the row claims
  // nothing more is coming, but the local catalog now says otherwise
  // (e.g. a revival, or a corrected release status).
  | 'stale-completed'
  // Same derived status either way, but nextEpisodeId itself doesn't match
  // what the current catalog/watch-history says it should be.
  | 'wrong-or-null-next-episode-id';

export interface ReconcileSeriesProgressInput {
  currentUserStatus: UserSeriesStatus;
  currentNextEpisodeId: string | null;
  // Every episode in the series, already sorted (seasonNumber,
  // episodeNumber) ascending — sorting is the caller's job, same contract
  // as findFirstUnwatchedEpisodeId itself.
  orderedEpisodes: OrderedEpisodeForNextLookup[];
  watchedEpisodeIds: ReadonlySet<string>;
  releaseStatus: ReleaseStatus;
  now?: Date;
}

export interface ReconciliationProgressValue {
  userStatus: UserSeriesStatus;
  nextEpisodeId: string | null;
}

export type ProgressReconciliationOutcome =
  | { kind: 'protected'; reason: string }
  | { kind: 'not-tracked'; reason: string }
  | { kind: 'unchanged'; computed: ReconciliationProgressValue }
  | { kind: 'changed'; from: ReconciliationProgressValue; to: ReconciliationProgressValue; mismatchType: ProgressMismatchType };

// True when the two progress snapshots differ in either field — the single
// shared "is a write actually needed" check, reused by both write paths
// (apply-progress-reconciliation.ts's own path, and
// apply-refresh-transaction.ts's existing insert-triggered recompute) so
// neither one bumps updatedAt / issues a Prisma update() for a
// no-op-in-substance recompute.
export function hasProgressChanged(from: ReconciliationProgressValue, to: ReconciliationProgressValue): boolean {
  return from.userStatus !== to.userStatus || from.nextEpisodeId !== to.nextEpisodeId;
}

function classifyMismatch(fromStatus: UserSeriesStatus, toStatus: UserSeriesStatus): ProgressMismatchType {
  if (fromStatus === UserSeriesStatus.CAUGHT_UP && toStatus === UserSeriesStatus.WATCHING) {
    return 'stale-caught-up-with-released-unwatched-episode';
  }
  if (fromStatus === UserSeriesStatus.WATCHING && (toStatus === UserSeriesStatus.CAUGHT_UP || toStatus === UserSeriesStatus.COMPLETED)) {
    return 'stale-watching-with-no-released-unwatched-episode';
  }
  if (fromStatus === UserSeriesStatus.COMPLETED && toStatus !== UserSeriesStatus.COMPLETED) {
    return 'stale-completed';
  }
  return 'wrong-or-null-next-episode-id';
}

// The reconciliation operation itself. Gates on status first (protected,
// then tracked) — deriveActiveProgress is only ever invoked for a status
// this pipeline is actually allowed to touch, per
// docs/progress-reconciliation-architecture-todo.md Phase 3's table.
export function reconcileSeriesProgress(input: ReconcileSeriesProgressInput): ProgressReconciliationOutcome {
  if (PROTECTED_RECONCILIATION_STATUSES.includes(input.currentUserStatus)) {
    return {
      kind: 'protected',
      reason: `current userStatus is ${input.currentUserStatus} — explicit user intent, never auto-overridden`,
    };
  }

  if (!TRACKED_USER_STATUSES.includes(input.currentUserStatus)) {
    return {
      kind: 'not-tracked',
      reason: `current userStatus is ${input.currentUserStatus} — not a tracked active status; no next-episode concept applies (see docs/status-model-plan.md §4)`,
    };
  }

  const computed = deriveActiveProgress({
    orderedEpisodes: input.orderedEpisodes,
    watchedEpisodeIds: input.watchedEpisodeIds,
    releaseStatus: input.releaseStatus,
    now: input.now,
  });

  const from: ReconciliationProgressValue = { userStatus: input.currentUserStatus, nextEpisodeId: input.currentNextEpisodeId };

  if (!hasProgressChanged(from, computed)) {
    return { kind: 'unchanged', computed };
  }

  return { kind: 'changed', from, to: computed, mismatchType: classifyMismatch(from.userStatus, computed.userStatus) };
}

export interface AutoApplySafetyCheck {
  safe: boolean;
  reason: string;
}

// A 'changed' outcome is still not automatically safe to apply — reuses
// the SAME risk-list episode-release-refresh's own eligibility check
// already consults (isUntrustedNextEpisodeTitle,
// src/common/stale-series-trust.ts) rather than inventing a new
// ambiguity rule. A risk-listed title's next-episode data is not trusted
// by this pipeline anywhere else, so an automated reconciliation write is
// refused here too — routed to manual review instead (see
// run-progress-reconciliation.ts).
export function checkAutoApplySafety(seriesTitle: string): AutoApplySafetyCheck {
  if (isUntrustedNextEpisodeTitle(seriesTitle)) {
    return {
      safe: false,
      reason: `"${seriesTitle}" is on the known episode-numbering/season-shift risk list (src/common/stale-series-trust.ts) — this pipeline does not trust this series' next-episode data enough to auto-apply; needs manual review`,
    };
  }
  return { safe: true, reason: 'no known risk flags for this title' };
}
