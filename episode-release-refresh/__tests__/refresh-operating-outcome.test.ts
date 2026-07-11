import { classifyRefreshOperatingOutcome } from '../refresh-operating-outcome';
import { RefreshClassification } from '../refresh-logic';

describe('classifyRefreshOperatingOutcome', () => {
  it.each<[RefreshClassification, string]>([
    ['NO_CHANGE', 'AUTO_REFRESH'],
    ['FUTURE_ONLY', 'AUTO_REFRESH'],
    ['NEW_RELEASE_AVAILABLE', 'AUTO_REFRESH'],
  ])('maps %s to %s with no routing note', (classification, expected) => {
    const result = classifyRefreshOperatingOutcome(classification);
    expect(result.operatingClassification).toBe(expected);
    expect(result.routingNote).toBeNull();
  });

  it.each<RefreshClassification>(['NEEDS_MANUAL_REVIEW', 'RISKY_DO_NOT_APPLY', 'SEASON_ZERO_PROPOSED'])('maps %s to REVIEW_ALIGNMENT with no routing note', (classification) => {
    const result = classifyRefreshOperatingOutcome(classification);
    expect(result.operatingClassification).toBe('REVIEW_ALIGNMENT');
    expect(result.routingNote).toBeNull();
  });

  it('maps PROVIDER_ERROR directly, no routing note', () => {
    const result = classifyRefreshOperatingOutcome('PROVIDER_ERROR');
    expect(result.operatingClassification).toBe('PROVIDER_ERROR');
    expect(result.routingNote).toBeNull();
  });

  // The one classification that gets a distinct routing note — a
  // catalog-completeness gap is not the same kind of "review" as a real
  // watched-slot misalignment, and the note must say so explicitly so a
  // report reader doesn't conflate the two.
  it('maps SUSPICIOUS_BULK_INSERT to REVIEW_ALIGNMENT WITH a routing note pointing at catalog reconciliation', () => {
    const result = classifyRefreshOperatingOutcome('SUSPICIOUS_BULK_INSERT');
    expect(result.operatingClassification).toBe('REVIEW_ALIGNMENT');
    expect(result.routingNote).not.toBeNull();
    expect(result.routingNote).toContain('catalog reconciliation');
  });

  it('never produces REVIEW_IDENTITY for any classification — identity discovery is exclusively library-healths job', () => {
    const allClassifications: RefreshClassification[] = [
      'NO_CHANGE', 'FUTURE_ONLY', 'NEW_RELEASE_AVAILABLE', 'NEEDS_MANUAL_REVIEW', 'RISKY_DO_NOT_APPLY', 'SUSPICIOUS_BULK_INSERT', 'SEASON_ZERO_PROPOSED', 'PROVIDER_ERROR',
    ];
    for (const c of allClassifications) {
      expect(classifyRefreshOperatingOutcome(c).operatingClassification).not.toBe('REVIEW_IDENTITY');
    }
  });
});
