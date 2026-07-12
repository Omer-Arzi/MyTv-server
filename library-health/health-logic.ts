// Pure decision logic for the Library Health report. No I/O, no Prisma, no
// provider calls — this only ever reasons about data already handed to it,
// same pattern as watch-all-logic.ts/unwatch-logic.ts/
// episode-release-refresh/refresh-logic.ts. run-health-report.ts is just
// wiring (one set of read-only Prisma queries, a loop, write files).
//
// This is a purely local-signal classifier — it never fetches a provider
// catalog live (unlike episode-release-refresh/refresh-logic.ts's
// compareSeriesCatalog). That's a deliberate scope boundary for this first
// pass ("foundation"): every signal here comes from what's already in
// Postgres (ExternalIds, Episode/Season, EpisodeWatch, UserSeriesProgress)
// plus the existing risk-list constants. A future pass could feed a live
// TMDb comparison (e.g. episode-release-refresh's compareSeriesCatalog
// result) into this same classifier as an additional input without
// changing the shape of anything below — see SeriesHealthInput's docstring.

import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import {
  EPISODE_NUMBERING_RISK_LIST_TITLES,
  KNOWN_SEASON_SHIFT_ORPHAN_TITLES,
  PROVIDER_STRUCTURE_MISMATCH_TITLES,
} from '../src/common/stale-series-trust';
import { findFirstUnwatchedEpisodeId, OrderedEpisodeForNextLookup } from '../src/modules/series/series-query-helpers';

export type LibraryHealthClassification =
  | 'READY'
  | 'MISSING_PROVIDER_MATCH'
  | 'INCOMPLETE_CATALOG'
  | 'PROVIDER_STRUCTURE_RISK'
  | 'NEEDS_MANUAL_CONFIRMATION'
  | 'CAUGHT_UP_TRUSTED'
  | 'WATCH_NEXT_TRUSTED'
  | 'UNTRACKED_OR_LOW_PRIORITY';

export type RecommendedNextAction =
  | 'CONFIRM_PROVIDER_MATCH'
  | 'RUN_TARGETED_PROVIDER_AUDIT'
  | 'APPLY_SAFE_PROVIDER_CATALOG_DRY_RUN'
  | 'NEEDS_ABSOLUTE_NUMBERING_PROVIDER'
  | 'MARK_AS_RISK'
  | 'NO_ACTION';

export type RiskFlag =
  | 'NO_PROVIDER_MATCH'
  | 'PENDING_PROVIDER_CANDIDATE'
  | 'RISK_LISTED_EPISODE_NUMBERING'
  | 'RISK_LISTED_SEASON_SHIFT_ORPHAN'
  | 'RISK_LISTED_PROVIDER_STRUCTURE_MISMATCH'
  | 'NO_LOCAL_EPISODES'
  | 'MOSTLY_UNENRICHED_EPISODES'
  | 'NEXT_EPISODE_INCONSISTENT';

// DROPPED/PAUSED/WATCHLIST are explicit personal intent (same protected set
// watch-all-logic.ts/unwatch-logic.ts already draw a line around); UNKNOWN
// means a UserSeriesProgress row exists but nothing meaningful has happened
// yet. All four — and having no progress row at all — mean "not actively
// being tracked," which the task's own category 8 groups as one bucket.
const LOW_PRIORITY_USER_STATUSES: UserSeriesStatus[] = [
  UserSeriesStatus.DROPPED,
  UserSeriesStatus.PAUSED,
  UserSeriesStatus.WATCHLIST,
  UserSeriesStatus.UNKNOWN,
];

// An episode counts as "unenriched" when it has neither a title nor an
// airDate — i.e. it looks like exactly what a raw TV Time import leaves
// behind before any enrichment pass touches it (docs/tvtime-data-audit.md:
// the TV Time export carries no episode titles/overviews/air dates at
// all). 90% is deliberately high — a handful of genuinely-missing dates on
// an otherwise-enriched show shouldn't trip this; a series where almost
// nothing has real metadata is the actual "still just a TV Time import"
// signal this is trying to catch.
const UNENRICHED_EPISODE_FRACTION_THRESHOLD = 0.9;

