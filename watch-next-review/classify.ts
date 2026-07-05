// Pure classification logic for the Watch Next manual-review report. No I/O
// — testable without a database or network, same pattern as every other
// pure logic module in this repo (is-episode-released.ts,
// watch-next-audit/audit-logic.ts, secondary-provider-audit/tvmaze-compare.ts).
//
// This never decides anything on its own behalf — every category here is a
// prompt for a human to make the actual keep/caught-up/mapping/ignore call
// (see reports.ts's decision field), not an automatic fix.

export type WatchNextReviewCategory =
  | 'KEEP_IN_WATCH_NEXT_CONFIDENT'
  | 'PROVIDER_EPISODE_COUNT_DISAGREEMENT'
  | 'TVMAZE_SAYS_CAUGHT_UP'
  | 'TVMAZE_NEXT_IS_TBA'
  | 'NO_SECONDARY_PROVIDER_MATCH'
  | 'REMAKE_COLLISION'
  | 'NEEDS_MANUAL_DECISION';

export interface ClassifyWatchNextItemInput {
  hasTmdbMatch: boolean;
  hasSecondaryProviderMatch: boolean;
  isRemakeCollision: boolean;
  tvmazeThinksCaughtUpByPosition: boolean;
  tvmazeNextEpisodeIsTBA: boolean;
  mytvKnownEpisodeCount: number;
  tvmazeKnownEpisodeCount: number | null;
}

export interface ClassifyWatchNextItemResult {
  category: WatchNextReviewCategory;
  reason: string;
}

// Same ratio-of-drift tolerance used throughout this repo's enrichment/audit
// tooling: a difference this small is normal (a missed special, one provider
// lagging a newly-aired episode), not a real disagreement worth flagging.
const EPISODE_COUNT_AGREEMENT_TOLERANCE = 2;

export function classifyWatchNextItem(input: ClassifyWatchNextItemInput): ClassifyWatchNextItemResult {
  if (!input.hasSecondaryProviderMatch) {
    return { category: 'NO_SECONDARY_PROVIDER_MATCH', reason: 'TVmaze has no candidate for this series — only MyTv/TMDb data is available' };
  }

  if (input.isRemakeCollision) {
    return { category: 'REMAKE_COLLISION', reason: 'TVmaze search returned a same-titled or near-identical-scoring competitor — the matched candidate may be the wrong show entirely' };
  }

  if (input.tvmazeNextEpisodeIsTBA) {
    return { category: 'TVMAZE_NEXT_IS_TBA', reason: 'TVmaze\'s own catalog has no real episode at the position after what\'s watched (placeholder "TBA" title) — TVmaze cannot confirm this either' };
  }

  if (input.tvmazeThinksCaughtUpByPosition) {
    return {
      category: 'TVMAZE_SAYS_CAUGHT_UP',
      reason: 'watched count already reaches or exceeds every episode TVmaze knows about for this series — TVmaze would consider this series caught up, while MyTv/TMDb still shows a next episode',
    };
  }

  const tvmazeCountKnown = input.tvmazeKnownEpisodeCount !== null;
  const countsAgree = tvmazeCountKnown && Math.abs(input.mytvKnownEpisodeCount - input.tvmazeKnownEpisodeCount!) <= EPISODE_COUNT_AGREEMENT_TOLERANCE;

  if (tvmazeCountKnown && !countsAgree) {
    return {
      category: 'PROVIDER_EPISODE_COUNT_DISAGREEMENT',
      reason: `MyTv/TMDb knows ${input.mytvKnownEpisodeCount} episodes but TVmaze knows ${input.tvmazeKnownEpisodeCount} — providers disagree on the catalog size`,
    };
  }

  if (input.hasTmdbMatch && countsAgree) {
    return { category: 'KEEP_IN_WATCH_NEXT_CONFIDENT', reason: 'TMDb match confirmed, TVmaze independently agrees on episode count, no collision or TBA/caught-up signal' };
  }

  return { category: 'NEEDS_MANUAL_DECISION', reason: 'no single signal above resolves this cleanly — needs a human look' };
}
