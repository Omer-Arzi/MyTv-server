import { UserSeriesStatus } from '@prisma/client';
import { CompareSeriesCatalogResult } from '../../episode-release-refresh/refresh-logic';
import { checkTitleYearSanity, classifyProviderConfirmationDryRun } from '../provider-confirmation-decisions-logic';
import { checkBenignSeasonZeroOrphan, EpisodeSeasonPosition, SeasonZeroOrphanCheckResult } from '../season-zero-orphan-logic';
import { checkSplitEpisodeTailOnly } from '../split-episode-tail-logic';

function fakeComparison(overrides: Partial<CompareSeriesCatalogResult> = {}): CompareSeriesCatalogResult {
  return {
    classification: 'NO_CHANGE',
    bulkInsertReason: null,
    seasonZeroReason: null,
    warnings: [],
    newEpisodes: [],
    releasedNewEpisodeCount: 0,
    futureNewEpisodeCount: 0,
    fieldChanges: [],
    releaseStatusChange: null,
    proposedNextEpisodeId: null,
    proposedNextEpisodeLabel: null,
    proposedNextEpisodeIsNew: false,
    proposedNextSeasonNumber: null,
    proposedNextEpisodeNumber: null,
    nextEpisodeWouldChange: false,
    proposedUserStatus: UserSeriesStatus.WATCHING,
    userStatusWouldChangeToWatching: false,
    ...overrides,
  };
}

describe('checkTitleYearSanity', () => {
  it('passes for an exact title match with no year hint', () => {
    const result = checkTitleYearSanity({ localTitle: 'Friends', candidateTitle: 'Friends', candidateYear: 1994 });
    expect(result.passed).toBe(true);
  });

  it('fails for an exact title match with sharply differing years (remake/reboot signal)', () => {
    const result = checkTitleYearSanity({ localTitle: 'Doctor Who (2005)', candidateTitle: 'Doctor Who', candidateYear: 1963 });
    // local hint's bare title strips the "(2005)" suffix but keeps the
    // year hint itself — exact title match, year hint 2005 vs candidate 1963.
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/year/);
  });

  it('passes for a close year difference (off by 1)', () => {
    const result = checkTitleYearSanity({ localTitle: 'Some Show (2020)', candidateTitle: 'Some Show', candidateYear: 2021 });
    expect(result.passed).toBe(true);
  });

  it('fails for a candidate title that does not resemble the local title at all', () => {
    const result = checkTitleYearSanity({ localTitle: 'Friends', candidateTitle: 'Completely Unrelated Show Title', candidateYear: null });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/does not resemble/);
  });

  it('passes for a reasonably similar but non-exact title', () => {
    const result = checkTitleYearSanity({ localTitle: 'The Office (US)', candidateTitle: 'The Office', candidateYear: null });
    expect(result.passed).toBe(true);
  });
});

