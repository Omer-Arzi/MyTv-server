// Pure classification: "does this series' progress carry a trust caveat a
// user-facing card should flag?" No I/O, no Prisma. A shared utility (not
// owned by any one module) — reused by WatchlistService (attentionReasonCode
// badges) and MigrationWorkbenchService (the No Reliable Provider /
// numbering-risk buckets) alike, so the two never quietly disagree about
// what counts as untrustworthy. Reuses the project's existing canonical
// signals rather than inventing new ones:
//   - hasConfirmedProviderMatch (src/common/has-confirmed-external-id.ts) —
//     the same definition SeriesService.getDetail already uses.
//   - isUntrustedNextEpisodeTitle (src/common/stale-series-trust.ts) — the
//     same risk list episode-release-refresh's checkSeriesEligibility and
//     me-query-helpers.ts's staleness trust already consult.
//   - MigrationOperatingClassification (src/common/migration-operating-classification.ts)
//     — the same top-level vocabulary library-health's provider-confirmation
//     pipeline reports already use for "what should a human do about this."
//
// Deliberately DB-only: no live TMDb/provider call happens here, so this
// can never return the pipeline's richer classifications (AUTO_MIGRATE,
// BLOCKED_RISK, etc.) — those genuinely require a fresh provider fetch,
// which MigrationWorkbenchService gets from the library-health CLI
// pipeline's cached reports instead of duplicating here. This only ever
// answers two DB-derivable questions: "does this series have any confirmed
// provider match at all," and "is it on the known episode-numbering/
// season-shift risk list."

import { isUntrustedNextEpisodeTitle } from './stale-series-trust';
import { MigrationOperatingClassification } from './migration-operating-classification';

export type SeriesAttentionCategory = 'NO_CONFIRMED_PROVIDER_MATCH' | 'KNOWN_RISK_LIST';
export type SeriesAttentionSeverity = 'info' | 'warning' | 'blocked';

export interface ClassifySeriesForAttentionInput {
  title: string;
  hasConfirmedProviderMatch: boolean;
}

export interface SeriesAttentionClassification {
  category: SeriesAttentionCategory;
  severity: SeriesAttentionSeverity;
  reasonCode: string;
  summary: string;
  // Reused verbatim from the shared top-level vocabulary — never a new,
  // parallel enum. 'blocked' severity / other operating classifications
  // (AUTO_MIGRATE, PROVIDER_ERROR, etc.) are intentionally unreachable
  // here — they only ever result from a live classification pass this
  // DB-only function doesn't perform.
  classification: MigrationOperatingClassification;
}

// Returns null when the series has nothing to flag — the common case.
// Checked in a fixed priority order: a series with NO confirmed match
// at all is reported as that (the identity question is more fundamental
// than any numbering-risk question, which doesn't even apply until an
// identity is confirmed) — a series is never flagged for both at once.
export function classifySeriesForAttention(input: ClassifySeriesForAttentionInput): SeriesAttentionClassification | null {
  if (!input.hasConfirmedProviderMatch) {
    return {
      category: 'NO_CONFIRMED_PROVIDER_MATCH',
      severity: 'info',
      reasonCode: 'no-confirmed-provider-match',
      summary: 'No confirmed provider match yet — MyTV cannot verify this series\' full episode catalog or auto-manage its progress until one is confirmed.',
      classification: 'REVIEW_IDENTITY',
    };
  }

  if (isUntrustedNextEpisodeTitle(input.title)) {
    return {
      category: 'KNOWN_RISK_LIST',
      severity: 'warning',
      reasonCode: 'known-episode-numbering-risk',
      summary: 'On the known episode-numbering/season-shift risk list — automated catalog and progress updates are held back for this series until reviewed.',
      classification: 'REVIEW_ALIGNMENT',
    };
  }

  return null;
}
