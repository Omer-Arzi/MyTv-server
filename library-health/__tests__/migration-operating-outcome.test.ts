import { classifyMigrationOperatingOutcome } from '../migration-operating-outcome';

const base = {
  providerFetchFailed: false,
  hasConfirmedIdentity: true,
  titleYearSanityPassed: true,
  identityBand: 'HIGH_CONFIDENCE' as const,
  realSeasonShrinkDetected: false,
  engineInvariantViolated: false,
  hasPendingCatalogWork: true,
};

describe('classifyMigrationOperatingOutcome', () => {
  it('is PROVIDER_ERROR whenever the fetch failed, regardless of everything else', () => {
    expect(classifyMigrationOperatingOutcome({ ...base, providerFetchFailed: true, titleYearSanityPassed: false, realSeasonShrinkDetected: true })).toBe('PROVIDER_ERROR');
  });

  it('is REVIEW_IDENTITY when there is no confirmed decision-file entry at all', () => {
    expect(classifyMigrationOperatingOutcome({ ...base, hasConfirmedIdentity: false })).toBe('REVIEW_IDENTITY');
  });

  it('is REVIEW_IDENTITY when title/year sanity fails', () => {
    expect(classifyMigrationOperatingOutcome({ ...base, titleYearSanityPassed: false, identityBand: 'FAILED' })).toBe('REVIEW_IDENTITY');
  });

  it('is REVIEW_IDENTITY when the identity band is FAILED', () => {
    expect(classifyMigrationOperatingOutcome({ ...base, identityBand: 'FAILED' })).toBe('REVIEW_IDENTITY');
  });

  it('is REVIEW_ALIGNMENT for a real season shrink, even with confirmed identity', () => {
    expect(classifyMigrationOperatingOutcome({ ...base, realSeasonShrinkDetected: true })).toBe('REVIEW_ALIGNMENT');
  });

  it('is REVIEW_ALIGNMENT for an engine invariant violation', () => {
    expect(classifyMigrationOperatingOutcome({ ...base, engineInvariantViolated: true })).toBe('REVIEW_ALIGNMENT');
  });

  it('is AUTO_MIGRATE when identity/structure are safe and there is pending catalog work', () => {
    expect(classifyMigrationOperatingOutcome({ ...base, hasPendingCatalogWork: true })).toBe('AUTO_MIGRATE');
  });

  it('is AUTO_REFRESH when identity/structure are safe but there is nothing left to reconcile', () => {
    expect(classifyMigrationOperatingOutcome({ ...base, hasPendingCatalogWork: false })).toBe('AUTO_REFRESH');
  });

  it('is BORDERLINE-identity-safe: a BORDERLINE band alone does not force REVIEW_IDENTITY', () => {
    expect(classifyMigrationOperatingOutcome({ ...base, identityBand: 'BORDERLINE' })).toBe('AUTO_MIGRATE');
  });

  it('priority order: identity failure wins over a simultaneous season shrink', () => {
    expect(classifyMigrationOperatingOutcome({ ...base, identityBand: 'FAILED', titleYearSanityPassed: false, realSeasonShrinkDetected: true })).toBe('REVIEW_IDENTITY');
  });
});
