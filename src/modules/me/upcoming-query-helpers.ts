// Pure helpers for MeService.getUpcoming — no Prisma calls, no I/O — same
// pattern as me-query-helpers.ts/series-query-helpers.ts. See
// docs/upcoming-timeline-todo.md for the full design writeup this
// implements (eligibility rule, why no confirmed-match/risk-list gate,
// known-time heuristic, ordering rule, date-window pagination shape).

import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { isEpisodeReleased } from '../../common/is-episode-released';
import { parseProviderDateOnly } from '../../common/release-date-policy';

// Statuses whose episodes belong in Upcoming — same set for both the past
// and future windows (one rule, not two). DROPPED/UNKNOWN excluded — see
// docs/upcoming-timeline-todo.md "Eligibility" for the full per-status
// reasoning (PAUSED and COMPLETED inclusion are the two non-obvious calls).
export const UPCOMING_ELIGIBLE_STATUSES: UserSeriesStatus[] = [
  UserSeriesStatus.WATCHING,
  UserSeriesStatus.CAUGHT_UP,
  UserSeriesStatus.WATCHLIST,
  UserSeriesStatus.PAUSED,
  UserSeriesStatus.COMPLETED,
];

// Deliberately NOT applying the Watchlist tab's confirmed-provider-match
// trust gate here — an unenriched/TV-Time-only series' episodes have a null
// airDate (TV Time's export carries no air dates at all) and are already
// excluded by the date-range query itself. See docs/upcoming-timeline-todo.md.

const MIN_WINDOW_DAYS = 1;
// Generous enough for a 30-day scroll page plus slack, small enough that a
// malformed/huge client-supplied window can't force an unbounded query.
const MAX_WINDOW_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;

export type UpcomingWindowValidation = { valid: true; from: Date; to: Date } | { valid: false; reason: string };

// Validates and parses the from/to query params (plain "YYYY-MM-DD"
// strings — see docs/upcoming-timeline-todo.md's Pagination section for why
// this is date-window, not opaque-cursor, pagination). Reuses
// parseProviderDateOnly (release-date-policy.ts) rather than a second
// date-only parser, so a window boundary and a provider airDate are always
// interpreted identically (both UTC-midnight-of-that-calendar-date).
export function validateUpcomingWindow(fromStr: string, toStr: string): UpcomingWindowValidation {
  const from = parseProviderDateOnly(fromStr);
  const to = parseProviderDateOnly(toStr);
  if (!from) return { valid: false, reason: `Invalid "from" date: ${fromStr} (expected YYYY-MM-DD)` };
  if (!to) return { valid: false, reason: `Invalid "to" date: ${toStr} (expected YYYY-MM-DD)` };
  if (to.getTime() <= from.getTime()) return { valid: false, reason: '"to" must be after "from"' };

  const spanDays = (to.getTime() - from.getTime()) / DAY_MS;
  if (spanDays < MIN_WINDOW_DAYS) return { valid: false, reason: `Window must span at least ${MIN_WINDOW_DAYS} day` };
  if (spanDays > MAX_WINDOW_DAYS) return { valid: false, reason: `Window must span at most ${MAX_WINDOW_DAYS} days` };

  return { valid: true, from, to };
}

