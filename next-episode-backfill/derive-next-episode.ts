// Pure decision logic for the one-time UserSeriesProgress.nextEpisodeId
// backfill (next-episode-backfill/run-backfill.ts). No I/O, no Prisma
// calls, no TMDb — this only ever reasons about data already handed to it,
// which is what makes it unit-testable and auditable on its own.
//
// Reuses deriveUserStatusFromNextEpisode (src/common/derive-user-status.ts)
// for the "no next episode -> CAUGHT_UP or COMPLETED" call, rather than
// reimplementing the ENDED/CANCELLED check here — that function is already
// the app's single source of truth for this exact rule (markWatched calls
// it too), and diverging from it here would let this backfill and the live
// mark-watched flow disagree about what "finished" means for the same
// releaseStatus value. Same reasoning for isEpisodeReleased
// (src/common/is-episode-released.ts): a not-yet-aired episode must never
// be treated as "next" here either, or this backfill could write a
// nextEpisodeId the live mark-watched flow would refuse to produce.

import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { deriveUserStatusFromNextEpisode } from '../src/common/derive-user-status';
import { isEpisodeReleased } from '../src/common/is-episode-released';

// Statuses this backfill never touches at all — DROPPED/PAUSED are
// user-controlled personal intent (never overridden by any automated pass,
// same rule as TMDb enrichment apply); WATCHLIST/COMPLETED/UNKNOWN have no
// "next episode to watch" concept that applies to them (WATCHLIST/UNKNOWN:
// no watch activity yet: COMPLETED: nothing left by definition).
const SKIPPED_USER_STATUSES: UserSeriesStatus[] = [
  UserSeriesStatus.DROPPED,
  UserSeriesStatus.PAUSED,
  UserSeriesStatus.WATCHLIST,
  UserSeriesStatus.COMPLETED,
  UserSeriesStatus.UNKNOWN,
];

export type NextEpisodeAction =
  | 'skip'
  | 'unchanged-incomplete-catalog'
  | 'set-next-episode'
  | 'mark-caught-up'
  | 'mark-completed'
  | 'no-op-up-to-date';

export interface NextEpisodeDecision {
  action: NextEpisodeAction;
  // The value that SHOULD be written to nextEpisodeId. null means "no
  // change to nextEpisodeId" for 'skip'/'unchanged-incomplete-catalog'/
  // 'no-op-up-to-date', and "explicitly clear it" for 'mark-caught-up'/
  // 'mark-completed'.
  nextEpisodeId: string | null;
  // null means "no change to userStatus".
  newUserStatus: UserSeriesStatus | null;
  reason: string;
}

export interface OrderedEpisode {
  id: string;
  // Null is treated as "not released yet" — see
  // src/common/is-episode-released.ts for why that's the conservative
  // choice rather than assuming a missing date means already aired.
  airDate: Date | null;
}

export interface DeriveNextEpisodeInput {
  currentUserStatus: UserSeriesStatus;
  releaseStatus: ReleaseStatus;
  // Whether this series has a confirmed TMDb match (ExternalIds.tmdbId set)
  // — the same signal the TMDb enrichment apply used to decide a series'
  // episode list is a real, complete catalog rather than just "whatever TV
  // Time happened to mention." Without this, "no unwatched episode found"
  // could just mean "MyTv only knows about episodes the user already
  // watched," which is not the same as being caught up.
  hasFullCatalog: boolean;
  // Every episode in this series, already sorted by (seasonNumber,
  // episodeNumber) ascending — sorting is the caller's job (a DB query
  // concern), not this function's.
  orderedEpisodes: OrderedEpisode[];
  watchedEpisodeIds: ReadonlySet<string>;
}

