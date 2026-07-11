// Maps library-health's detailed signals onto the shared top-level
// MigrationOperatingClassification (src/common/migration-operating-classification.ts).
// Additive only — every detailed reason code (DryRunClassification,
// MigrationClassification, identity band, specific warnings) stays exactly
// as reported today; this is one more derived field, not a replacement.

import { MigrationOperatingClassification } from '../src/common/migration-operating-classification';
import { IdentityConfidenceBand } from './migration-policy-logic';

export interface ClassifyMigrationOperatingOutcomeInput {
  providerFetchFailed: boolean;
  // False when there is no confirmed decision-file entry for this title at
  // all (provider/providerId missing) — the one permanent human gate (see
  // docs/stable-version-migration-todo.md's Phase 1 baseline audit).
  hasConfirmedIdentity: boolean;
  titleYearSanityPassed: boolean;
  identityBand: IdentityConfidenceBand;
  realSeasonShrinkDetected: boolean;
  engineInvariantViolated: boolean;
  // True when there is nothing left for catalog reconciliation to do —
  // ExternalIds already matches, no missing episodes to create, no
  // matched-episode metadata to backfill, no poster change pending. A
  // series in this state belongs to ongoing release refresh, not initial
  // migration.
  hasPendingCatalogWork: boolean;
}

export function classifyMigrationOperatingOutcome(input: ClassifyMigrationOperatingOutcomeInput): MigrationOperatingClassification {
  if (input.providerFetchFailed) return 'PROVIDER_ERROR';
  if (!input.hasConfirmedIdentity || !input.titleYearSanityPassed || input.identityBand === 'FAILED') return 'REVIEW_IDENTITY';
  if (input.realSeasonShrinkDetected || input.engineInvariantViolated) return 'REVIEW_ALIGNMENT';
  if (!input.hasPendingCatalogWork) return 'AUTO_REFRESH';
  return 'AUTO_MIGRATE';
}
