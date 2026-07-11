// Pure decision logic for the episode-release-refresh dry-run pipeline. No
// I/O, no Prisma, no TMDb calls — this only ever reasons about data already
// handed to it, same pattern as watch-all-logic.ts/unwatch-logic.ts/
// next-episode-backfill/derive-next-episode.ts. This is the file the
// pipeline's safety guarantees actually live in; run-refresh.ts is just
// wiring (fetch, loop, write files).
//
// See docs/episode-release-refresh-strategy.md §2 for the design this
// implements.

import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { isEpisodeReleased } from '../src/common/is-episode-released';
import { deriveUserStatusFromNextEpisode } from '../src/common/derive-user-status';
import { isUntrustedNextEpisodeTitle } from '../src/common/stale-series-trust';

// --- Candidate eligibility ------------------------------------------------

export type SeriesSkipReason = 'user-status-not-tracked' | 'no-tmdb-id' | 'risk-list';

// WATCHING/CAUGHT_UP/COMPLETED are all "actively relevant" for Phase 1 apply
// — a COMPLETED series can still receive a genuine renewal (a new released
// episode after the provider previously showed nothing left), and that's
// exactly the case Phase 1 apply exists to catch. DROPPED/PAUSED/WATCHLIST
// have explicit personal intent this job must never disturb (excluded from
// candidate selection entirely, not just protected once selected — same
// stricter-than-watch-all posture docs/episode-release-refresh-strategy.md
// §2.4 calls for), and UNKNOWN has no "next episode" concept that applies.
// Exported (not just module-private) so apply-refresh-writes.ts's live
// write-time eligibility re-check can reuse the exact same list rather
// than maintaining its own — the two checks (candidate-selection-time and
// write-time) must never be able to silently drift apart.
export const TRACKED_USER_STATUSES: UserSeriesStatus[] = [UserSeriesStatus.WATCHING, UserSeriesStatus.CAUGHT_UP, UserSeriesStatus.COMPLETED];

// Deliberately NOT gating on Series.releaseStatus (ENDED/CANCELLED) here,
// even though that would be a cheap way to skip an obviously-finished
// series. A series only ever reaches userStatus=COMPLETED because its
// *locally cached* releaseStatus was already ENDED/CANCELLED at some past
// recompute (see deriveUserStatusFromNextEpisode) — and neither this
// dry-run comparison nor Phase 1 apply mode ever writes Series.releaseStatus
// (out of scope by design, see docs/episode-release-refresh-strategy.md).
// So a releaseStatus-based pre-filter would create a permanent,
// self-reinforcing blind spot: the exact "this show got renewed after
// looking finished" case COMPLETED-inclusion exists to catch would always
// be pre-excluded by the very field this job refuses to correct. Safer to
// always fetch and let compareSeriesCatalog's actual episode-list diff
// (independent of either side's releaseStatus) decide whether anything
// changed — a truly-finished show just costs one extra TMDb call and comes
// back NO_CHANGE.
export interface SeriesEligibilityInput {
  userStatus: UserSeriesStatus;
  tmdbId: string | null;
  title: string;
}

export interface SeriesEligibilityResult {
  eligible: boolean;
  reason: SeriesSkipReason | null;
}

// Checked in this exact order because it's also the report's implied
// priority: "not tracked" is the most common/expected reason (most series
// aren't being actively watched), so it's worth surfacing first rather
// than after a wasted risk-list check. No releaseStatus check here at all
// — see the comment on TRACKED_USER_STATUSES above for why.
export function checkSeriesEligibility(input: SeriesEligibilityInput): SeriesEligibilityResult {
  if (!TRACKED_USER_STATUSES.includes(input.userStatus)) {
    return { eligible: false, reason: 'user-status-not-tracked' };
  }
  if (!input.tmdbId) {
    return { eligible: false, reason: 'no-tmdb-id' };
  }
  // Reused unchanged from stale-series-trust.ts (already the read path's
  // "don't trust this series' next-episode data" source) so the "don't
  // trust" list can never drift between the live app and this pipeline.
  if (isUntrustedNextEpisodeTitle(input.title)) {
    return { eligible: false, reason: 'risk-list' };
  }
  return { eligible: true, reason: null };
}

