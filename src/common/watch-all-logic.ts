// Pure decision logic for the "mark all released episodes watched" manual
// escape hatch (POST /seasons/:seasonId/watch-all and
// POST /series/:seriesId/watch-all-released). No I/O — testable without a
// database, same pattern as every other decision module in this repo
// (is-episode-released.ts, derive-user-status.ts, series-query-helpers.ts).
//
// This is deliberately NOT a fix for provider-numbering/duplicate-episode
// mismatches (see docs/episode-numbering-and-season-shift-risk.md) — it's a
// manual override for when the user already knows they've watched
// everything actually released and wants to skip per-episode cleanup.

import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { isEpisodeReleased } from './is-episode-released';
import { deriveUserStatusFromNextEpisode } from './derive-user-status';
import { findFirstUnwatchedEpisodeId, OrderedEpisodeForNextLookup } from '../modules/series/series-query-helpers';

export interface WatchAllEpisodeInput {
  id: string;
  airDate: Date | null;
  alreadyWatched: boolean;
}

export interface WatchAllPlan {
  toCreate: string[];
  alreadyWatched: string[];
  skippedFuture: string[];
  skippedUnknownAirDate: string[];
}

export interface PlanWatchAllOptions {
  includeUnknownAirDate: boolean;
}

// Decides which of the given episodes should get a new EpisodeWatch row.
// By default a null airDate is excluded (same conservative default as
// isEpisodeReleased elsewhere in the app: there's no way to tell "aired,
// date just missing" from "not aired yet") — includeUnknownAirDate is an
// explicit, request-scoped override for this one action only; it does not
// change how "released" is determined anywhere else (see
// recomputeProgressAfterWatchAll below, which always uses the standard
// conservative rule regardless of this option).
export function planWatchAll(episodes: WatchAllEpisodeInput[], options: PlanWatchAllOptions, now: Date = new Date()): WatchAllPlan {
  const toCreate: string[] = [];
  const alreadyWatched: string[] = [];
  const skippedFuture: string[] = [];
  const skippedUnknownAirDate: string[] = [];

  for (const ep of episodes) {
    if (ep.airDate === null) {
      if (!options.includeUnknownAirDate) {
        skippedUnknownAirDate.push(ep.id);
        continue;
      }
      // includeUnknownAirDate=true: treated as eligible for this action
      // specifically, per explicit user request — falls through below.
    } else if (!isEpisodeReleased(ep.airDate, now)) {
      skippedFuture.push(ep.id);
      continue;
    }

    if (ep.alreadyWatched) {
      alreadyWatched.push(ep.id);
    } else {
      toCreate.push(ep.id);
    }
  }

  return { toCreate, alreadyWatched, skippedFuture, skippedUnknownAirDate };
}

export interface RecomputeProgressInput {
  releaseStatus: ReleaseStatus;
  // Every episode in the series (not just the season/batch being marked),
  // sorted by (seasonNumber, episodeNumber) — a mark-all scoped to one
  // season must still recompute the series' overall next-episode/status
  // against its full catalog.
  orderedEpisodes: OrderedEpisodeForNextLookup[];
  // The full watched-episode-id set AFTER this action's new watches are
  // included.
  watchedEpisodeIds: ReadonlySet<string>;
  now?: Date;
}

export interface RecomputeProgressResult {
  nextEpisodeId: string | null;
  userStatus: UserSeriesStatus; // WATCHING | CAUGHT_UP | COMPLETED
}

// Always uses the standard, conservative isEpisodeReleased rule (via
// findFirstUnwatchedEpisodeId) regardless of this request's
// includeUnknownAirDate option — that option only ever affects which
// episodes get marked watched in THIS action, never what counts as
// "released" when deciding what to recommend next.
export function recomputeProgressAfterWatchAll(input: RecomputeProgressInput): RecomputeProgressResult {
  const nextEpisodeId = findFirstUnwatchedEpisodeId(input.orderedEpisodes, input.watchedEpisodeIds, input.now);
  const userStatus = deriveUserStatusFromNextEpisode(!!nextEpisodeId, input.releaseStatus);
  return { nextEpisodeId, userStatus };
}

export interface CheckWatchAllAllowedInput {
  currentUserStatus: UserSeriesStatus;
  force: boolean;
}

export interface CheckWatchAllAllowedResult {
  allowed: boolean;
  reason: string;
}

// DROPPED/PAUSED are explicit personal intent (docs/status-model-plan.md
// §2/§7a already establishes this exact rule for TMDb enrichment apply —
// applied here identically): a mark-all action must never silently override
// them. WATCHLIST is deliberately NOT protected here — marking episodes
// watched for a watchlisted (not-yet-started) series is a stranger request
// but not a destructive one, and the resulting status will correctly become
// WATCHING/CAUGHT_UP/COMPLETED based on what's actually watched.
const PROTECTED_STATUSES: UserSeriesStatus[] = [UserSeriesStatus.DROPPED, UserSeriesStatus.PAUSED];

export function checkWatchAllAllowed(input: CheckWatchAllAllowedInput): CheckWatchAllAllowedResult {
  if (PROTECTED_STATUSES.includes(input.currentUserStatus) && !input.force) {
    return {
      allowed: false,
      reason: `current userStatus is ${input.currentUserStatus} — pass force=true to mark episodes watched anyway`,
    };
  }
  return { allowed: true, reason: 'ok' };
}