export interface LocalEpisodeHealthInput {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  airDate: Date | null;
  watched: boolean;
}

// Mirrors the columns on the ExternalIds row this classifier actually
// reads. Only tmdbId is a first-class, uniquely-constrained column right
// now (see prisma/schema.prisma) — MyTv has no dedicated tvmazeId column
// yet, so a TVmaze match (if one is ever recorded) is expected to show up
// as provider='tvmaze'/providerId=<tvmaze id> instead; classifySeriesHealth
// reads it that way (see tvmazeId on SeriesHealthResult below).
export interface ExternalIdsHealthInput {
  tmdbId: string | null;
  provider: string | null;
  providerId: string | null;
  matchConfidence: number | null;
  matchSource: string | null;
}

export interface ProgressHealthInput {
  userStatus: UserSeriesStatus;
  nextEpisodeId: string | null;
  lastWatchedAt: Date | null;
}

export interface SeriesHealthInput {
  seriesId: string;
  title: string;
  releaseStatus: ReleaseStatus;
  posterUrl: string | null;
  backdropUrl: string | null;
  externalIds: ExternalIdsHealthInput | null;
  episodes: LocalEpisodeHealthInput[];
  // null = no UserSeriesProgress row at all for this user/series.
  progress: ProgressHealthInput | null;
  now?: Date;
}

export interface SeriesHealthResult {
  seriesId: string;
  title: string;
  userStatus: UserSeriesStatus | null;
  releaseStatus: ReleaseStatus;
  tmdbId: string | null;
  tvmazeId: string | null;
  localEpisodeCount: number;
  watchedEpisodeCount: number;
  nextEpisodeId: string | null;
  lastWatchedAt: Date | null;
  hasPoster: boolean;
  hasBackdrop: boolean;
  riskFlags: RiskFlag[];
  classification: LibraryHealthClassification;
  recommendedNextAction: RecommendedNextAction;
}

function riskListFlagsForTitle(title: string): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (EPISODE_NUMBERING_RISK_LIST_TITLES.includes(title)) flags.push('RISK_LISTED_EPISODE_NUMBERING');
  if (KNOWN_SEASON_SHIFT_ORPHAN_TITLES.includes(title)) flags.push('RISK_LISTED_SEASON_SHIFT_ORPHAN');
  if (PROVIDER_STRUCTURE_MISMATCH_TITLES.includes(title)) flags.push('RISK_LISTED_PROVIDER_STRUCTURE_MISMATCH');
  return flags;
}