// --- Catalog comparison ----------------------------------------------------

export type RefreshClassification =
  | 'NO_CHANGE'
  | 'NEW_RELEASE_AVAILABLE'
  | 'FUTURE_ONLY'
  | 'NEEDS_MANUAL_REVIEW'
  | 'RISKY_DO_NOT_APPLY'
  | 'SUSPICIOUS_BULK_INSERT'
  | 'SEASON_ZERO_PROPOSED'
  | 'PROVIDER_ERROR'; // never produced by compareSeriesCatalog itself — reserved for run-refresh.ts's fetch-failure path, listed here so callers can share one classification type.

// --- Season 0 guard ---------------------------------------------------------
//
// Phase 1 apply has no dedicated season-0/specials handling or tests —
// confirmed absent as of the Phase 1 pre-apply audit that added this guard
// (a real, live case: One-Punch Man's only proposed released episodes are
// both season 0 — "A Super Serious Look Back!" S0E8 and a season-2
// commemorative special S0E15 — and would have been silently inserted with
// zero review). Blocks the ENTIRE series, not just the season-0 episodes
// within it: Phase 1's write is meant to be one atomic, reviewable unit per
// series, and silently dropping only the season-0 slice while inserting
// the rest would leave a partial result that's harder to audit after the
// fact than a clean, all-or-nothing block. Checked against RELEASED new
// episodes only, same scope buildEpisodeInsertPlan itself would ever write
// — a not-yet-aired season-0 episode doesn't need to block anything today.
export interface SeasonZeroCheck {
  proposesSeasonZero: boolean;
  reason: string | null;
}

export function detectSeasonZeroProposal(releasedNewEpisodes: { seasonNumber: number }[]): SeasonZeroCheck {
  const seasonZeroCount = releasedNewEpisodes.filter((e) => e.seasonNumber === 0).length;
  if (seasonZeroCount === 0) {
    return { proposesSeasonZero: false, reason: null };
  }
  return {
    proposesSeasonZero: true,
    reason: `${seasonZeroCount} proposed released episode(s) are in season 0 (specials) — Phase 1 has no dedicated season-0 handling or tests, so the entire series is blocked rather than silently applying the rest`,
  };
}

// --- Suspicious bulk-insert guard ------------------------------------------
//
// The season-shift guard above only catches a local catalog SHRINKING or
// disappearing relative to the provider. It has no corresponding check for
// the opposite shape: a local catalog that's missing a large chunk the
// provider already has (an incomplete import, a stale partial catalog, or
// a numbering scheme mismatch that happens to manifest as growth rather
// than shrinkage). Confirmed real in this exact database via a prior
// review's dry-run output — e.g. House (86 local vs 176 provider, 90
// "new" episodes across 4 brand-new seasons) and Bungo Stray Dogs (3 local
// vs 60 provider, 57 "new" episodes) both classified NEW_RELEASE_AVAILABLE
// with zero warnings, because no local season ever shrank. Those are
// catalog-completeness gaps, not new releases, and must never be silently
// bulk-inserted the same way one genuine new episode is.
const SUSPICIOUS_BULK_INSERT_ABSOLUTE_THRESHOLD = 10;
const SUSPICIOUS_BULK_INSERT_RELATIVE_LOCAL_MINIMUM = 10;
const SUSPICIOUS_BULK_INSERT_RELATIVE_RATIO = 0.5;

export interface SuspiciousBulkInsertCheck {
  suspicious: boolean;
  reason: string | null;
}

