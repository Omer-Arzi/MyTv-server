// Pure classification logic for the TV Time parity audit. No I/O —
// testable without a database. Priority-ordered: each series gets exactly
// one category, checked most-specific/actionable first.

export type ParityIssueCategory =
  | 'NOT_IN_TVTIME_EXPORT'
  | 'TITLE_MISMATCH'
  | 'POSSIBLE_PROVIDER_MISMATCH'
  | 'FOUND_BUT_STATUS_BLOCKED'
  | 'FOUND_WITH_INCOMPLETE_CATALOG'
  | 'NEEDS_PROVIDER_MATCH'
  | 'FOUND_UNENRICHED'
  | 'FOUND_BUT_NO_NEXT_EPISODE'
  | 'FOUND_BUT_AIRDATE_FILTERED'
  | 'FOUND_ENRICHED';

export type RecommendedAction = 'SAFE_TARGETED_ENRICHMENT' | 'MANUAL_PROVIDER_MAPPING' | 'SEARCH_ADD_NEEDED' | 'LEAVE_UNTOUCHED' | 'ALREADY_OK';

export interface ClassifyParityInput {
  hasDbMatch: boolean;
  isAmbiguousMultipleMatch: boolean;
  isPossibleProviderMismatch: boolean;
  userStatus: string | null; // null when there's no UserSeriesProgress row at all
  hasTmdbMatch: boolean;
  hasProviderCandidate: boolean; // a TMDb or TVmaze needs-review candidate exists
  dbEpisodeCount: number;
  providerKnownEpisodeCount: number | null; // max of TMDb/TVmaze known totals, if any
  nextEpisodeId: string | null;
  nextEpisodeAirDateIsFuture: boolean;
}

export interface ClassifyParityResult {
  category: ParityIssueCategory;
  recommendedAction: RecommendedAction;
  reason: string;
}

const STATUS_BLOCKED_FROM_WATCH_NEXT = new Set(['DROPPED', 'PAUSED', 'WATCHLIST', 'COMPLETED']);
const ACTIVE_STATUSES = new Set(['WATCHING', 'CAUGHT_UP']);

export function classifyParity(input: ClassifyParityInput): ClassifyParityResult {
  if (!input.hasDbMatch) {
    return {
      category: 'NOT_IN_TVTIME_EXPORT',
      recommendedAction: 'SEARCH_ADD_NEEDED',
      reason: 'no series in the current database matches this title, any alias, or a loose substring variant',
    };
  }

  if (input.isAmbiguousMultipleMatch) {
    return {
      category: 'TITLE_MISMATCH',
      recommendedAction: 'MANUAL_PROVIDER_MAPPING',
      reason: 'more than one current series plausibly corresponds to this TV Time title — needs a human to say which (or whether both) are correct',
    };
  }

  if (input.isPossibleProviderMismatch) {
    return {
      category: 'POSSIBLE_PROVIDER_MISMATCH',
      recommendedAction: 'MANUAL_PROVIDER_MAPPING',
      reason: 'a provider candidate exists but is flagged as a likely remake/reboot/duplicate-title collision — confirm the match before applying anything',
    };
  }

  if (input.userStatus !== null && STATUS_BLOCKED_FROM_WATCH_NEXT.has(input.userStatus)) {
    return {
      category: 'FOUND_BUT_STATUS_BLOCKED',
      recommendedAction: 'LEAVE_UNTOUCHED',
      reason: `userStatus is ${input.userStatus}, which Watch Next/Haven't Watched deliberately exclude by design — not a data problem`,
    };
  }

  if (input.providerKnownEpisodeCount !== null && input.providerKnownEpisodeCount > input.dbEpisodeCount) {
    return {
      category: 'FOUND_WITH_INCOMPLETE_CATALOG',
      recommendedAction: input.hasTmdbMatch ? 'MANUAL_PROVIDER_MAPPING' : 'SAFE_TARGETED_ENRICHMENT',
      reason: `provider reports ${input.providerKnownEpisodeCount} known episodes but only ${input.dbEpisodeCount} exist in the database — catalog is missing the unwatched remainder`,
    };
  }

  if (!input.hasTmdbMatch && input.hasProviderCandidate) {
    return {
      category: 'NEEDS_PROVIDER_MATCH',
      recommendedAction: 'SAFE_TARGETED_ENRICHMENT',
      reason: 'not yet enriched, but a specific TMDb/TVmaze candidate is already on file for this series',
    };
  }

  if (!input.hasTmdbMatch) {
    return {
      category: 'FOUND_UNENRICHED',
      recommendedAction: 'MANUAL_PROVIDER_MAPPING',
      reason: 'not yet enriched and no provider candidate is on file — needs a fresh provider search',
    };
  }

  if (input.userStatus !== null && ACTIVE_STATUSES.has(input.userStatus) && !input.nextEpisodeId) {
    return {
      category: 'FOUND_BUT_NO_NEXT_EPISODE',
      recommendedAction: 'LEAVE_UNTOUCHED',
      reason: 'enriched, catalog looks complete, but no unwatched released episode was found — likely genuinely caught up',
    };
  }

  if (input.nextEpisodeId && input.nextEpisodeAirDateIsFuture) {
    return {
      category: 'FOUND_BUT_AIRDATE_FILTERED',
      recommendedAction: 'LEAVE_UNTOUCHED',
      reason: "next episode exists but hasn't aired yet — correctly excluded from Watch Next by design, not a bug",
    };
  }

  return {
    category: 'FOUND_ENRICHED',
    recommendedAction: 'ALREADY_OK',
    reason: 'enriched, catalog looks complete, and Watch Next/stale-series status reflects the real state correctly',
  };
}