export function deriveNextEpisodeUpdate(input: DeriveNextEpisodeInput): NextEpisodeDecision {
  if (SKIPPED_USER_STATUSES.includes(input.currentUserStatus)) {
    return {
      action: 'skip',
      nextEpisodeId: null,
      newUserStatus: null,
      reason: `current userStatus is ${input.currentUserStatus} — this backfill only ever touches WATCHING/CAUGHT_UP rows`,
    };
  }

  // Only WATCHING and CAUGHT_UP reach here.
  if (!input.hasFullCatalog) {
    return {
      action: 'unchanged-incomplete-catalog',
      nextEpisodeId: null,
      newUserStatus: null,
      reason: 'no full episode catalog known for this series (no ExternalIds.tmdbId) — MyTv only knows about episodes already watched, so "no unwatched episode found" would not be a safe signal; left unchanged',
    };
  }

  // Not-yet-aired episodes are never a valid "next episode" — a future
  // airDate (or a null one, treated the same conservative way) means this
  // episode isn't watchable yet, so it's skipped exactly like an already-
  // watched one for this lookup's purposes.
  const nextEpisode = input.orderedEpisodes.find((e) => !input.watchedEpisodeIds.has(e.id) && isEpisodeReleased(e.airDate));

  if (nextEpisode) {
    // deriveUserStatusFromNextEpisode(true, ...) always returns WATCHING —
    // reused here rather than hardcoding it so this can never drift from
    // markWatched's rule for "a next episode exists." Only actually
    // proposed as a userStatus CHANGE when the row wasn't already WATCHING:
    // a WATCHING row finding its next episode isn't a transition, but a
    // CAUGHT_UP row finding one IS — per docs/status-model-plan.md §4,
    // caught_up is only a valid state while nextEpisodeId is null, so a
    // CAUGHT_UP row that now has a real next episode must become WATCHING,
    // exactly like every other "next episode found" case in this app.
    const derivedStatus = deriveUserStatusFromNextEpisode(true, input.releaseStatus);
    const newUserStatus = input.currentUserStatus === derivedStatus ? null : derivedStatus;

    return {
      action: 'set-next-episode',
      nextEpisodeId: nextEpisode.id,
      newUserStatus,
      reason:
        newUserStatus === null
          ? `found the next unwatched episode (${nextEpisode.id}) in seasonNumber/episodeNumber order`
          : `found a newly available unwatched episode (${nextEpisode.id}) — moving ${input.currentUserStatus} to ${newUserStatus}, since caught_up is only valid while nextEpisodeId is null`,
    };
  }

  // No unwatched-AND-released episode remains, and the full catalog is
  // known. This covers two distinct real situations identically, on
  // purpose: genuinely nothing left unwatched, OR everything left unwatched
  // is a future/unreleased episode (e.g. an announced-but-unaired episode
  // of a RETURNING show). Either way, there's nothing watchable right now,
  // so the outcome is the same: CAUGHT_UP (or COMPLETED), never a
  // nextEpisodeId pointing at something the user can't actually watch yet.
  if (input.currentUserStatus === UserSeriesStatus.CAUGHT_UP) {
    // "Keep nextEpisodeId null unless a newly available episode exists" —
    // it doesn't. Nothing to do; userStatus is untouched (already correct).
    return {
      action: 'no-op-up-to-date',
      nextEpisodeId: null,
      newUserStatus: null,
      reason: 'already CAUGHT_UP and no newly available (unwatched and already-aired) episode exists — nothing to change',
    };
  }

  // currentUserStatus === WATCHING, full catalog known, nothing left that's
  // both unwatched and already aired: derive CAUGHT_UP vs COMPLETED exactly
  // the way markWatched already does for this same situation.
  const derivedStatus = deriveUserStatusFromNextEpisode(false, input.releaseStatus);

  if (derivedStatus === UserSeriesStatus.COMPLETED) {
    return {
      action: 'mark-completed',
      nextEpisodeId: null,
      newUserStatus: UserSeriesStatus.COMPLETED,
      reason: `full episode catalog known, no unwatched-and-aired episodes remain, and releaseStatus (${input.releaseStatus}) is finished — moving WATCHING to COMPLETED`,
    };
  }

  return {
    action: 'mark-caught-up',
    nextEpisodeId: null,
    newUserStatus: UserSeriesStatus.CAUGHT_UP,
    reason: `full episode catalog known, no unwatched-and-aired episodes remain, and releaseStatus (${input.releaseStatus}) is not finished — moving WATCHING to CAUGHT_UP`,
  };
}
