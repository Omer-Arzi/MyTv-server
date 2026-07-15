// The single centralized policy for interpreting provider (TMDb/TVmaze)
// date-only air-date values. is-episode-released.ts's isEpisodeReleased is
// the one existing, already-correct primitive this builds on (kept as its
// own file — many existing call sites already import it directly, and its
// behavior is unchanged here) — this file is the new home for everything
// ELSE the episode-and-series-update flow needs on top of that primitive:
// urgency classification for scheduling, and explicit documentation of the
// provider date-only limitation.
//
// --- The core limitation (read this before changing anything here) -------
//
// TMDb (and TVmaze) supply air_date as a bare calendar date string, e.g.
// "2026-07-13" — no time of day, no timezone. `new Date("2026-07-13")` is
// parsed by the JS/ECMAScript spec as UTC MIDNIGHT of that date
// (2026-07-13T00:00:00.000Z), NOT local midnight — this is standard,
// deliberate ISO-8601 date-only parsing behavior, already what every
// existing call site in this codebase does (tmdb-client callers, the
// import pipeline, etc.) and is preserved exactly here. This policy does
// NOT change that parsing — it centralizes and documents it.
//
// Because there is no time-of-day, "released" here means "the UTC calendar
// date has arrived" — not "the exact real-world simulcast hour has
// passed". A real episode's actual availability (e.g. on a streaming
// platform) can be several hours before OR after UTC midnight of its
// listed date, depending on the show's origin-market broadcast time. This
// is an UNAVOIDABLE limitation of the data source, not a bug in this
// policy — see the Mushoku Tensei investigation (2026-07-12/13) for a real
// case: TMDb listed "2026-07-13" with no further precision, and the
// episode correctly became "released" per this policy the moment UTC
// crossed into that date, which may differ from exactly when it aired.
//
// This app has no per-user timezone setting anywhere in its data model
// (DEV_USER_ID is a single hardcoded dev user — see src/common/constants.ts)
// — "the application's configured/user timezone" therefore resolves to UTC
// today. If a real per-user timezone setting is ever added, this is the
// one file that would need to change: every comparison below is already
// funneled through isEpisodeReleased/computeEpisodeUrgency, not scattered
// inline `airDate <= now` checks, so introducing a timezone offset would
// mean changing these functions' `now` handling in one place.

import { ReleaseStatus } from '@prisma/client';
import { isEpisodeReleased } from './is-episode-released';

export { isEpisodeReleased };

// Parses a provider date-only string ("YYYY-MM-DD") into the same
// UTC-midnight Date every existing call site already produces via
// `new Date(dateString)` — made explicit and named so a future call site
// reads as "I am parsing a provider date-only value" rather than a bare
// `new Date(...)`, and so accidental local-timezone-shift bugs (e.g. from
// `new Date(year, month, day)`, which DOES use local time) are avoided by
// construction: this function only ever accepts the ISO date-only string
// form. Returns null for a missing/invalid input rather than throwing —
// callers already treat a null airDate as "not released" (see
// isEpisodeReleased), so an invalid provider date degrades to the same
// safe "not yet known to be released" state instead of crashing a refresh.
export function parseProviderDateOnly(dateString: string | null | undefined): Date | null {
  if (!dateString) return null;
  // Reject anything that isn't a bare YYYY-MM-DD — a provider value with a
  // time/offset component already parses correctly via plain `new Date()`
  // elsewhere in this codebase (not this function's concern), and a
  // malformed string (empty, non-date garbage) must not silently become
  // "now" or an unrelated date via a lenient parse.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return null;
  const parsed = new Date(dateString);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// --- Urgency classification (feeds the smart scheduling policy) ----------
//
// Answers "how urgently does this series need a provider check right now,"
// derived ENTIRELY from already-known local data (never a provider call
// itself) — the earliest known-but-not-yet-released local episode airDate,
// plus the series' own release status. See smart-scheduling-policy.ts for
// how this feeds into an actual refresh interval.

export type EpisodeUrgency = 'OVERDUE_OR_DUE_TODAY' | 'DUE_WITHIN_48H' | 'ACTIVE_NO_NEAR_EPISODE' | 'BETWEEN_SEASONS_OR_UNKNOWN';

const HOUR_MS = 60 * 60 * 1000;
const URGENT_WINDOW_MS = 48 * HOUR_MS;

const ACTIVE_RELEASE_STATUSES: ReleaseStatus[] = [ReleaseStatus.RETURNING, ReleaseStatus.IN_PRODUCTION];

export interface ComputeEpisodeUrgencyInput {
  releaseStatus: ReleaseStatus;
  // The earliest airDate among episodes ALREADY KNOWN LOCALLY that are not
  // yet released as of `now` (i.e. the next thing to watch for, whether or
  // not it happens to already be past its date) — null when no such
  // episode is known locally at all (nothing upcoming on file, regardless
  // of why: between seasons, provider hasn't listed it yet, or the show
  // has truly ended).
  nextKnownUpcomingAirDate: Date | null;
  now?: Date;
}

export function computeEpisodeUrgency(input: ComputeEpisodeUrgencyInput): EpisodeUrgency {
  const now = input.now ?? new Date();
  const isActive = ACTIVE_RELEASE_STATUSES.includes(input.releaseStatus);

  if (input.nextKnownUpcomingAirDate) {
    const diffMs = input.nextKnownUpcomingAirDate.getTime() - now.getTime();
    if (diffMs <= 0) return 'OVERDUE_OR_DUE_TODAY';
    if (diffMs <= URGENT_WINDOW_MS) return 'DUE_WITHIN_48H';
  }

  return isActive ? 'ACTIVE_NO_NEAR_EPISODE' : 'BETWEEN_SEASONS_OR_UNKNOWN';
}