// Classifies one series into exactly one of the 8 primary Library Health
// categories, in a fixed precedence order (first matching rule wins — see
// the numbered steps below). Every branch also returns a recommendedNextAction
// and the full set of riskFlags observed, even when a higher-precedence
// rule already decided the classification, so the report stays informative
// beyond just the single winning category.
export function classifySeriesHealth(input: SeriesHealthInput): SeriesHealthResult {
  const now = input.now ?? new Date();

  const tmdbId = input.externalIds?.tmdbId ?? null;
  // Closest available signal for a TVmaze match today — see
  // ExternalIdsHealthInput's docstring for why this isn't a dedicated column.
  const tvmazeId = input.externalIds?.provider === 'tvmaze' ? (input.externalIds.providerId ?? null) : null;
  const hasProviderMatch = tmdbId !== null;
  // A match ATTEMPT left a trace (provider/providerId/matchConfidence/
  // matchSource) but never got confirmed into tmdbId — distinct from never
  // having tried at all. Mirrors tmdb-enrichment's NEEDS_REVIEW tier
  // conceptually, without re-running any scoring here.
  const hasPendingCandidate =
    !hasProviderMatch &&
    !!input.externalIds &&
    (!!input.externalIds.provider || !!input.externalIds.providerId || input.externalIds.matchConfidence !== null || !!input.externalIds.matchSource);

  const localEpisodeCount = input.episodes.length;
  const watchedEpisodeCount = input.episodes.filter((e) => e.watched).length;
  const unenrichedCount = input.episodes.filter((e) => e.title === null && e.airDate === null).length;
  const unenrichedFraction = localEpisodeCount > 0 ? unenrichedCount / localEpisodeCount : 0;

  const riskListFlags = riskListFlagsForTitle(input.title);
  const isRiskListed = riskListFlags.length > 0;

  const hasPoster = !!input.posterUrl;
  const hasBackdrop = !!input.backdropUrl;

  const userStatus = input.progress?.userStatus ?? null;
  const nextEpisodeId = input.progress?.nextEpisodeId ?? null;
  const lastWatchedAt = input.progress?.lastWatchedAt ?? null;

  const riskFlags: RiskFlag[] = [...riskListFlags];
  if (!hasProviderMatch) riskFlags.push('NO_PROVIDER_MATCH');
  if (hasPendingCandidate) riskFlags.push('PENDING_PROVIDER_CANDIDATE');
  if (localEpisodeCount === 0) riskFlags.push('NO_LOCAL_EPISODES');
  if (localEpisodeCount > 0 && unenrichedFraction >= UNENRICHED_EPISODE_FRACTION_THRESHOLD) riskFlags.push('MOSTLY_UNENRICHED_EPISODES');

  const base = {
    seriesId: input.seriesId,
    title: input.title,
    userStatus,
    releaseStatus: input.releaseStatus,
    tmdbId,
    tvmazeId,
    localEpisodeCount,
    watchedEpisodeCount,
    nextEpisodeId,
    lastWatchedAt,
    hasPoster,
    hasBackdrop,
  };

  // --- 1. Untracked / low priority (category 8) ---------------------------
  // Checked first: none of the other categories' "action needed" framing
  // applies to a series the user isn't actively engaged with. riskFlags are
  // still computed above for visibility, but no action is recommended.
  if (!input.progress || LOW_PRIORITY_USER_STATUSES.includes(input.progress.userStatus)) {
    return { ...base, riskFlags, classification: 'UNTRACKED_OR_LOW_PRIORITY', recommendedNextAction: 'NO_ACTION' };
  }

  // From here, userStatus is WATCHING, CAUGHT_UP, or COMPLETED.

  // --- 2. Known provider-structure risk (category 4) ----------------------
  // Checked BEFORE the provider-match check below — risk-list membership is
  // a fact about the title itself (known numbering/remake/season-shift
  // hazard), independent of whether a match happens to be confirmed yet.
  // E.g. One Piece is risk-listed because of a title collision between two
  // MyTv rows, which is exactly as true whether or not either row currently
  // has a tmdbId — surfacing MISSING_PROVIDER_MATCH instead would bury the
  // more specific, more dangerous signal.
  if (isRiskListed) {
    // EPISODE_NUMBERING_RISK_LIST_TITLES and PROVIDER_STRUCTURE_MISMATCH_TITLES
    // are, in practice, dominated by anime absolute-numbering cases (see
    // docs/episode-numbering-and-season-shift-risk.md) — routed to the more
    // specific action. KNOWN_SEASON_SHIFT_ORPHAN_TITLES is the general
    // "an apply already went wrong here" list, not anime-specific, so it
    // gets the generic MARK_AS_RISK action instead.
    const isAnimeNumberingRisk = riskListFlags.includes('RISK_LISTED_EPISODE_NUMBERING') || riskListFlags.includes('RISK_LISTED_PROVIDER_STRUCTURE_MISMATCH');
    return {
      ...base,
      riskFlags,
      classification: 'PROVIDER_STRUCTURE_RISK',
      recommendedNextAction: isAnimeNumberingRisk ? 'NEEDS_ABSOLUTE_NUMBERING_PROVIDER' : 'MARK_AS_RISK',
    };
  }

  // --- 3. Missing or pending provider match (categories 2 / 5) ------------
  if (!hasProviderMatch) {
    if (hasPendingCandidate) {
      // category 5: a candidate exists, just not confirmed.
      return { ...base, riskFlags, classification: 'NEEDS_MANUAL_CONFIRMATION', recommendedNextAction: 'CONFIRM_PROVIDER_MATCH' };
    }
    // category 2: no candidate on file at all.
    return { ...base, riskFlags, classification: 'MISSING_PROVIDER_MATCH', recommendedNextAction: 'RUN_TARGETED_PROVIDER_AUDIT' };
  }

  // --- 4. Incomplete catalog (category 3) ---------------------------------
  // Two independent triggers: no local episodes at all for an actively
  // tracked series, or a confirmed-match series whose episodes still look
  // like an unenriched TV Time import despite the user having watched some.
  if (localEpisodeCount === 0 || (watchedEpisodeCount > 0 && unenrichedFraction >= UNENRICHED_EPISODE_FRACTION_THRESHOLD)) {
    return { ...base, riskFlags, classification: 'INCOMPLETE_CATALOG', recommendedNextAction: 'APPLY_SAFE_PROVIDER_CATALOG_DRY_RUN' };
  }

  // A third trigger, checked separately because it needs the ordered
  // catalog built first: stored nextEpisodeId no longer matches what the
  // local catalog + watch state would actually compute (drifted, or
  // references something the catalog doesn't structurally support) — the
  // same "user progress references a later episode than local catalog
  // contains" signal from category 3, detected without a live provider
  // fetch by re-deriving nextEpisodeId the exact same way the live
  // mark-watched flow does (findFirstUnwatchedEpisodeId) and comparing.
  const orderedEpisodes: OrderedEpisodeForNextLookup[] = [...input.episodes]
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber)
    .map((e) => ({ id: e.id, airDate: e.airDate, seasonNumber: e.seasonNumber }));
  const watchedIds = new Set(input.episodes.filter((e) => e.watched).map((e) => e.id));
  const computedNextEpisodeId = findFirstUnwatchedEpisodeId(orderedEpisodes, watchedIds, now);

  if (computedNextEpisodeId !== nextEpisodeId) {
    return {
      ...base,
      riskFlags: [...riskFlags, 'NEXT_EPISODE_INCONSISTENT'],
      classification: 'INCOMPLETE_CATALOG',
      recommendedNextAction: 'APPLY_SAFE_PROVIDER_CATALOG_DRY_RUN',
    };
  }

  // --- 5. Trusted buckets (categories 1 / 6 / 7) --------------------------
  if (userStatus === UserSeriesStatus.WATCHING) {
    if (nextEpisodeId !== null) {
      // category 7: released next episode, structurally trustworthy (just verified above).
      return { ...base, riskFlags, classification: 'WATCH_NEXT_TRUSTED', recommendedNextAction: 'NO_ACTION' };
    }
    // WATCHING with no next episode is a real but unusual state (e.g. a
    // manual PATCH /series/:seriesId/status re-derivation came back null
    // because nothing unwatched-and-released is known yet) — everything
    // about this series' data health is fine, it just doesn't cleanly fit
    // "has a next episode to trust" (category 7) or "is CAUGHT_UP"
    // (category 6, wrong userStatus label), so it lands in the general
    // "everything checks out" bucket instead (category 1).
    return { ...base, riskFlags, classification: 'READY', recommendedNextAction: 'NO_ACTION' };
  }

  // CAUGHT_UP or COMPLETED — category 6. Folding COMPLETED in here
  // deliberately: neither the task's 8 categories nor any UI concept
  // singles COMPLETED out separately, and "watched everything, provider
  // confirms nothing more is coming" is the same "nothing pending, trust
  // this" shape as CAUGHT_UP, just for a finished show.
  return { ...base, riskFlags, classification: 'CAUGHT_UP_TRUSTED', recommendedNextAction: 'NO_ACTION' };
}
