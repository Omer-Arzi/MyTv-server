// Maps episode-release-refresh's RefreshClassification onto the shared
// top-level MigrationOperatingClassification. Additive only — the specific
// RefreshClassification, bulkInsertReason, seasonZeroReason, and warnings
// on every report entry stay exactly as they are; this is one more derived
// field.
//
// REVIEW_IDENTITY never originates here: episode-release-refresh only ever
// operates on series that already have a confirmed tmdbId
// (checkSeriesEligibility requires it) — discovering identity is
// exclusively library-health's job, by design (see
// docs/stable-version-migration-todo.md's Phase 1 baseline audit).

import { RefreshClassification } from './refresh-logic';
import { MigrationOperatingClassification } from '../src/common/migration-operating-classification';

export interface RefreshOperatingOutcome {
  operatingClassification: MigrationOperatingClassification;
  // Non-null only for SUSPICIOUS_BULK_INSERT — distinguishes "this needs a
  // human to look at a genuine risk" from "this needs the OTHER pipeline,
  // not a human," so a report reader doesn't confuse a routing signal with
  // a watched-history alignment risk. See Phase 5 of the stable-version
  // migration task: a large catalog-completion gap is not itself a
  // release-refresh safety failure — it's evidence the title belongs back
  // in catalog reconciliation (library-health), which is the only place
  // in the codebase that can actually create the missing rows during an
  // initial migration pass rather than piecemeal via ongoing refresh.
  routingNote: string | null;
}

export function classifyRefreshOperatingOutcome(classification: RefreshClassification): RefreshOperatingOutcome {
  switch (classification) {
    case 'PROVIDER_ERROR':
      return { operatingClassification: 'PROVIDER_ERROR', routingNote: null };
    case 'NEEDS_MANUAL_REVIEW':
    case 'RISKY_DO_NOT_APPLY':
    case 'SEASON_ZERO_PROPOSED':
      return { operatingClassification: 'REVIEW_ALIGNMENT', routingNote: null };
    case 'SUSPICIOUS_BULK_INSERT':
      return {
        operatingClassification: 'REVIEW_ALIGNMENT',
        routingNote:
          'This is a catalog-completeness gap, not a watch-history risk — episode-release-refresh is insert-only and cannot corrupt history here. Re-run this title through library-health\'s catalog reconciliation pipeline (which can create missing seasons/episodes as part of an initial migration pass) instead of waiting for it to clear this threshold via ongoing refresh.',
      };
    case 'NO_CHANGE':
    case 'FUTURE_ONLY':
    case 'NEW_RELEASE_AVAILABLE':
      return { operatingClassification: 'AUTO_REFRESH', routingNote: null };
  }
}