// Two independent triggers, checked in this order only for a stable
// reported reason — either alone is sufficient:
//   1. absolute: more than 10 released episodes proposed in one run,
//      regardless of how large the local catalog already is.
//   2. relative: for a local catalog that already has a meaningful size
//      (>=10 episodes), proposed released inserts exceeding half of it —
//      catches a smaller-scale version of the same gap without penalizing
//      a brand-new, barely-started series (where the relative check would
//      otherwise trigger on almost any first episode).
export function detectSuspiciousBulkInsert(localEpisodeCount: number, releasedNewEpisodeCount: number): SuspiciousBulkInsertCheck {
  if (releasedNewEpisodeCount > SUSPICIOUS_BULK_INSERT_ABSOLUTE_THRESHOLD) {
    return {
      suspicious: true,
      reason: `released new episode count (${releasedNewEpisodeCount}) exceeds the absolute bulk-insert threshold (${SUSPICIOUS_BULK_INSERT_ABSOLUTE_THRESHOLD}) — likely an incomplete local catalog, not a genuine new release`,
    };
  }
  if (localEpisodeCount >= SUSPICIOUS_BULK_INSERT_RELATIVE_LOCAL_MINIMUM && releasedNewEpisodeCount > localEpisodeCount * SUSPICIOUS_BULK_INSERT_RELATIVE_RATIO) {
    return {
      suspicious: true,
      reason: `released new episode count (${releasedNewEpisodeCount}) exceeds ${Math.round(SUSPICIOUS_BULK_INSERT_RELATIVE_RATIO * 100)}% of the local episode count (${localEpisodeCount}) — likely an incomplete local catalog, not a genuine new release`,
    };
  }
  return { suspicious: false, reason: null };
}

export interface LocalEpisodeInput {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  overview: string | null;
  airDate: Date | null;
  imageUrl: string | null;
  runtimeMinutes: number | null;
  watched: boolean;
}

export interface ProviderEpisodeInput {
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  overview: string | null;
  airDate: Date | null;
  imageUrl: string | null;
  runtimeMinutes: number | null;
}

export interface CompareSeriesCatalogInput {
  localEpisodes: LocalEpisodeInput[];
  providerEpisodes: ProviderEpisodeInput[];
  currentReleaseStatus: ReleaseStatus;
  providerReleaseStatus: ReleaseStatus;
  currentUserStatus: UserSeriesStatus;
  currentNextEpisodeId: string | null;
  now?: Date;
}

export interface NewEpisodeFound {
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  airDate: Date | null;
  released: boolean;
}

export interface EpisodeFieldChange {
  episodeId: string;
  seasonNumber: number;
  episodeNumber: number;
  changedFields: string[];
}

export interface ReleaseStatusChange {
  from: ReleaseStatus;
  to: ReleaseStatus;
}

export interface CompareSeriesCatalogResult {
  classification: RefreshClassification;
  // Always computed and returned regardless of final classification (same
  // "always computed for reporting" posture as warnings/fieldChanges below)
  // — non-null exactly when detectSuspiciousBulkInsert found a trigger,
  // even if a different, higher-priority classification (e.g.
  // RISKY_DO_NOT_APPLY) ultimately won.
  bulkInsertReason: string | null;
  // Same "always computed" posture — non-null exactly when
  // detectSeasonZeroProposal found a released season-0 episode among the
  // proposed new episodes, even if a different classification ultimately won.
  seasonZeroReason: string | null;
  warnings: string[];
  newEpisodes: NewEpisodeFound[];
  releasedNewEpisodeCount: number;
  futureNewEpisodeCount: number;
  fieldChanges: EpisodeFieldChange[];
  releaseStatusChange: ReleaseStatusChange | null;
  // The episode id an apply step would set nextEpisodeId to, IF it already
  // exists locally (i.e. the proposed next episode is not itself a new,
  // not-yet-created episode). null when the proposed next is a brand new
  // episode (no id exists yet to report) or there is no next episode at all
  // — proposedNextEpisodeLabel/proposedNextEpisodeIsNew disambiguate those
  // two null cases.
  proposedNextEpisodeId: string | null;
  proposedNextEpisodeLabel: string | null; // e.g. "S4E2", for both existing and new proposed-next cases
  proposedNextEpisodeIsNew: boolean;
  // Structured (seasonNumber, episodeNumber) for the proposed-next slot,
  // non-null whenever proposedNextEpisodeLabel is non-null (existing or
  // new alike) — lets a caller resolve the real row id for a NEW proposed
  // next episode once it's actually been created elsewhere (e.g. by
  // library-health's catalog-reconciliation capability), without having to
  // re-parse proposedNextEpisodeLabel's display string.
  proposedNextSeasonNumber: number | null;
  proposedNextEpisodeNumber: number | null;
  nextEpisodeWouldChange: boolean;
  proposedUserStatus: UserSeriesStatus;
  userStatusWouldChangeToWatching: boolean;
}