describe('classifyProviderConfirmationDryRun', () => {
  const passingSanity = { passed: true, reason: 'exact title match' };

  it('classifies SAFE_TO_APPLY_LATER when sanity passes and the comparison finds no risk', () => {
    const result = classifyProviderConfirmationDryRun({ titleYearSanity: passingSanity, comparison: fakeComparison({ classification: 'NO_CHANGE' }) });
    expect(result.classification).toBe('SAFE_TO_APPLY_LATER');
  });

  it('classifies SAFE_TO_APPLY_LATER when new episodes are found but nothing is risky', () => {
    const result = classifyProviderConfirmationDryRun({ titleYearSanity: passingSanity, comparison: fakeComparison({ classification: 'NEW_RELEASE_AVAILABLE' }) });
    expect(result.classification).toBe('SAFE_TO_APPLY_LATER');
  });

  it('classifies BLOCKED_RISK when the title/year sanity check fails, regardless of the comparison result', () => {
    const result = classifyProviderConfirmationDryRun({
      titleYearSanity: { passed: false, reason: 'candidate title does not resemble local title' },
      comparison: fakeComparison({ classification: 'NO_CHANGE' }),
    });
    expect(result.classification).toBe('BLOCKED_RISK');
    expect(result.reason).toMatch(/sanity check failed/);
  });

  it('classifies BLOCKED_RISK when the comparison finds a risky season-shape mismatch', () => {
    const result = classifyProviderConfirmationDryRun({
      titleYearSanity: passingSanity,
      comparison: fakeComparison({ classification: 'RISKY_DO_NOT_APPLY', warnings: ['season 2 is missing entirely from the provider response'] }),
    });
    expect(result.classification).toBe('BLOCKED_RISK');
    expect(result.reason).toMatch(/risky/);
  });

  it('classifies BLOCKED_RISK (stricter than episode-release-refresh) when a watched episode would be orphaned', () => {
    const result = classifyProviderConfirmationDryRun({
      titleYearSanity: passingSanity,
      comparison: fakeComparison({ classification: 'NEEDS_MANUAL_REVIEW', warnings: ['watched episode S1E1 has no matching slot in the provider catalog'] }),
    });
    expect(result.classification).toBe('BLOCKED_RISK');
    expect(result.reason).toMatch(/orphaned/);
  });

  it('classifies SAFE_TO_APPLY_LATER for an exact match with no orphans (unaffected by the season-zero-orphan carve-out)', () => {
    const seasonZeroOrphanCheck = checkBenignSeasonZeroOrphan({ localTitle: 'Friends', orphanedWatchedEpisodes: [], realSeasonShrinkDetected: false });
    const result = classifyProviderConfirmationDryRun({
      titleYearSanity: passingSanity,
      comparison: fakeComparison({ classification: 'NO_CHANGE' }),
      seasonZeroOrphanCheck,
    });
    expect(result.classification).toBe('SAFE_TO_APPLY_LATER');
    expect(result.recommendation).toBeNull();
  });

  it('classifies SAFE_WITH_LOCAL_SPECIAL_ORPHAN when the only blocker is a benign single season-0 orphan (BBT/Modern Family/HIMYM/Flash pattern)', () => {
    const seasonZeroOrphanCheck: SeasonZeroOrphanCheckResult = checkBenignSeasonZeroOrphan({
      localTitle: 'The Big Bang Theory',
      orphanedWatchedEpisodes: [{ id: 'x', seasonNumber: 0, episodeNumber: 6 }],
      realSeasonShrinkDetected: false,
    });
    const result = classifyProviderConfirmationDryRun({
      titleYearSanity: passingSanity,
      comparison: fakeComparison({ classification: 'NEEDS_MANUAL_REVIEW', warnings: ["watched episode S0E6 has no matching slot in the provider's current catalog"] }),
      seasonZeroOrphanCheck,
    });
    expect(result.classification).toBe('SAFE_WITH_LOCAL_SPECIAL_ORPHAN');
    expect(result.recommendation).toBe('Can be applied later if apply mode preserves local season-0 orphan episodes.');
  });

  it('classifies SAFE_WITH_LOCAL_SPECIAL_ORPHAN even when the comparison classification is RISKY_DO_NOT_APPLY, as long as the orphan check says benign (Modern Family/HIMYM pattern — season 0 entirely missing trips the season-shift guard)', () => {
    const seasonZeroOrphanCheck: SeasonZeroOrphanCheckResult = checkBenignSeasonZeroOrphan({
      localTitle: 'Modern Family',
      orphanedWatchedEpisodes: [{ id: 'x', seasonNumber: 0, episodeNumber: 5 }],
      realSeasonShrinkDetected: false,
    });
    const result = classifyProviderConfirmationDryRun({
      titleYearSanity: passingSanity,
      comparison: fakeComparison({
        classification: 'RISKY_DO_NOT_APPLY',
        warnings: ['season 0 (1 local episode(s)) is missing entirely from the provider response', "watched episode S0E5 has no matching slot in the provider's current catalog"],
      }),
      seasonZeroOrphanCheck,
    });
    expect(result.classification).toBe('SAFE_WITH_LOCAL_SPECIAL_ORPHAN');
  });

  it('remains BLOCKED_RISK for multiple real-season orphaned watches, not just season-0 ones', () => {
    const seasonZeroOrphanCheck: SeasonZeroOrphanCheckResult = checkBenignSeasonZeroOrphan({
      localTitle: 'The Office (US)',
      orphanedWatchedEpisodes: [
        { id: 'a', seasonNumber: 4, episodeNumber: 16 },
        { id: 'b', seasonNumber: 6, episodeNumber: 25 },
      ],
      realSeasonShrinkDetected: true,
    });
    const result = classifyProviderConfirmationDryRun({
      titleYearSanity: passingSanity,
      comparison: fakeComparison({ classification: 'RISKY_DO_NOT_APPLY', warnings: ['season 4 shrank: 19 local episode(s) vs. 14 from the provider'] }),
      seasonZeroOrphanCheck,
    });
    expect(result.classification).toBe('BLOCKED_RISK');
  });

  it('remains BLOCKED_RISK for The Office-style real season shrink even with zero season-0 orphans', () => {
    const seasonZeroOrphanCheck: SeasonZeroOrphanCheckResult = checkBenignSeasonZeroOrphan({
      localTitle: 'The Office (US)',
      orphanedWatchedEpisodes: [],
      realSeasonShrinkDetected: true,
    });
    const result = classifyProviderConfirmationDryRun({
      titleYearSanity: passingSanity,
      comparison: fakeComparison({ classification: 'RISKY_DO_NOT_APPLY', warnings: ['season 7 shrank: 26 local episode(s) vs. 24 from the provider'] }),
      seasonZeroOrphanCheck,
    });
    expect(result.classification).toBe('BLOCKED_RISK');
    expect(result.recommendation).toBeNull();
  });

  it('remains BLOCKED_RISK for a known risk-listed title even with an otherwise-benign single season-0 orphan', () => {
    const seasonZeroOrphanCheck: SeasonZeroOrphanCheckResult = checkBenignSeasonZeroOrphan({
      localTitle: 'Jujutsu Kaisen',
      orphanedWatchedEpisodes: [{ id: 'x', seasonNumber: 0, episodeNumber: 1 }],
      realSeasonShrinkDetected: false,
    });
    const result = classifyProviderConfirmationDryRun({
      titleYearSanity: passingSanity,
      comparison: fakeComparison({ classification: 'NEEDS_MANUAL_REVIEW', warnings: ["watched episode S0E1 has no matching slot in the provider's current catalog"] }),
      seasonZeroOrphanCheck,
    });
    expect(result.classification).toBe('BLOCKED_RISK');
  });

  it('omitting seasonZeroOrphanCheck entirely behaves as "definitely not benign" (backward compatible)', () => {
    const result = classifyProviderConfirmationDryRun({
      titleYearSanity: passingSanity,
      comparison: fakeComparison({ classification: 'NEEDS_MANUAL_REVIEW', warnings: ['watched episode S1E1 has no matching slot'] }),
    });
    expect(result.classification).toBe('BLOCKED_RISK');
  });

  describe('SAFE_WITH_SPLIT_EPISODE_TAIL', () => {
    function officeLocal(): EpisodeSeasonPosition[] {
      return Array.from({ length: 19 }, (_, i) => ({ seasonNumber: 4, episodeNumber: i + 1 }));
    }
    function officeProvider(): EpisodeSeasonPosition[] {
      return Array.from({ length: 14 }, (_, i) => ({ seasonNumber: 4, episodeNumber: i + 1 }));
    }
    const officeTailOrphans = [15, 16, 17, 18, 19].map((n) => ({ id: `s4e${n}`, seasonNumber: 4, episodeNumber: n }));

    it('classifies SAFE_WITH_SPLIT_EPISODE_TAIL for the confirmed The Office (US) tail-only pattern', () => {
      const splitEpisodeTailCheck = checkSplitEpisodeTailOnly({
        localTitle: 'The Office (US)',
        localEpisodes: officeLocal(),
        providerEpisodes: officeProvider(),
        orphanedWatchedEpisodes: officeTailOrphans,
      });
      const result = classifyProviderConfirmationDryRun({
        titleYearSanity: passingSanity,
        comparison: fakeComparison({
          classification: 'RISKY_DO_NOT_APPLY',
          warnings: ['season 4 shrank: 19 local episode(s) vs. 14 from the provider'],
        }),
        splitEpisodeTailCheck,
      });

      expect(result.classification).toBe('SAFE_WITH_SPLIT_EPISODE_TAIL');
      expect(result.recommendation).toBe(
        'Can be applied later if apply mode preserves unmatched local tail episodes as local-only watched episodes (no delete, no renumber, no overwrite).',
      );
      expect(result.tailOrphanedEpisodes).toEqual(officeTailOrphans);
    });

    it('is distinct from SAFE_TO_APPLY_LATER — the clean-catalog case never sets tailOrphanedEpisodes', () => {
      const cleanResult = classifyProviderConfirmationDryRun({ titleYearSanity: passingSanity, comparison: fakeComparison({ classification: 'NO_CHANGE' }) });
      expect(cleanResult.classification).toBe('SAFE_TO_APPLY_LATER');
      expect(cleanResult.classification).not.toBe('SAFE_WITH_SPLIT_EPISODE_TAIL');
      expect(cleanResult.tailOrphanedEpisodes).toBeNull();
    });

    it('is distinct from SAFE_WITH_LOCAL_SPECIAL_ORPHAN — a benign season-0 orphan takes priority and never sets tailOrphanedEpisodes', () => {
      const seasonZeroOrphanCheck: SeasonZeroOrphanCheckResult = checkBenignSeasonZeroOrphan({
        localTitle: 'The Big Bang Theory',
        orphanedWatchedEpisodes: [{ id: 'x', seasonNumber: 0, episodeNumber: 6 }],
        realSeasonShrinkDetected: false,
      });
      const splitEpisodeTailCheck = checkSplitEpisodeTailOnly({
        localTitle: 'The Big Bang Theory',
        localEpisodes: [],
        providerEpisodes: [],
        orphanedWatchedEpisodes: [],
      });
      const result = classifyProviderConfirmationDryRun({
        titleYearSanity: passingSanity,
        comparison: fakeComparison({ classification: 'NEEDS_MANUAL_REVIEW', warnings: ["watched episode S0E6 has no matching slot in the provider's current catalog"] }),
        seasonZeroOrphanCheck,
        splitEpisodeTailCheck,
      });

      expect(result.classification).toBe('SAFE_WITH_LOCAL_SPECIAL_ORPHAN');
      expect(result.classification).not.toBe('SAFE_WITH_SPLIT_EPISODE_TAIL');
      expect(result.tailOrphanedEpisodes).toBeNull();
    });

    it('remains BLOCKED_RISK when the split-episode-tail check itself says the pattern is not tail-only (mid-season gap)', () => {
      const splitEpisodeTailCheck = checkSplitEpisodeTailOnly({
        localTitle: 'Some Show',
        localEpisodes: Array.from({ length: 10 }, (_, i) => ({ seasonNumber: 1, episodeNumber: i + 1 })),
        providerEpisodes: Array.from({ length: 10 }, (_, i) => ({ seasonNumber: 1, episodeNumber: i + 1 })).filter((e) => e.episodeNumber !== 5),
        orphanedWatchedEpisodes: [{ id: 'x', seasonNumber: 1, episodeNumber: 5 }],
      });
      const result = classifyProviderConfirmationDryRun({
        titleYearSanity: passingSanity,
        comparison: fakeComparison({ classification: 'NEEDS_MANUAL_REVIEW', warnings: ["watched episode S1E5 has no matching slot in the provider's current catalog"] }),
        splitEpisodeTailCheck,
      });

      expect(result.classification).toBe('BLOCKED_RISK');
      expect(result.tailOrphanedEpisodes).toBeNull();
    });

    it('omitting splitEpisodeTailCheck entirely behaves as "definitely not a tail" (backward compatible)', () => {
      const result = classifyProviderConfirmationDryRun({
        titleYearSanity: passingSanity,
        comparison: fakeComparison({ classification: 'RISKY_DO_NOT_APPLY', warnings: ['season 4 shrank: 19 local episode(s) vs. 14 from the provider'] }),
      });
      expect(result.classification).toBe('BLOCKED_RISK');
    });
  });
});