// Inverts parseProviderDateOnly exactly — always uses UTC getters (never
// local/host getters) so the server's own formatting is timezone-agnostic
// regardless of what machine it runs on. Every airDate this app writes is
// UTC-midnight-of-a-calendar-date by construction, so this round-trips
// exactly for every value that actually came from parseProviderDateOnly.
export function toAirDateOnlyString(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Whether this airDate carries a real time-of-day, derived from the value
// itself rather than a dedicated column (none exists — no integrated
// provider supplies episode time-of-day today). A date-only provider value
// always parses to exact UTC midnight (parseProviderDateOnly), so an
// all-zero UTC time-of-day is indistinguishable from "no time known" and
// this correctly evaluates false for every episode in the database today.
// If a future provider/import path ever writes a real non-midnight instant,
// this picks it up automatically with no further code changes. Documented,
// deliberate heuristic tradeoff — see docs/upcoming-timeline-todo.md
// "Release time" section.
export function hasKnownReleaseTimeOfDay(airDate: Date): boolean {
  return airDate.getUTCHours() !== 0 || airDate.getUTCMinutes() !== 0 || airDate.getUTCSeconds() !== 0 || airDate.getUTCMilliseconds() !== 0;
}

export interface UpcomingBadges {
  seasonPremiere: boolean;
  seriesPremiere: boolean;
}

// Season 0 (Specials) never counts as a premiere, matching isCanonicalSeason's
// existing use everywhere else in this app. seriesPremiere is read directly
// off the already-trusted canonical (seasonNumber, episodeNumber) ordering
// this app relies on everywhere (not a separate inference layer), so it's
// reliable to claim. Season/series FINALE is deliberately not implemented —
// see docs/upcoming-timeline-todo.md "Badges": it would require a
// trustworthy total-episode-count signal that doesn't exist (catalog
// completeness is an open problem for a meaningful subset of this library).
export function deriveUpcomingBadges(seasonNumber: number, episodeNumber: number): UpcomingBadges {
  const seasonPremiere = seasonNumber > 0 && episodeNumber === 1;
  const seriesPremiere = seasonNumber === 1 && episodeNumber === 1;
  return { seasonPremiere, seriesPremiere };
}

export interface UpcomingItem {
  seriesId: string;
  seriesTitle: string;
  posterUrl: string | null;
  episodeId: string;
  seasonId: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string | null;
  airDateOnly: string;
  airDateInstant: Date;
  hasKnownReleaseTime: boolean;
  isReleased: boolean;
  isWatched: boolean;
  episodeWatchId: string | null;
  seriesUserStatus: UserSeriesStatus;
  seriesReleaseStatus: ReleaseStatus;
  badges: UpcomingBadges;
}

export interface RawEpisodeForUpcoming {
  id: string;
  seasonId: string;
  episodeNumber: number;
  title: string | null;
  airDate: Date; // never null here — caller already filtered on airDate not-null via the DB query
  seasonNumber: number;
  seriesId: string;
  seriesTitle: string;
  posterUrl: string | null;
  seriesReleaseStatus: ReleaseStatus;
  seriesUserStatus: UserSeriesStatus;
}

// Builds one DTO-shaped item from a raw joined episode row + this user's
// watch-state lookup. Pure — no I/O — so it's independently unit-testable
// from the Prisma query that feeds it.
export function toUpcomingItem(episode: RawEpisodeForUpcoming, episodeWatchId: string | null, now: Date = new Date()): UpcomingItem {
  return {
    seriesId: episode.seriesId,
    seriesTitle: episode.seriesTitle,
    posterUrl: episode.posterUrl,
    episodeId: episode.id,
    seasonId: episode.seasonId,
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber,
    episodeTitle: episode.title,
    airDateOnly: toAirDateOnlyString(episode.airDate),
    airDateInstant: episode.airDate,
    hasKnownReleaseTime: hasKnownReleaseTimeOfDay(episode.airDate),
    isReleased: isEpisodeReleased(episode.airDate, now),
    isWatched: episodeWatchId !== null,
    episodeWatchId,
    seriesUserStatus: episode.seriesUserStatus,
    seriesReleaseStatus: episode.seriesReleaseStatus,
    badges: deriveUpcomingBadges(episode.seasonNumber, episode.episodeNumber),
  };
}

// The exact ordering rule from docs/upcoming-timeline-todo.md "Ordering
// within a day": known-time items first (by instant ascending), then
// unknown-time items alphabetically by series title, tie-broken by
// (seasonNumber, episodeNumber), then episodeId for full determinism. A
// known-time item is NEVER placed after an unknown-time one, regardless of
// clock value — group membership always wins over any within-group key.
export function compareUpcomingItemsWithinDay(a: UpcomingItem, b: UpcomingItem): number {
  if (a.hasKnownReleaseTime !== b.hasKnownReleaseTime) {
    return a.hasKnownReleaseTime ? -1 : 1;
  }
  if (a.hasKnownReleaseTime && b.hasKnownReleaseTime) {
    const diff = a.airDateInstant.getTime() - b.airDateInstant.getTime();
    if (diff !== 0) return diff;
  } else {
    const titleDiff = a.seriesTitle.localeCompare(b.seriesTitle, undefined, { sensitivity: 'base' });
    if (titleDiff !== 0) return titleDiff;
  }
  if (a.seasonNumber !== b.seasonNumber) return a.seasonNumber - b.seasonNumber;
  if (a.episodeNumber !== b.episodeNumber) return a.episodeNumber - b.episodeNumber;
  return a.episodeId.localeCompare(b.episodeId);
}

export interface UpcomingDayBucket {
  date: string; // "YYYY-MM-DD"
  items: UpcomingItem[];
}

// Groups already-built items by their raw airDateOnly string (never a
// locally-converted date — see docs/upcoming-timeline-todo.md's timezone
// section for why grouping stays in raw-provider-date space on the
// server), sorts the groups chronologically, and sorts each group's items
// per compareUpcomingItemsWithinDay. Sparse by construction — a date with
// zero eligible items never appears (the caller/mobile client is
// responsible for synthesizing an empty "Today" section if needed, since
// only the client knows its own local "today" — this app has no per-user
// timezone).
export function buildUpcomingDayBuckets(items: UpcomingItem[]): UpcomingDayBucket[] {
  const byDate = new Map<string, UpcomingItem[]>();
  for (const item of items) {
    const bucket = byDate.get(item.airDateOnly);
    if (bucket) bucket.push(item);
    else byDate.set(item.airDateOnly, [item]);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dateItems]) => ({ date, items: [...dateItems].sort(compareUpcomingItemsWithinDay) }));
}
