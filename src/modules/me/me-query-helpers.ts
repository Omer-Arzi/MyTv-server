// Pure helpers for MeService — no Prisma calls, no I/O — same pattern as
// series-query-helpers.ts.

import { UserSeriesStatus } from '@prisma/client';
import { isEpisodeReleased } from '../../common/is-episode-released';
import { isUntrustedNextEpisodeTitle } from '../../common/stale-series-trust';

export interface ProgressWithNextEpisode {
  nextEpisode: { airDate: Date | null } | null;
}

export interface ProgressWithSeriesTitle {
  series: { title: string };
}

// GET /me/watch-next's own defense-in-depth: UserSeriesProgress.nextEpisodeId
// is already gated at every write site (markWatched, the manual
// status-update endpoint, the one-time backfill — see
// src/common/is-episode-released.ts) so a future or null-airDate episode
// should never end up as nextEpisodeId in the first place. This filter
// re-checks it anyway at read time, so a bug in some future write path (or a
// row written before a gating fix existed) can't leak an unwatchable episode
// into Watch Next — the endpoint's contract holds regardless of how the row
// got into the table.
//
// A null airDate is excluded here for the same reason it's excluded
// everywhere else: there's no way to distinguish "definitely aired, TMDb
// just never recorded the date" from "not aired yet, no date announced," so
// it's treated as not-yet-released. Future/null-airDate episodes belong in a
// future "Upcoming" section instead — not implemented yet.
export function filterReleasedNextEpisodes<T extends ProgressWithNextEpisode>(
  progress: T[],
  now: Date = new Date(),
): (T & { nextEpisode: NonNullable<T['nextEpisode']> })[] {
  return progress.filter(
    (p): p is T & { nextEpisode: NonNullable<T['nextEpisode']> } =>
      p.nextEpisode !== null && isEpisodeReleased(p.nextEpisode.airDate, now),
  );
}

export interface StaleCandidateProgress extends ProgressWithNextEpisode, ProgressWithSeriesTitle {
  userStatus: UserSeriesStatus;
  lastWatchedAt: Date | null;
}

// GET /me/stale-series' full eligibility check — see
// stale-series-audit/output/stale-series-accuracy-report.md for the
// accuracy audit that motivated this. Previously this endpoint only checked
// "userStatus is WATCHING or CAUGHT_UP and lastWatchedAt is old," which
// meant it could nudge a user about a series that was already CAUGHT_UP
// (nothing left to watch) or that had no known next episode at all. "Haven't
// watched for a while" now means the same trust gate as Watch Next
// (userStatus = WATCHING, a real released nextEpisodeId, not on the known
// episode-numbering/season-shift risk list — see
// src/common/stale-series-trust.ts) plus this section's own point: it's
// actually been a while. Written as a single predicate — rather than
// relying solely on the DB query's WHERE clause — so the endpoint's contract
// holds regardless of how a row got into the table, same defense-in-depth
// rationale as filterReleasedNextEpisodes above.
export function isTrustedStaleCandidate<T extends StaleCandidateProgress>(progress: T, cutoff: Date, now: Date = new Date()): boolean {
  if (progress.userStatus !== UserSeriesStatus.WATCHING) return false;
  if (!progress.lastWatchedAt || progress.lastWatchedAt >= cutoff) return false;
  if (!progress.nextEpisode || !isEpisodeReleased(progress.nextEpisode.airDate, now)) return false;
  if (isUntrustedNextEpisodeTitle(progress.series.title)) return false;
  return true;
}

export function filterTrustedStaleCandidates<T extends StaleCandidateProgress>(
  progress: T[],
  cutoff: Date,
  now: Date = new Date(),
): (T & { nextEpisode: NonNullable<T['nextEpisode']> })[] {
  return progress.filter((p): p is T & { nextEpisode: NonNullable<T['nextEpisode']> } => isTrustedStaleCandidate(p, cutoff, now));
}

// Watch Next / stale-series overlap fix (2026-07-05): the two sections are
// mutually exclusive by product definition — a series that already
// qualifies as a trusted stale candidate (see isTrustedStaleCandidate above)
// shouldn't also show up as a "continue watching" nudge. Reuses the exact
// same predicate stale-series uses (same cutoff, same risk-list/
// season-shift exclusions) so a series can never be excluded here by one
// definition of "stale" and still show up there under a different one.
//
// Re-checks userStatus === WATCHING independently of the caller's DB query,
// same defense-in-depth rationale as filterReleasedNextEpisodes above — this
// helper's contract (never returns a non-WATCHING row) holds regardless of
// what the caller already filtered for.
//
// Known scope limit: a risk-listed/season-shift-orphan series (see
// src/common/stale-series-trust.ts) never satisfies isTrustedStaleCandidate
// — that's *why* it's excluded from stale-series — so an old, untrusted
// series is not excluded here either and stays in Watch Next indefinitely.
// That's a pre-existing gap (Watch Next has never filtered the risk list),
// not new overlap: the series only ever appears in one section, never both.
export function filterNonStaleWatchNextCandidates<T extends StaleCandidateProgress>(
  progress: T[],
  staleCutoff: Date,
  now: Date = new Date(),
): (T & { nextEpisode: NonNullable<T['nextEpisode']> })[] {
  return filterReleasedNextEpisodes(progress, now).filter(
    (p) => p.userStatus === UserSeriesStatus.WATCHING && !isTrustedStaleCandidate(p, staleCutoff, now),
  );
}

// --- Watch Next "+N" remaining-episodes indicator (mobile Continue
// Watching card) -----------------------------------------------------------

export interface OrderedEpisodeForRemainingCount {
  id: string;
  seriesId: string;
}

// Groups an already (seasonNumber, episodeNumber)-ordered flat episode list
// (the same ordering rule used everywhere else next-episode logic runs —
// see e.g. episode-watch.service.ts's findNextEpisode) by seriesId,
// preserving each series' relative order. Built once for a whole batch of
// Watch Next candidates (one query, grouped in memory) rather than once per
// series, to avoid an N+1 query per row in the Watch Next list.
export function groupOrderedEpisodeIdsBySeriesId(episodes: readonly OrderedEpisodeForRemainingCount[]): Map<string, string[]> {
  const bySeriesId = new Map<string, string[]>();
  for (const episode of episodes) {
    const existing = bySeriesId.get(episode.seriesId);
    if (existing) {
      existing.push(episode.id);
    } else {
      bySeriesId.set(episode.seriesId, [episode.id]);
    }
  }
  return bySeriesId;
}

// How many known catalog episodes come after the displayed next episode —
// NOT counting the next episode itself. `orderedEpisodeIds` must already be
// sorted (seasonNumber, episodeNumber) ascending for the whole series.
// Returns null — never 0 — when nextEpisodeId isn't found in the given list
// at all. That should be structurally impossible (nextEpisodeId always
// points at a real episode of this series), but is treated as "position
// could not be reliably determined" rather than silently reported as "no
// more episodes": the mobile client renders nothing rather than a possibly
// wrong `+0`/"Final episode" for this case.
export function computeRemainingEpisodesAfterNext(orderedEpisodeIds: readonly string[], nextEpisodeId: string): number | null {
  const index = orderedEpisodeIds.indexOf(nextEpisodeId);
  if (index === -1) return null;
  return orderedEpisodeIds.length - index - 1;
}
