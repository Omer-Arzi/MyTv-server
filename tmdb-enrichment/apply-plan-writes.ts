// Pure functions computing WHAT would be written for a candidate, given its
// already-fetched TMDb data — no Prisma calls happen in this file. Kept
// separate from apply-plan.ts's I/O so "what does an apply do to this
// series" is unit-testable without a database, and so the exact same
// computation backs both the dry-run report and the real apply (one
// function, not two copies that could drift).

import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { extractTitleYearHint } from '../trakt-enrichment/scoring';

export const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/original';

export function tmdbImageUrl(path: string | null | undefined): string | null {
  return path ? `${TMDB_IMAGE_BASE_URL}${path}` : null;
}

// A user's userStatus that an enrichment apply must never override — same
// three statuses the task calls out explicitly. Deliberately a superset of
// derive-user-status.ts's PROTECTED_USER_STATUSES (DROPPED/PAUSED only):
// that list governs what the dry-run *preview* computes as
// proposedUserStatusAfterEnrichment, this one governs what the *apply* step
// is allowed to write, and the apply step adds WATCHLIST as a second,
// independent guard — even though no candidate in a correctly-generated
// plan should ever have currentUserStatus=WATCHLIST with a non-WATCHLIST
// proposal, checking the LIVE status here protects against staleness (the
// user could have changed it between plan generation and apply).
const APPLY_PROTECTED_USER_STATUSES: UserSeriesStatus[] = [UserSeriesStatus.DROPPED, UserSeriesStatus.PAUSED, UserSeriesStatus.WATCHLIST];

export interface UserStatusDecision {
  shouldUpdate: boolean;
  reason: string;
}

// Always checked against the LIVE userStatus read at apply time, not the
// plan's currentUserStatus snapshot — see APPLY_PROTECTED_USER_STATUSES.
export function decideUserStatusUpdate(currentLiveStatus: UserSeriesStatus, proposedUserStatus: UserSeriesStatus): UserStatusDecision {
  if (APPLY_PROTECTED_USER_STATUSES.includes(currentLiveStatus)) {
    return {
      shouldUpdate: false,
      reason: `current live userStatus is ${currentLiveStatus} (protected) — enrichment apply never overrides DROPPED/PAUSED/WATCHLIST`,
    };
  }
  if (currentLiveStatus === proposedUserStatus) {
    return { shouldUpdate: false, reason: `already at ${proposedUserStatus} — no-op` };
  }
  return { shouldUpdate: true, reason: `updating userStatus from ${currentLiveStatus} to ${proposedUserStatus} per the apply plan` };
}

// MyTv's TV-Time-derived titles sometimes carry a "(YYYY)" disambiguation
// suffix (added only so two same-titled imports could be told apart before
// any TMDb match existed — docs/tvtime-data-audit.md). Once a series has a
// confirmed ExternalIds.tmdbId, that suffix has no further purpose and the
// canonical bare title reads better everywhere the title is displayed. This
// is the ONLY title change this apply step makes — it never overwrites a
// title with TMDb's title outright (TMDb's casing/subtitle conventions
// often differ stylistically, e.g. "BLUE EYE SAMURAI" vs "Blue Eye
// Samurai", and that's not this apply step's job to reconcile).
export interface SeriesTitleUpdate {
  newTitle: string | null; // null = no change
  reason: string;
}

export function computeSeriesTitleUpdate(currentTitle: string): SeriesTitleUpdate {
  const hint = extractTitleYearHint(currentTitle);
  if (hint.titleYear === null) {
    return { newTitle: null, reason: 'title has no disambiguating year suffix — left unchanged' };
  }
  return {
    newTitle: hint.bareTitle,
    reason: `stripped disambiguating year suffix "(${hint.titleYear})" now that ExternalIds.tmdbId is confirmed`,
  };
}

export interface TmdbShowLike {
  name: string;
  overview?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  status?: string | null;
}

export interface SeriesFieldUpdate {
  overview: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  releaseStatus: ReleaseStatus;
}

export function computeSeriesFieldUpdate(show: TmdbShowLike, mapStatus: (raw: string | null | undefined) => ReleaseStatus): SeriesFieldUpdate {
  return {
    overview: show.overview ?? null,
    posterUrl: tmdbImageUrl(show.poster_path),
    backdropUrl: tmdbImageUrl(show.backdrop_path),
    releaseStatus: mapStatus(show.status),
  };
}
