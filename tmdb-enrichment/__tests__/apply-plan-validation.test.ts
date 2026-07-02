import { ApplyPlanCandidate, TmdbApplyPlan } from '../apply-plan-types';
import { collectDataQualityFlaggedIds, resolveAndValidateCandidates, selectCandidatesToApply, validateCandidateSafety } from '../apply-plan-validation';

function candidate(overrides: Partial<ApplyPlanCandidate> = {}): ApplyPlanCandidate {
  return {
    mytvSeriesId: 'series-1',
    mytvSeriesTitle: '07-Ghost',
    realTier: 'NEEDS_REVIEW',
    proposedTierAfterStructuralRule: 'AUTO_MATCH',
    tmdbId: '21855',
    tmdbTitle: '07-Ghost',
    tmdbYear: 2009,
    watchedEpisodeCount: 25,
    tmdbTotalEpisodeCount: 25,
    animeNumberingRiskDetected: false,
    closeCompetitorDetected: false,
    closeCompetitorReason: null,
    currentUserStatus: 'WATCHING',
    proposedUserStatusAfterEnrichment: 'COMPLETED',
    proposedReleaseStatus: 'ENDED',
    ...overrides,
  };
}

function plan(overrides: Partial<TmdbApplyPlan> = {}): TmdbApplyPlan {
  return {
    sourceBatchId: 'batch-1',
    writesToAppTables: false,
    appliedAnything: false,
    summary: {
      seriesConsidered: 1,
      realAutoMatchCount: 0,
      structuralAutoMatchProposedCount: 1,
      candidateUnionCount: 1,
      safeApplyCandidateCount: 1,
      excludedFromCandidateUnionCount: 0,
      manualReviewCounts: {},
      dataQualityIssueCount: 0,
    },
    safeApplyCandidates: [candidate()],
    excludedFromCandidateUnion: [],
    manualReview: {
      duplicate_title_year_suffix_collision: [],
      remake_reboot_collision: [],
      placeholder_title: [],
      anime_numbering_risk: [],
      watched_gt_total: [],
      close_competitor: [],
      no_match: [],
    },
    dangerousExamples: [],
    ...overrides,
  };
}

describe('validateCandidateSafety', () => {
  const noFlags = new Set<string>();

  it('is safe when every flag is clean and watched === total', () => {
    expect(validateCandidateSafety(candidate(), noFlags)).toEqual({ safe: true, violations: [] });
  });

  it('rejects a candidate flagged by a data-quality issue', () => {
    const result = validateCandidateSafety(candidate(), new Set(['series-1']));
    expect(result.safe).toBe(false);
    expect(result.violations[0]).toContain('data-quality issue');
  });

  it('rejects closeCompetitorDetected', () => {
    const result = validateCandidateSafety(candidate({ closeCompetitorDetected: true }), noFlags);
    expect(result.safe).toBe(false);
    expect(result.violations.join(' ')).toContain('closeCompetitorDetected');
  });

  it('rejects animeNumberingRiskDetected', () => {
    const result = validateCandidateSafety(candidate({ animeNumberingRiskDetected: true }), noFlags);
    expect(result.safe).toBe(false);
    expect(result.violations.join(' ')).toContain('animeNumberingRiskDetected');
  });

  it('rejects watched > total', () => {
    const result = validateCandidateSafety(candidate({ watchedEpisodeCount: 30, tmdbTotalEpisodeCount: 25 }), noFlags);
    expect(result.safe).toBe(false);
    expect(result.violations.join(' ')).toContain('watched (30) > total (25)');
  });

  it('rejects watched < total', () => {
    const result = validateCandidateSafety(candidate({ watchedEpisodeCount: 10, tmdbTotalEpisodeCount: 25 }), noFlags);
    expect(result.safe).toBe(false);
    expect(result.violations.join(' ')).toContain('watched (10) < total (25)');
  });

  it('rejects tier NO_MATCH', () => {
    const result = validateCandidateSafety(candidate({ realTier: 'NO_MATCH' }), noFlags);
    expect(result.safe).toBe(false);
    expect(result.violations.join(' ')).toContain('NO_MATCH');
  });

  it('accumulates multiple violations rather than stopping at the first', () => {
    const result = validateCandidateSafety(
      candidate({ closeCompetitorDetected: true, animeNumberingRiskDetected: true, watchedEpisodeCount: 30, tmdbTotalEpisodeCount: 25 }),
      noFlags,
    );
    expect(result.violations).toHaveLength(3);
  });
});

describe('collectDataQualityFlaggedIds', () => {
  it('unions ids across the three data-quality manual-review buckets', () => {
    const p = plan({
      manualReview: {
        duplicate_title_year_suffix_collision: [{ mytvSeriesId: 'a', mytvSeriesTitle: 'A' }],
        remake_reboot_collision: [{ mytvSeriesId: 'b', mytvSeriesTitle: 'B' }],
        placeholder_title: [{ mytvSeriesId: 'c', mytvSeriesTitle: 'C' }],
        anime_numbering_risk: [{ mytvSeriesId: 'd', mytvSeriesTitle: 'D' }],
        watched_gt_total: [],
        close_competitor: [],
        no_match: [],
      },
    });

    const ids = collectDataQualityFlaggedIds(p);
    expect(ids).toEqual(new Set(['a', 'b', 'c']));
    expect(ids.has('d')).toBe(false); // anime risk isn't a data-quality issue type
  });
});

describe('selectCandidatesToApply', () => {
  it('returns the full safeApplyCandidates list when no filter is given', () => {
    const p = plan();
    const result = selectCandidatesToApply(p);
    expect(result.candidates).toEqual(p.safeApplyCandidates);
    expect(result.errors).toEqual([]);
  });

  it('refuses a requested series id that is not in the plan', () => {
    const p = plan();
    const result = selectCandidatesToApply(p, ['not-in-plan']);
    expect(result.candidates).toEqual([]);
    expect(result.errors[0]).toContain('not-in-plan');
    expect(result.errors[0]).toContain('not in tmdb-apply-plan.json');
  });

  it('accepts a mix of valid and invalid ids, reporting the invalid ones as errors without dropping valid ones', () => {
    const p = plan({ safeApplyCandidates: [candidate({ mytvSeriesId: 'series-1' }), candidate({ mytvSeriesId: 'series-2', mytvSeriesTitle: '11eyes' })] });
    const result = selectCandidatesToApply(p, ['series-1', 'bogus-id']);
    expect(result.candidates.map((c) => c.mytvSeriesId)).toEqual(['series-1']);
    expect(result.errors).toHaveLength(1);
  });
});

describe('resolveAndValidateCandidates', () => {
  it('fails the whole run when a requested id is not in the plan (refuses candidates not in the plan)', () => {
    const p = plan();
    const result = resolveAndValidateCandidates(p, ['not-in-plan']);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('not-in-plan'))).toBe(true);
  });

  it('fails the whole run when any selected candidate is unsafe, even if others are safe', () => {
    const safe = candidate({ mytvSeriesId: 'series-1' });
    const unsafe = candidate({ mytvSeriesId: 'series-2', mytvSeriesTitle: 'Avatar: The Last Airbender', watchedEpisodeCount: 61, tmdbTotalEpisodeCount: 15, closeCompetitorDetected: true });
    const p = plan({ safeApplyCandidates: [safe, unsafe] });

    const result = resolveAndValidateCandidates(p);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('Avatar'))).toBe(true);
  });

  it('succeeds when every selected candidate is safe and every requested id is in the plan', () => {
    const p = plan();
    const result = resolveAndValidateCandidates(p, ['series-1']);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.candidates).toHaveLength(1);
  });
});
