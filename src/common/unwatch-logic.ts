// Pure decision logic for DELETE /episode-watches/:watchId (unwatch). No I/O
// — testable without a database, same pattern as watch-all-logic.ts and
// derive-user-status.ts.

import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { deriveUserStatusFromNextEpisode } from './derive-user-status';
import { findFirstUnwatchedEpisodeId, OrderedEpisodeForNextLookup } from '../modules/series/series-query-helpers';

export interface CheckUnwatchAllowedInput {
  hasNote: boolean;
  hasRating: boolean;
  hasEmotion: boolean;
  force: boolean;
}

export interface CheckUnwatchAllowedResult {
  allowed: boolean;
  reason: string;
}

// Conservative-by-default: a watch carrying a note, rating, or emotion
// reaction is user-authored content, not just a timestamp — refuse to
// remove it silently. A note is genuinely deleted by the cascade on
// EpisodeWatch removal; ratings/emotions are keyed by (userId, episodeId),
// not the watch itself, so they actually survive the delete — but blocking
// on them too (rather than only on the note) is the conservative choice
// the task calls for: an orphaned rating/emotion on an episode that's no
// longer marked watched is still a surprising state to leave the user in
// without their explicit say-so via force=true.
export function checkUnwatchAllowed(input: CheckUnwatchAllowedInput): CheckUnwatchAllowedResult {
  const attached: string[] = [];
  if (input.hasNote) attached.push('a note');
  if (input.hasRating) attached.push('a rating');
  if (input.hasEmotion) attached.push('an emotion reaction');

  if (attached.length > 0 && !input.force) {
    return {
      allowed: false,
      reason: `this watch has ${attached.join(', ')} attached — pass force=true to unwatch anyway`,
    };
  }
  return { allowed: true, reason: 'ok' };
}

// DROPPED/PAUSED are explicit personal intent (docs/status-model-plan.md
// §2/§7a; watch-all-logic.ts's PROTECTED_STATUSES already establishes this
// exact rule for the mark-all-watched escape hatch) — an unwatch action
// must never silently move a series out of one of these two states or
// change what it thinks "next" is. Unlike watch-all, there's no force
// override here: force on this endpoint only ever concerns attached user
// content (see checkUnwatchAllowed above), never protected-status
// overriding — "if unsure, preserve" per the task's own instruction.
const PROTECTED_STATUSES: UserSeriesStatus[] = [UserSeriesStatus.DROPPED, UserSeriesStatus.PAUSED];

export interface RecomputeProgressAfterUnwatchInput {
  releaseStatus: ReleaseStatus;
  currentUserStatus: UserSeriesStatus;
  // Every episode in the series, sorted by (seasonNumber, episodeNumber) —
  // same full-catalog requirement as recomputeProgressAfterWatchAll.
  orderedEpisodes: OrderedEpisodeForNextLookup[];
  // The watched-episode-id set AFTER the target watch has been removed.
  watchedEpisodeIdsAfterRemoval: ReadonlySet<string>;
  now?: Date;
}

export interface RecomputeProgressAfterUnwatchResult {
  // Whether a released, unwatched episode exists at all — reported
  // regardless of statusPreserved, since it's a fact about the episode
  // catalog, not a personal-status decision.
  hasRemainingReleasedUnwatched: boolean;
  // What nextEpisodeId/userStatus WOULD be under the normal derivation —
  // the caller only actually persists/reports these when statusPreserved
  // is false; when true it keeps whatever was already stored.
  computedNextEpisodeId: string | null;
  computedUserStatus: UserSeriesStatus;
  // True when currentUserStatus was DROPPED/PAUSED and this recompute
  // therefore did NOT touch nextEpisodeId/userStatus.
  statusPreserved: boolean;
}

export function recomputeProgressAfterUnwatch(input: RecomputeProgressAfterUnwatchInput): RecomputeProgressAfterUnwatchResult {
  const computedNextEpisodeId = findFirstUnwatchedEpisodeId(input.orderedEpisodes, input.watchedEpisodeIdsAfterRemoval, input.now);
  const hasRemainingReleasedUnwatched = computedNextEpisodeId !== null;

  if (PROTECTED_STATUSES.includes(input.currentUserStatus)) {
    return {
      hasRemainingReleasedUnwatched,
      computedNextEpisodeId,
      computedUserStatus: input.currentUserStatus,
      statusPreserved: true,
    };
  }

  return {
    hasRemainingReleasedUnwatched,
    computedNextEpisodeId,
    computedUserStatus: deriveUserStatusFromNextEpisode(hasRemainingReleasedUnwatched, input.releaseStatus),
    statusPreserved: false,
  };
}
