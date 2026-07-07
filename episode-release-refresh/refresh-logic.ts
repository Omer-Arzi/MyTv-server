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

export type SeriesSkipReason = 'user-status-not-tracked' | 'no-tmdb-id' | 'risk-list' | 'release-status-finished';

// Only WATCHING/CAUGHT_UP are "actively relevant" — DROPPED/PAUSED/WATCHLIST
// have explicit personal intent this job must never disturb (excluded from
// candidate selection entirely, not just protected once selected — same
// stricter-than-watch-all posture docs/episode-release-refresh-strategy.md
// §2.4 calls for), and UNKNOWN/COMPLETED have no "next episode" concept
// that applies (COMPLETED: nothing left by definition; not inspected
// separately per the task's own scope — there is no explicit reason to).
const TRACKED_USER_STATUSES: UserSeriesStatus[] = [UserSeriesStatus.WATCHING, UserSeriesStatus.CAUGHT_UP];

// A series already known to be over cannot have anything new to discover —
// cheap filter, avoids a wasted TMDb call.
const FINISHED_RELEASE_STATUSES: ReleaseStatus[] = [ReleaseStatus.ENDED, ReleaseStatus.CANCELLED];

export interface SeriesEligibilityInput {
  userStatus: UserSeriesStatus;
  tmdbId: string | null;
  title: string;
  releaseStatus: ReleaseStatus;
}

export interface SeriesEligibilityResult {
  eligible: boolean;
  reason: SeriesSkipReason | null;
}

// Checked in this exact order because it's also the report's implied
// priority: "not tracked" is the most common/expected reason (most series
// aren't being actively watched), so it's worth surfacing first rather
// than after a wasted risk-list/finished-status check.
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
  if (FINISHED_RELEASE_STATUSES.includes(input.releaseStatus)) {
    return { eligible: false, reason: 'release-status-finished' };
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
  | 'PROVIDER_ERROR'; // never produced by compareSeriesCatalog itself — reserved for run-refresh.ts's fetch-failure path, listed here so callers can share one classification type.

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
  const nextEpisodeWouldChange = proposedNext === null ? input.currentNextEpisodeId !== null : proposedNextEpisodeId !== input.currentNextEpisodeId || proposedNextEpisodeIsNew;

  const proposedUserStatus = deriveUserStatusFromNextEpisode(proposedNext !== null, input.providerReleaseStatus);
  const userStatusWouldChangeToWatching = input.currentUserStatus === UserSeriesStatus.CAUGHT_UP && proposedUserStatus === UserSeriesStatus.WATCHING;

  // --- Step 5: classify (docs §3, safety-gate priority order) -----------
  let classification: RefreshClassification;
  if (seasonShiftDetected) {
    classification = 'RISKY_DO_NOT_APPLY';
  } else if (misalignedWatchedEpisodes.length > 0) {
    classification = 'NEEDS_MANUAL_REVIEW';
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
    warnings,
    newEpisodes,
    releasedNewEpisodeCount,
    futureNewEpisodeCount,
    fieldChanges,
    releaseStatusChange,
    proposedNextEpisodeId,
    proposedNextEpisodeLabel,
    proposedNextEpisodeIsNew,
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
