import { remapApplyPlanSeriesIds, SeriesIdByTitle } from '../remap-apply-plan';
import { TmdbApplyPlan, ApplyPlanCandidate } from '../apply-plan-types';

function candidate(overrides: Partial<ApplyPlanCandidate> = {}): ApplyPlanCandidate {
  return {
    mytvSeriesId: 'old-id-1',
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

function plan(candidates: ApplyPlanCandidate[]): TmdbApplyPlan {
  return {
    sourceBatchId: 'batch-1',
    writesToAppTables: false,
    appliedAnything: false,
    summary: {
      seriesConsidered: candidates.length,
      realAutoMatchCount: 0,
      structuralAutoMatchProposedCount: 0,
      candidateUnionCount: candidates.length,
      safeApplyCandidateCount: candidates.length,
      excludedFromCandidateUnionCount: 0,
      manualReviewCounts: {},
      dataQualityIssueCount: 0,
    },
    safeApplyCandidates: candidates,
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
  };
}

describe('remapApplyPlanSeriesIds', () => {
  it('remaps mytvSeriesId to the current database id when exactly one title match exists', () => {
    const result = remapApplyPlanSeriesIds(plan([candidate({ mytvSeriesId: 'old-id-1', mytvSeriesTitle: '07-Ghost' })]), [
      { title: '07-Ghost', id: 'new-id-1' },
    ]);
    expect(result.plan.safeApplyCandidates[0].mytvSeriesId).toBe('new-id-1');
    expect(result.remapped).toEqual([{ title: '07-Ghost', oldSeriesId: 'old-id-1', newSeriesId: 'new-id-1' }]);
    expect(result.unmatched).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it('never touches tmdbId, tier, or any other decision field', () => {
    const original = candidate({ mytvSeriesId: 'old-id-1', mytvSeriesTitle: '07-Ghost', tmdbId: '21855', realTier: 'NEEDS_REVIEW' });
    const result = remapApplyPlanSeriesIds(plan([original]), [{ title: '07-Ghost', id: 'new-id-1' }]);
    const remapped = result.plan.safeApplyCandidates[0];
    expect(remapped.tmdbId).toBe('21855');
    expect(remapped.realTier).toBe('NEEDS_REVIEW');
    expect(remapped.proposedUserStatusAfterEnrichment).toBe(original.proposedUserStatusAfterEnrichment);
  });

  it('reports a title with zero matches as unmatched and leaves it unchanged', () => {
    const result = remapApplyPlanSeriesIds(plan([candidate({ mytvSeriesTitle: 'Ghost Town' })]), []);
    expect(result.unmatched).toEqual(['Ghost Town']);
    expect(result.plan.safeApplyCandidates[0].mytvSeriesId).toBe('old-id-1');
  });

  it('reports a title with more than one match as ambiguous and never guesses', () => {
    const currentSeries: SeriesIdByTitle[] = [
      { title: 'Duplicate Show', id: 'id-a' },
      { title: 'Duplicate Show', id: 'id-b' },
    ];
    const result = remapApplyPlanSeriesIds(plan([candidate({ mytvSeriesTitle: 'Duplicate Show' })]), currentSeries);
    expect(result.ambiguous).toEqual(['Duplicate Show']);
    expect(result.remapped).toEqual([]);
    expect(result.plan.safeApplyCandidates[0].mytvSeriesId).toBe('old-id-1');
  });

  it('handles a mix of matched, unmatched, and ambiguous candidates independently', () => {
    const candidates = [
      candidate({ mytvSeriesId: 'old-1', mytvSeriesTitle: 'Show A' }),
      candidate({ mytvSeriesId: 'old-2', mytvSeriesTitle: 'Show B (missing)' }),
      candidate({ mytvSeriesId: 'old-3', mytvSeriesTitle: 'Show C (dup)' }),
    ];
    const currentSeries: SeriesIdByTitle[] = [
      { title: 'Show A', id: 'new-1' },
      { title: 'Show C (dup)', id: 'new-3a' },
      { title: 'Show C (dup)', id: 'new-3b' },
    ];
    const result = remapApplyPlanSeriesIds(plan(candidates), currentSeries);
    expect(result.remapped).toEqual([{ title: 'Show A', oldSeriesId: 'old-1', newSeriesId: 'new-1' }]);
    expect(result.unmatched).toEqual(['Show B (missing)']);
    expect(result.ambiguous).toEqual(['Show C (dup)']);
  });

  it('preserves every other plan field untouched (summary, manualReview, etc.)', () => {
    const original = plan([candidate()]);
    const result = remapApplyPlanSeriesIds(original, [{ title: '07-Ghost', id: 'new-id-1' }]);
    expect(result.plan.summary).toEqual(original.summary);
    expect(result.plan.manualReview).toEqual(original.manualReview);
    expect(result.plan.sourceBatchId).toBe(original.sourceBatchId);
  });
});
