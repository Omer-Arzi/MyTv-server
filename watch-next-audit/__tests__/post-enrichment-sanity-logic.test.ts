import { classifyWatchNextSanity, ClassifyWatchNextSanityInput } from '../post-enrichment-sanity-logic';

function baseInput(overrides: Partial<ClassifyWatchNextSanityInput> = {}): ClassifyWatchNextSanityInput {
  return {
    isOnRiskList: false,
    nextEpisodeDataIncomplete: false,
    hasKnownSeasonShiftOrphan: false,
    nextEpisodeTitleDuplicatesLastWatched: false,
    isRecoveryFlipCandidate: false,
    ...overrides,
  };
}

describe('classifyWatchNextSanity', () => {
  it('is SAFE_WATCH_NEXT when every signal is clean', () => {
    expect(classifyWatchNextSanity(baseInput()).category).toBe('SAFE_WATCH_NEXT');
  });

  it('is RISK_LIST_DO_NOT_TRUST when on the documented risk list', () => {
    expect(classifyWatchNextSanity(baseInput({ isOnRiskList: true })).category).toBe('RISK_LIST_DO_NOT_TRUST');
  });

  it('is NEEDS_USER_CONFIRMATION when next-episode data is incomplete', () => {
    expect(classifyWatchNextSanity(baseInput({ nextEpisodeDataIncomplete: true })).category).toBe('NEEDS_USER_CONFIRMATION');
  });

  it('is POSSIBLE_SEASON_SHIFT when a known orphan exists', () => {
    expect(classifyWatchNextSanity(baseInput({ hasKnownSeasonShiftOrphan: true })).category).toBe('POSSIBLE_SEASON_SHIFT');
  });

  it('is POSSIBLE_DUPLICATE_EPISODE when the title-similarity signal fires', () => {
    expect(classifyWatchNextSanity(baseInput({ nextEpisodeTitleDuplicatesLastWatched: true })).category).toBe('POSSIBLE_DUPLICATE_EPISODE');
  });

  it('is MANUAL_CAUGHT_UP_CANDIDATE for a recovery-flip series with no other flags', () => {
    expect(classifyWatchNextSanity(baseInput({ isRecoveryFlipCandidate: true })).category).toBe('MANUAL_CAUGHT_UP_CANDIDATE');
  });

  it('prioritizes RISK_LIST_DO_NOT_TRUST over every other signal', () => {
    const result = classifyWatchNextSanity(
      baseInput({ isOnRiskList: true, hasKnownSeasonShiftOrphan: true, nextEpisodeTitleDuplicatesLastWatched: true, isRecoveryFlipCandidate: true }),
    );
    expect(result.category).toBe('RISK_LIST_DO_NOT_TRUST');
  });

  it('prioritizes incomplete-data check over season-shift/duplicate/recovery-flip', () => {
    const result = classifyWatchNextSanity(baseInput({ nextEpisodeDataIncomplete: true, hasKnownSeasonShiftOrphan: true, isRecoveryFlipCandidate: true }));
    expect(result.category).toBe('NEEDS_USER_CONFIRMATION');
  });

  it('prioritizes season-shift over duplicate-title and recovery-flip', () => {
    const result = classifyWatchNextSanity(baseInput({ hasKnownSeasonShiftOrphan: true, nextEpisodeTitleDuplicatesLastWatched: true, isRecoveryFlipCandidate: true }));
    expect(result.category).toBe('POSSIBLE_SEASON_SHIFT');
  });

  it('prioritizes duplicate-title over recovery-flip', () => {
    const result = classifyWatchNextSanity(baseInput({ nextEpisodeTitleDuplicatesLastWatched: true, isRecoveryFlipCandidate: true }));
    expect(result.category).toBe('POSSIBLE_DUPLICATE_EPISODE');
  });
});