function episodeKey(seasonNumber: number, episodeNumber: number): string {
  return `${seasonNumber}:${episodeNumber}`;
}

function episodeLabel(seasonNumber: number, episodeNumber: number): string {
  return `S${seasonNumber}E${episodeNumber}`;
}

function fieldsDiffer<T>(a: T, b: T): boolean {
  if (a instanceof Date || b instanceof Date) {
    const aTime = a instanceof Date ? a.getTime() : null;
    const bTime = b instanceof Date ? b.getTime() : null;
    return aTime !== bTime;
  }
  return a !== b;
}

// Compares one series' local (DB) catalog against a freshly-fetched
// provider catalog and decides what, if anything, an apply step would do —
// without doing any of it. See docs/episode-release-refresh-strategy.md
// §2.3 for the algorithm this implements; the safety-gate ordering below
// (season-shift check first, alignment check second, new-episode
// classification last) mirrors that doc's step numbering exactly.
export function compareSeriesCatalog(input: CompareSeriesCatalogInput): CompareSeriesCatalogResult {
  const now = input.now ?? new Date();
  const warnings: string[] = [];

  const localByKey = new Map<string, LocalEpisodeInput>();
  const localCountBySeason = new Map<number, number>();
  for (const ep of input.localEpisodes) {
    localByKey.set(episodeKey(ep.seasonNumber, ep.episodeNumber), ep);
    localCountBySeason.set(ep.seasonNumber, (localCountBySeason.get(ep.seasonNumber) ?? 0) + 1);
  }

  const providerByKey = new Map<string, ProviderEpisodeInput>();
  const providerCountBySeason = new Map<number, number>();
  for (const ep of input.providerEpisodes) {
    providerByKey.set(episodeKey(ep.seasonNumber, ep.episodeNumber), ep);
    providerCountBySeason.set(ep.seasonNumber, (providerCountBySeason.get(ep.seasonNumber) ?? 0) + 1);
  }

  // --- Step 1: season-shift / suspicious-count guard (docs §2.3 step 2) ---
  // A season shrinking, or disappearing outright, from the provider's
  // response relative to what MyTv already has on file is exactly the
  // signature of a numbering collision (e.g. Jujutsu Kaisen's 3-season
  // local catalog vs. TMDb's single absolute-numbered season) — this must
  // never be treated as "episodes were removed," only ever reported.
  let seasonShiftDetected = false;
  for (const [seasonNumber, localCount] of localCountBySeason) {
    const providerCount = providerCountBySeason.get(seasonNumber);
    if (providerCount === undefined) {
      seasonShiftDetected = true;
      warnings.push(`season ${seasonNumber} (${localCount} local episode(s)) is missing entirely from the provider response`);
    } else if (providerCount < localCount) {
      seasonShiftDetected = true;
      warnings.push(`season ${seasonNumber} shrank: ${localCount} local episode(s) vs. ${providerCount} from the provider`);
    }
  }

  // --- Step 2: watched-episode alignment guard (docs §2.3 step 2) --------
  // Independent of the season-level check above: even if season episode
  // counts still line up, an individual WATCHED episode's slot no longer
  // existing on the provider's side is still a numbering mismatch — the
  // provider's "next episode" could actually duplicate content already
  // watched under a different season/episode number.
  const misalignedWatchedEpisodes: LocalEpisodeInput[] = [];
  for (const ep of input.localEpisodes) {
    if (!ep.watched) continue;
    if (!providerByKey.has(episodeKey(ep.seasonNumber, ep.episodeNumber))) {
      misalignedWatchedEpisodes.push(ep);
    }
  }
  for (const ep of misalignedWatchedEpisodes) {
    warnings.push(`watched episode ${episodeLabel(ep.seasonNumber, ep.episodeNumber)} (id ${ep.id}) has no matching slot in the provider's current catalog`);
  }

  // --- Step 3: diff for reporting (always computed, even when risky/needs
  // review, purely for visibility — never used to justify writing anything
  // when classification ends up RISKY_DO_NOT_APPLY/NEEDS_MANUAL_REVIEW) ---
  const newEpisodes: NewEpisodeFound[] = [];
  for (const [key, providerEp] of providerByKey) {
    if (localByKey.has(key)) continue;
    newEpisodes.push({
      seasonNumber: providerEp.seasonNumber,
      episodeNumber: providerEp.episodeNumber,
      title: providerEp.title,
      airDate: providerEp.airDate,
      released: isEpisodeReleased(providerEp.airDate, now),
    });
  }
  newEpisodes.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  const releasedNewEpisodeCount = newEpisodes.filter((e) => e.released).length;
  const futureNewEpisodeCount = newEpisodes.length - releasedNewEpisodeCount;

  const fieldChanges: EpisodeFieldChange[] = [];
  for (const [key, localEp] of localByKey) {
    const providerEp = providerByKey.get(key);
    if (!providerEp) continue; // already reported as a missing/shifted slot above
    const changedFields: string[] = [];
    if (fieldsDiffer(localEp.title, providerEp.title)) changedFields.push('title');
    if (fieldsDiffer(localEp.overview, providerEp.overview)) changedFields.push('overview');
    if (fieldsDiffer(localEp.airDate, providerEp.airDate)) changedFields.push('airDate');
    if (fieldsDiffer(localEp.imageUrl, providerEp.imageUrl)) changedFields.push('imageUrl');
    if (fieldsDiffer(localEp.runtimeMinutes, providerEp.runtimeMinutes)) changedFields.push('runtimeMinutes');
    if (changedFields.length > 0) {
      fieldChanges.push({ episodeId: localEp.id, seasonNumber: localEp.seasonNumber, episodeNumber: localEp.episodeNumber, changedFields });
    }
  }

  const releaseStatusChange: ReleaseStatusChange | null =
    input.currentReleaseStatus !== input.providerReleaseStatus
      ? { from: input.currentReleaseStatus, to: input.providerReleaseStatus }
      : null;

  // --- Step 4: hypothetical nextEpisodeId/userStatus, "as if applied" ----
  // Merges local + provider-only (new) episodes into one ordered catalog
  // and finds the first unwatched, released slot — the exact same rule
  // findFirstUnwatchedEpisodeId uses live, just fed a hypothetical merged
  // catalog instead of only what's already in the DB.
  type MergedSlot = { seasonNumber: number; episodeNumber: number; airDate: Date | null; watched: boolean; localId: string | null };
  const merged = new Map<string, MergedSlot>();
  for (const [key, ep] of localByKey) {
    merged.set(key, { seasonNumber: ep.seasonNumber, episodeNumber: ep.episodeNumber, airDate: ep.airDate, watched: ep.watched, localId: ep.id });
  }
  for (const [key, ep] of providerByKey) {
    if (merged.has(key)) continue;
    merged.set(key, { seasonNumber: ep.seasonNumber, episodeNumber: ep.episodeNumber, airDate: ep.airDate, watched: false, localId: null });
  }
  const orderedMerged = [...merged.values()].sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  const proposedNext = orderedMerged.find((slot) => !slot.watched && isEpisodeReleased(slot.airDate, now)) ?? null;

  const proposedNextEpisodeId = proposedNext?.localId ?? null;
  const proposedNextEpisodeLabel = proposedNext ? episodeLabel(proposedNext.seasonNumber, proposedNext.episodeNumber) : null;
  const proposedNextEpisodeIsNew = proposedNext !== null && proposedNext.localId === null;
  const proposedNextSeasonNumber = proposedNext?.seasonNumber ?? null;
  const proposedNextEpisodeNumber = proposedNext?.episodeNumber ?? null;
  const nextEpisodeWouldChange = proposedNext === null ? input.currentNextEpisodeId !== null : proposedNextEpisodeId !== input.currentNextEpisodeId || proposedNextEpisodeIsNew;

  const proposedUserStatus = deriveUserStatusFromNextEpisode(proposedNext !== null, input.providerReleaseStatus);
  const userStatusWouldChangeToWatching = input.currentUserStatus === UserSeriesStatus.CAUGHT_UP && proposedUserStatus === UserSeriesStatus.WATCHING;

  // --- Step 4.5: season-0 and suspicious bulk-insert guards (always
  // computed, same "compute regardless of which classification wins"
  // posture as warnings above) ------------------------------------------
  const seasonZeroCheck = detectSeasonZeroProposal(newEpisodes.filter((e) => e.released));
  const bulkInsertCheck = detectSuspiciousBulkInsert(input.localEpisodes.length, releasedNewEpisodeCount);

  // --- Step 5: classify (docs §3, safety-gate priority order) -----------
  let classification: RefreshClassification;
  if (seasonShiftDetected) {
    classification = 'RISKY_DO_NOT_APPLY';
  } else if (misalignedWatchedEpisodes.length > 0) {
    classification = 'NEEDS_MANUAL_REVIEW';
  } else if (seasonZeroCheck.proposesSeasonZero) {
    classification = 'SEASON_ZERO_PROPOSED';
  } else if (bulkInsertCheck.suspicious) {
    classification = 'SUSPICIOUS_BULK_INSERT';
  } else if (releasedNewEpisodeCount > 0) {
    classification = 'NEW_RELEASE_AVAILABLE';
  } else if (futureNewEpisodeCount > 0) {
    classification = 'FUTURE_ONLY';
  } else {
    // No new episodes either way — field/release-status changes are still
    // surfaced in the report (fieldChanges/releaseStatusChange), but don't
    // by themselves make this "a meaningful change" for classification
    // purposes: nothing about what the user should watch next moved.
    classification = 'NO_CHANGE';
  }

  return {
    classification,
    bulkInsertReason: bulkInsertCheck.reason,
    seasonZeroReason: seasonZeroCheck.reason,
    warnings,
    newEpisodes,
    releasedNewEpisodeCount,
    futureNewEpisodeCount,
    fieldChanges,
    releaseStatusChange,
    proposedNextEpisodeId,
    proposedNextEpisodeLabel,
    proposedNextEpisodeIsNew,
    proposedNextSeasonNumber,
    proposedNextEpisodeNumber,
    nextEpisodeWouldChange,
    proposedUserStatus,
    userStatusWouldChangeToWatching,
  };
}

// --- Misc pure helper ------------------------------------------------------

// TMDb's append_to_response caps at MAX_APPEND_TO_RESPONSE_ITEMS namespaces
// per call (see tmdb-enrichment/tmdb-client.ts) — a series with more
// seasons than that needs its season fetch split into multiple calls.
export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunkArray: size must be positive, got ${size}`);
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
