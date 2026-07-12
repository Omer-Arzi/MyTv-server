// The canonical, provider-agnostic search-result shape — combines external
// discovery metadata with this user's local-library state and the one
// action their card should offer. One result per real-world series after
// federation/dedup (search-provider-fanout.ts) and local-match resolution
// (search-matching-logic.ts) have both run.
//
// `libraryMatch.EXACT` deliberately covers BOTH a fully-confirmed, trusted
// library series AND one whose identity/structure still needs review
// (needsAttention: true) — these are the same underlying thing (a series
// that already exists locally) with different trust levels, not two
// separate result kinds. Mirrors the approved mobile UX spec: a Needs
// Review card still opens Series Detail on a body tap like any other
// existing-library card, it just also carries a review affordance.

import { UserSeriesStatus } from '@prisma/client';

export type SearchProvider = 'tmdb' | 'tvmaze';

export interface SearchResultNextEpisode {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
}

export type SearchResultLibraryMatch =
  | {
      type: 'EXACT';
      seriesId: string;
      userStatus: UserSeriesStatus;
      nextEpisode: SearchResultNextEpisode | null;
      needsAttention: boolean;
      attentionReasonCode: string | null;
    }
  | {
      type: 'POSSIBLE';
      seriesId: string;
      seriesTitle: string;
      seriesUserStatus: UserSeriesStatus;
      // Canonical 0..1 scale — same convention as ProviderCandidateDto.confidenceScore.
      confidence: number;
      reason: string;
    }
  | { type: 'NONE' };

export type SearchPrimaryAction = 'OPEN_SERIES' | 'REVIEW_SERIES' | 'COMPARE_MATCH' | 'ADD_TO_WATCHLIST';

export interface SeriesSearchResult {
  resultKey: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  // The candidate's own provider identity — always exactly one entry today
  // (federation only collapses two provider hits into one card when they
  // already resolve to the same LOCAL series, see search-provider-fanout.ts;
  // it never speculatively crosswalks two un-owned external results). Kept
  // as an array so a future real crosswalk can add a second entry without
  // a contract change.
  providers: Array<{ provider: SearchProvider; providerId: string }>;
  libraryMatch: SearchResultLibraryMatch;
  primaryAction: SearchPrimaryAction;
  relevanceScore: number;
}

export interface SearchResultsPage {
  results: SeriesSearchResult[];
  nextCursor: string | null;
  // True when at least one provider failed for this query but the other(s)
  // still returned usable results — the mobile partial-failure banner.
  hadProviderFailure: boolean;
}
