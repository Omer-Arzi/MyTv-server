// Pure helpers for MeService — no Prisma calls, no I/O — same pattern as
// series-query-helpers.ts.

import { UserSeriesStatus } from '@prisma/client';
import { isEpisodeReleased } from '../../common/is-episode-released';
import { isUntrustedNextEpisodeTitle } from '../../common/stale-series-trust';
import { isCanonicalSeason } from '../series/series-query-helpers';

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
//
// Contract (docs/watch-next-released-episode-semantics-todo.md): this is a
// count of RELEASED, UNWATCHED episodes only — never a raw catalog
// position. A future-dated episode already known locally (e.g. inserted
// upfront by an enrichment apply, same shape as the X-Men '97 case that
// motivated this) must never inflate this number. The field name
// (remainingEpisodesAfterNext) is unchanged from before this fix — it now
// has exactly one meaning (released+unwatched), not a mixture, so the
// "avoid ambiguous names for mixed content" concern this fix exists to
// satisfy no longer applies to it; renaming would touch the DTO, mobile
// type, mobile formatter, and every existing test for no behavior gain.

export interface OrderedEpisodeForRemainingCount {
  id: string;
  seriesId: string;
  airDate: Date | null;
}

// Groups an already (seasonNumber, episodeNumber)-ordered flat episode list
// (the same ordering rule used everywhere else next-episode logic runs —
// see e.g. episode-watch.service.ts's findNextEpisode) by seriesId,
// preserving each series' relative order. Built once for a whole batch of
// Watch Next candidates (one query, grouped in memory) rather than once per
// series, to avoid an N+1 query per row in the Watch Next list. Keeps full
// episode objects (not just ids) — computeRemainingEpisodesAfterNext needs
// each episode's airDate to apply the canonical released predicate.
export function groupOrderedEpisodesBySeriesId(
  episodes: readonly OrderedEpisodeForRemainingCount[],
): Map<string, OrderedEpisodeForRemainingCount[]> {
  const bySeriesId = new Map<string, OrderedEpisodeForRemainingCount[]>();
  for (const episode of episodes) {
    const existing = bySeriesId.get(episode.seriesId);
    if (existing) {
      existing.push(episode);
    } else {
      bySeriesId.set(episode.seriesId, [episode]);
    }
  }
  return bySeriesId;
}

// How many RELEASED, UNWATCHED catalog episodes come after the displayed
// next episode — not counting the next episode itself, and never counting
// a not-yet-released episode no matter where it sits positionally.
// `orderedEpisodes` must already be sorted (seasonNumber, episodeNumber)
// ascending for the whole series. Uses the project's one canonical
// released predicate (isEpisodeReleased) — no separate release-date
// comparison logic here.
//
// Returns null — never 0 — when nextEpisodeId isn't found in the given
// list at all. That should be structurally impossible (nextEpisodeId
// always points at a real episode of this series), but is treated as
// "position could not be reliably determined" rather than silently
// reported as "no more episodes": the mobile client renders nothing rather
// than a possibly wrong `+0`/"Final episode" for this case.
export function computeRemainingEpisodesAfterNext(
  orderedEpisodes: readonly OrderedEpisodeForRemainingCount[],
  nextEpisodeId: string,
  watchedEpisodeIds: ReadonlySet<string>,
  now: Date = new Date(),
): number | null {
  const index = orderedEpisodes.findIndex((e) => e.id === nextEpisodeId);
  if (index === -1) return null;
  return orderedEpisodes.slice(index + 1).filter((e) => !watchedEpisodeIds.has(e.id) && isEpisodeReleased(e.airDate, now)).length;
}

// --- "Haven't Started Yet" Home carousel ----------------------------------
//
// A derived Home section, not a persistent user status — WATCHLIST rows
// that already have at least one real, released, watchable episode. Every
// eligibility rule is re-checked here independently of whatever the
// caller's DB query already filtered for, same defense-in-depth posture as
// filterReleasedNextEpisodes/isTrustedStaleCandidate above.

export interface HavenStartedYetCandidateEpisode {
  id: string;
  seasonId: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  overview: string | null;
  airDate: Date | null;
  runtimeMinutes: number | null;
  imageUrl: string | null;
}

export interface HavenStartedYetCandidate {
  seriesId: string;
  seriesTitle: string;
  userStatus: UserSeriesStatus;
  // null when this series has no confirmed provider match yet.
  externalIds: { provider: string | null; providerId: string | null } | null;
  episodes: HavenStartedYetCandidateEpisode[];
}

export interface HavenStartedYetResult {
  seriesId: string;
  latestReleasedRegularEpisode: HavenStartedYetCandidateEpisode;
  releasedRegularEpisodeCount: number;
}

// The full eligibility check, as one predicate + derivation, mirroring
// isTrustedStaleCandidate's shape:
//   1. userStatus === WATCHLIST (re-checked, not just trusted from the caller's WHERE).
//   2. zero EpisodeWatch rows for this series — "haven't started" is exact,
//      not "mostly unwatched."
//   3. at least one RELEASED, REGULAR (season > 0) episode — Season 0/Specials
//      alone can never qualify a series for this section, same rule
//      COMPLETED/CAUGHT_UP derivation already uses (isCanonicalSeason).
//   4. a confirmed provider mapping exists (ExternalIds.provider/providerId
//      both set) — an unconfirmed series has no trustworthy catalog/air-date
//      data to base "released" on.
//   5. not on the known episode-numbering/season-shift risk list — the same
//      Home-eligibility trust gate Watch Next and stale-series both use.
export function deriveHavenStartedYetCandidates(candidates: HavenStartedYetCandidate[], watchedEpisodeIds: ReadonlySet<string>, now: Date = new Date()): HavenStartedYetResult[] {
  const results: HavenStartedYetResult[] = [];

  for (const candidate of candidates) {
    if (candidate.userStatus !== UserSeriesStatus.WATCHLIST) continue;
    if (candidate.episodes.some((e) => watchedEpisodeIds.has(e.id))) continue;
    if (!candidate.externalIds?.provider || !candidate.externalIds?.providerId) continue;
    if (isUntrustedNextEpisodeTitle(candidate.seriesTitle)) continue;

    const releasedRegularEpisodes = candidate.episodes.filter((e) => isCanonicalSeason(e.seasonNumber) && isEpisodeReleased(e.airDate, now));
    if (releasedRegularEpisodes.length === 0) continue;

    const latestReleasedRegularEpisode = releasedRegularEpisodes.reduce((latest, e) => (e.airDate! > latest.airDate! ? e : latest));

    results.push({ seriesId: candidate.seriesId, latestReleasedRegularEpisode, releasedRegularEpisodeCount: releasedRegularEpisodes.length });
  }

  return results;
}

// Sort contract: newest released first, alphabetical (case-insensitive) on
// ties. Takes the already-derived results plus a title lookup rather than
// re-deriving, so this stays a pure, independently testable sort step.
export function sortHavenStartedYetResults<T extends { seriesId: string; latestReleasedRegularEpisode: { airDate: Date | null } }>(
  results: T[],
  titleBySeriesId: ReadonlyMap<string, string>,
): T[] {
  return [...results].sort((a, b) => {
    const dateDiff = (b.latestReleasedRegularEpisode.airDate?.getTime() ?? 0) - (a.latestReleasedRegularEpisode.airDate?.getTime() ?? 0);
    if (dateDiff !== 0) return dateDiff;
    const titleA = titleBySeriesId.get(a.seriesId) ?? '';
    const titleB = titleBySeriesId.get(b.seriesId) ?? '';
    return titleA.localeCompare(titleB);
  });
}
