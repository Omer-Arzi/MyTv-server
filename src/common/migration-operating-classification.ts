// The single top-level operating outcome shared across both apply
// pipelines — library-health (catalog migration/reconciliation) and
// episode-release-refresh (ongoing release refresh). Lives here, not in
// either pipeline's own directory, for the same reason
// stale-series-trust.ts/derive-user-status.ts/is-episode-released.ts do:
// src/common/ is the neutral location both already depend on, so neither
// pipeline has to import the other's directory to share this vocabulary.
//
// This is explicitly an ADDITIVE summary layer, not a replacement for
// either pipeline's existing detailed classification (DryRunClassification/
// MigrationClassification in library-health, RefreshClassification in
// episode-release-refresh). Every report continues to carry the specific
// reason codes it always has; this only adds one more field answering
// "what should a human glancing at a report do about this title," so a
// full-library dry run can be summarized without forcing a reader to know
// two separate classification vocabularies.

export type MigrationOperatingClassification = 'AUTO_MIGRATE' | 'AUTO_REFRESH' | 'REVIEW_IDENTITY' | 'REVIEW_ALIGNMENT' | 'PROVIDER_ERROR';

export const MIGRATION_OPERATING_CLASSIFICATION_LABELS: Record<MigrationOperatingClassification, string> = {
  AUTO_MIGRATE: 'Auto-migrate — objectively safe catalog reconciliation',
  AUTO_REFRESH: 'Auto-refresh — already reconciled, ongoing maintenance only',
  REVIEW_IDENTITY: 'Review — provider identity risk',
  REVIEW_ALIGNMENT: 'Review — catalog/watch-history alignment risk',
  PROVIDER_ERROR: 'Provider fetch error',
};
