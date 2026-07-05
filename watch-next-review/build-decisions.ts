// Pure logic for prefilling watch-next-decisions.json from an existing
// watch-next-manual-review.json. No I/O — testable without a database.
//
// This only ever prefills a DEFAULT decision per category — it is never the
// final word. A human can still edit the resulting JSON file by hand before
// it's ever fed to run-apply-decisions.ts, and run-apply-decisions.ts itself
// re-validates every mark_caught_up row against the live database before
// touching anything (see apply-logic.ts).

import { WatchNextReviewCategory } from './classify';
import { ManualDecision } from './reports';

export interface ReviewItemForDecision {
  mytvSeriesId: string;
  seriesTitle: string;
  category: WatchNextReviewCategory;
  userStatus: string;
  currentNextEpisode: { episodeId: string };
}

export interface WatchNextDecision {
  mytvSeriesId: string;
  seriesTitle: string;
  category: WatchNextReviewCategory;
  decision: ManualDecision;
  reason: string;
  // Captured at review/decision-build time — run-apply-decisions.ts compares
  // these against the CURRENT database state and skips the row if either has
  // drifted, rather than trusting a possibly-stale snapshot.
  reviewedUserStatus: string;
  reviewedNextEpisodeId: string;
}

// Explicit, narrow allow-list — deliberately NOT a default-to-mark_caught_up
// fallback. Only TVMAZE_SAYS_CAUGHT_UP is prefilled with an action; every
// other category defaults to a passive decision (ignore_for_now/
// needs_mapping) unless a specific, defensible recommendation exists for it.
const PREFILLED_DECISION: Partial<Record<WatchNextReviewCategory, ManualDecision>> = {
  KEEP_IN_WATCH_NEXT_CONFIDENT: 'keep_in_watch_next',
  TVMAZE_SAYS_CAUGHT_UP: 'mark_caught_up',
  REMAKE_COLLISION: 'needs_mapping',
  PROVIDER_EPISODE_COUNT_DISAGREEMENT: 'needs_mapping',
};

export function buildDecisions(items: ReviewItemForDecision[]): WatchNextDecision[] {
  return items.map((item) => {
    const decision = PREFILLED_DECISION[item.category] ?? 'ignore_for_now';
    return {
      mytvSeriesId: item.mytvSeriesId,
      seriesTitle: item.seriesTitle,
      category: item.category,
      decision,
      reason: decisionReason(item.category, decision),
      reviewedUserStatus: item.userStatus,
      reviewedNextEpisodeId: item.currentNextEpisode.episodeId,
    };
  });
}

function decisionReason(category: WatchNextReviewCategory, decision: ManualDecision): string {
  if (decision === 'mark_caught_up') {
    return `category is ${category} and the user confirmed everything actually released has been watched`;
  }
  if (decision === 'keep_in_watch_next') {
    return `category is ${category} — both providers agree, safe to leave as-is`;
  }
  if (decision === 'needs_mapping') {
    return `category is ${category} — a candidate/count ambiguity exists that needs manual confirmation before any change`;
  }
  return `category is ${category} — no automatic action; left for manual follow-up`;
}
