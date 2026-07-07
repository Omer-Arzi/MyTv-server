// Pure classification logic for the post-enrichment Watch Next sanity
// report. No I/O — testable without a database. Priority-ordered: each item
// gets exactly one category, checked most-specific/actionable first.

export type WatchNextSanityCategory =
  | 'RISK_LIST_DO_NOT_TRUST'
  | 'NEEDS_USER_CONFIRMATION'
  | 'POSSIBLE_SEASON_SHIFT'
  | 'POSSIBLE_DUPLICATE_EPISODE'
  | 'MANUAL_CAUGHT_UP_CANDIDATE'
  | 'SAFE_WATCH_NEXT';

export interface ClassifyWatchNextSanityInput {
  // Exact-title match against docs/episode-numbering-and-season-shift-risk.md's
  // explicit "do not apply/trust" list.
  isOnRiskList: boolean;
  // We don't have enough data to verify this item at all (no next-episode
  // title AND no airDate) — can't confidently call it safe OR risky.
  nextEpisodeDataIncomplete: boolean;
  // From the targeted-enrichment dry-run/apply record for this series (only
  // meaningful for series enriched in the recent batch): fewer existing
  // episodes matched the provider's numbering than were actually watched,
  // meaning some watched content was left orphaned and the provider's
  // "unwatched" episodes may duplicate it.
  hasKnownSeasonShiftOrphan: boolean;
  // Next episode's title is suspiciously similar to the last-watched
  // episode's title — a lightweight, no-provider-call signal that the
  // "next" episode might actually be the same content under a different
  // number.
  nextEpisodeTitleDuplicatesLastWatched: boolean;
  // One of the series previously manually marked CAUGHT_UP (user confirmed
  // "everything actually released has been watched") whose nextEpisodeId
  // was later reset by the next-episode backfill because a new episode
  // became available — worth asking the user to reconfirm given their
  // established viewing pattern, even though nothing here looks structurally
  // wrong.
  isRecoveryFlipCandidate: boolean;
}

export interface ClassifyWatchNextSanityResult {
  category: WatchNextSanityCategory;
  reason: string;
}

export function classifyWatchNextSanity(input: ClassifyWatchNextSanityInput): ClassifyWatchNextSanityResult {
  if (input.isOnRiskList) {
    return {
      category: 'RISK_LIST_DO_NOT_TRUST',
      reason: 'series appears on docs/episode-numbering-and-season-shift-risk.md — the underlying provider match itself is unconfirmed, so nothing computed from it should be trusted yet',
    };
  }

  if (input.nextEpisodeDataIncomplete) {
    return {
      category: 'NEEDS_USER_CONFIRMATION',
      reason: 'next episode has neither a title nor an airDate on file — not enough information to verify this is a genuine, already-released episode',
    };
  }

  if (input.hasKnownSeasonShiftOrphan) {
    return {
      category: 'POSSIBLE_SEASON_SHIFT',
      reason: "the provider's season/episode structure did not fully align with this series' existing watched episodes during enrichment — some watched content may be duplicated under new numbering",
    };
  }

  if (input.nextEpisodeTitleDuplicatesLastWatched) {
    return {
      category: 'POSSIBLE_DUPLICATE_EPISODE',
      reason: "the proposed next episode's title is suspiciously similar to the last-watched episode's title — possibly the same content under different numbering",
    };
  }

  if (input.isRecoveryFlipCandidate) {
    return {
      category: 'MANUAL_CAUGHT_UP_CANDIDATE',
      reason: 'this series was previously manually confirmed caught-up, and only reappeared because a new episode became available since — worth confirming whether it has already been watched elsewhere',
    };
  }

  return {
    category: 'SAFE_WATCH_NEXT',
    reason: 'not on the risk list, next episode data is complete, no season-shift orphan detected, no title-duplicate signal, and not a recovery-flip series',
  };
}
