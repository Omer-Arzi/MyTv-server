import { classifyMissingImage, ClassifyMissingImageInput } from '../classify';

function baseInput(overrides: Partial<ClassifyMissingImageInput> = {}): ClassifyMissingImageInput {
  return {
    hasTmdbMatch: false,
    hasPriorDryRunData: true,
    isPossibleMismatch: false,
    ...overrides,
  };
}

describe('classifyMissingImage', () => {
  it('is ENRICHED_BUT_PROVIDER_HAS_NO_IMAGE when a TMDb match exists', () => {
    const result = classifyMissingImage(baseInput({ hasTmdbMatch: true }));
    expect(result.category).toBe('ENRICHED_BUT_PROVIDER_HAS_NO_IMAGE');
  });

  it('is POSSIBLE_PROVIDER_MISMATCH when flagged as a likely mismatch, even without a TMDb match', () => {
    const result = classifyMissingImage(baseInput({ isPossibleMismatch: true }));
    expect(result.category).toBe('POSSIBLE_PROVIDER_MISMATCH');
  });

  it('is NOT_ENRICHED_YET when there is no prior dry-run data at all', () => {
    const result = classifyMissingImage(baseInput({ hasPriorDryRunData: false }));
    expect(result.category).toBe('NOT_ENRICHED_YET');
  });

  it('is MANUAL_REVIEW_NO_SAFE_MATCH when a dry run was attempted but nothing safe was found', () => {
    const result = classifyMissingImage(baseInput({ hasPriorDryRunData: true, isPossibleMismatch: false }));
    expect(result.category).toBe('MANUAL_REVIEW_NO_SAFE_MATCH');
  });

  it('prioritizes ENRICHED_BUT_PROVIDER_HAS_NO_IMAGE over a mismatch flag', () => {
    const result = classifyMissingImage(baseInput({ hasTmdbMatch: true, isPossibleMismatch: true }));
    expect(result.category).toBe('ENRICHED_BUT_PROVIDER_HAS_NO_IMAGE');
  });

  it('prioritizes POSSIBLE_PROVIDER_MISMATCH over NOT_ENRICHED_YET', () => {
    const result = classifyMissingImage(baseInput({ hasPriorDryRunData: false, isPossibleMismatch: true }));
    expect(result.category).toBe('POSSIBLE_PROVIDER_MISMATCH');
  });
});
