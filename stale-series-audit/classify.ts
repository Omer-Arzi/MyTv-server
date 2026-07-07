// Pure classification logic for the stale-series ("Haven't Watched For A
// While") accuracy audit. No I/O — testable without a database.
// Priority-ordered: each item gets exactly one category, checked
// most-specific/actionable first, mirroring watch-next-audit's
// post-enrichment-sanity-logic.ts.

export type StaleSeriesCategory =
  | 'RISK_LIST_DO_NOT_TRUST'
  | 'SHOULD_BE_CAUGHT_UP'
  | 'DATA_INCOMPLETE'
  | 'NEEDS_USER_CONFIRMATION'
  | 'POSSIBLE_SEASON_SHIFT'
  | 'POSSIBLE_DUPLICATE_EPISODES'
  | 'POSSIBLE_SPECIALS_MISMATCH'
  | 'TRUE_STALE_WATCHING';

// The system-computed recommendation (task 5's 6-option vocabulary). The
// markdown report additionally exposes a separate, human-facing "suggested
// manual decision" checkbox field (task 7's shorter vocabulary) — the two
// are related but intentionally not the same field, matching the existing
// watch-next-review precedent of a system suggestion plus a blank manual
// decision the human actually checks.
export type RecommendedAction =
  | 'keep_in_stale'
  | 'mark_caught_up'
  | 'exclude_from_stale_until_mapped'
  | 'needs_manual_mapping'
  | 'needs_user_confirmation'
  | 'enrich_catalog_first';

export interface ClassifyStaleSeriesInput {
  // Exact-title match against docs/episode-numbering-and-season-shift-risk.md's
  // explicit "do not trust" list.
  isOnRiskList: boolean;
  // Current userStatus is already CAUGHT_UP — the row's data is not wrong,
  // the /me/stale-series query itself is what shouldn't have included it.
  userStatusIsCaughtUp: boolean;
  // UserSeriesProgress.nextEpisodeId is set.
  hasNextEpisode: boolean;
  // Series has a confirmed catalog match (ExternalIds.tmdbId present).
  hasTmdbMatch: boolean;
  // nextEpisode exists but has neither a title nor an airDate on file — not
  // enough information to verify it's a genuine, already-released episode.
  nextEpisodeDataIncomplete: boolean;
  // From a cached targeted-enrichment dry-run/apply record for this series:
  // fewer existing watched episodes matched the provider's numbering than
  // were actually watched, orphaning watched content under new numbering.
  hasKnownSeasonShiftOrphan: boolean;
  // Next episode's title is suspiciously similar to the last-watched
  // episode's title — the same content may be re-appearing under a
  // different number.
  nextEpisodeTitleDuplicatesLastWatched: boolean;
  // This series has a season 0 / episode 0 (special) in its known catalog,
  // which the count-based "released known episode count" math and
  // next-episode selection don't specially account for.
  hasSeasonZeroOrEpisodeZero: boolean;
}

export interface ClassifyStaleSeriesResult {
  category: StaleSeriesCategory;
  recommendedAction: RecommendedAction;
  reason: string;
}

export function classifyStaleSeries(input: ClassifyStaleSeriesInput): ClassifyStaleSeriesResult {
  if (input.isOnRiskList) {
    return {
      category: 'RISK_LIST_DO_NOT_TRUST',
      recommendedAction: 'needs_manual_mapping',
      reason:
        'series appears on docs/episode-numbering-and-season-shift-risk.md — the underlying provider match/numbering is unconfirmed, so this next episode should not be trusted or recommended yet',
    };
  }

  if (input.userStatusIsCaughtUp) {
    return {
      category: 'SHOULD_BE_CAUGHT_UP',
      recommendedAction: 'exclude_from_stale_until_mapped',
      reason:
        'userStatus is already CAUGHT_UP — nothing left to watch, so this row is not wrong, the /me/stale-series query itself should exclude CAUGHT_UP rather than nudge the user about a show they are caught up on',
    };
  }

  if (!input.hasNextEpisode) {
    if (!input.hasTmdbMatch) {
      return {
        category: 'DATA_INCOMPLETE',
        recommendedAction: 'enrich_catalog_first',
        reason:
          'no nextEpisodeId and no confirmed catalog match (ExternalIds.tmdbId) — there is no trustworthy episode data to know whether anything is actually left to watch',
      };
    }
    return {
      category: 'SHOULD_BE_CAUGHT_UP',
      recommendedAction: 'mark_caught_up',
      reason:
        'series has a confirmed catalog match but no nextEpisodeId — this looks caught up in practice and should be marked as such (a real status update, unlike an already-CAUGHT_UP row)',
    };
  }

  if (input.nextEpisodeDataIncomplete) {
    return {
      category: 'NEEDS_USER_CONFIRMATION',
      recommendedAction: 'needs_user_confirmation',
      reason: 'next episode has neither a title nor an airDate on file — not enough information to confirm it is a genuine, already-released episode',
    };
  }

  if (input.hasKnownSeasonShiftOrphan) {
    return {
      category: 'POSSIBLE_SEASON_SHIFT',
      recommendedAction: 'needs_manual_mapping',
      reason:
        "the provider's season/episode structure did not fully align with this series' existing watched episodes during enrichment — some watched content may be duplicated under new numbering",
    };
  }

  if (input.nextEpisodeTitleDuplicatesLastWatched) {
    return {
      category: 'POSSIBLE_DUPLICATE_EPISODES',
      recommendedAction: 'needs_manual_mapping',
      reason: "the proposed next episode's title is suspiciously similar to the last-watched episode's title — possibly the same content under a different number",
    };
  }

  if (input.hasSeasonZeroOrEpisodeZero) {
    return {
      category: 'POSSIBLE_SPECIALS_MISMATCH',
      recommendedAction: 'needs_manual_mapping',
      reason: 'this series has a season 0 / episode 0 (special) in its known catalog, which can distort episode counts and next-episode selection',
    };
  }

  return {
    category: 'TRUE_STALE_WATCHING',
    recommendedAction: 'keep_in_stale',
    reason:
      'has a trusted, released, sequential-looking next episode, is not on the risk list, and has gone stale — a genuine "haven\'t watched for a while" candidate',
  };
}
