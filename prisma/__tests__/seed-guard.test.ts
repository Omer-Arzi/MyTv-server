import { evaluateSeedSafety, SeedSafetyInput } from '../seed-guard';

function baseInput(overrides: Partial<SeedSafetyInput> = {}): SeedSafetyInput {
  return {
    allowDestructiveFlagSet: true,
    importBatchCount: 0,
    taggedRowCount: 0,
    ...overrides,
  };
}

describe('evaluateSeedSafety', () => {
  it('is safe when there are no real-data signals and the flag is set', () => {
    expect(evaluateSeedSafety(baseInput()).safe).toBe(true);
  });

  it('refuses when the flag is not set, even with no real data', () => {
    const result = evaluateSeedSafety(baseInput({ allowDestructiveFlagSet: false }));
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/ALLOW_DESTRUCTIVE_SEED/);
  });

  it('refuses when ImportBatch rows exist, even with the flag set', () => {
    const result = evaluateSeedSafety(baseInput({ importBatchCount: 3 }));
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/real imported data/);
  });

  it('refuses when tagged rows exist, even with the flag set', () => {
    const result = evaluateSeedSafety(baseInput({ taggedRowCount: 433 }));
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/real imported data/);
  });

  it('refuses when both real-data signals exist and the flag is not set', () => {
    const result = evaluateSeedSafety(baseInput({ allowDestructiveFlagSet: false, importBatchCount: 1, taggedRowCount: 1 }));
    expect(result.safe).toBe(false);
  });

  it('prioritizes the real-data refusal reason over the missing-flag reason', () => {
    const result = evaluateSeedSafety({ allowDestructiveFlagSet: false, importBatchCount: 1, taggedRowCount: 0 });
    expect(result.reason).toMatch(/real imported data/);
  });
});
