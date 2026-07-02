import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { buildEnrichmentReport, buildNeedsReview } from '../reports';
import { AutoMatchCandidateReport, EnrichmentDryRunResult, NeedsReviewEntry } from '../enrichment-dry-run';
import { ScoreBreakdown } from '../scoring';

const breakdown: ScoreBreakdown = {
  titleScore: 50,
  titleMatchType: 'exact',
  yearScore: 10,
  yearMatchType: 'unknown',
  rankRelevanceScore: 20,
  resultPosition: 0,
  totalScore: 80,
};

function autoMatchCandidate(overrides: Partial<AutoMatchCandidateReport> = {}): AutoMatchCandidateReport {
  return {
    mytvSeriesId: 'series-1',
    mytvSeriesTitle: '07-Ghost',
    chosen: { tmdbId: '21855', tmdbTitle: '07-Ghost', tmdbYear: 2009, confidenceScore: 80, reasonBreakdown: breakdown },
    watchedEpisodeCount: 25,
    tmdbTotalEpisodeCount: 25,
    animeNumberingRiskDetected: false,
    currentUserStatus: UserSeriesStatus.WATCHING,
    proposedUserStatusAfterEnrichment: UserSeriesStatus.COMPLETED,
    userStatusChangeReason: 'full episode catalog now known (25 episodes); watched 25/25 and release status would be ENDED — would move to COMPLETED',
    currentReleaseStatus: ReleaseStatus.UNKNOWN,
    tmdbRawStatus: 'Ended',
    proposedReleaseStatus: ReleaseStatus.ENDED,
    ...overrides,
  };
}

function needsReviewEntry(overrides: Partial<NeedsReviewEntry> = {}): NeedsReviewEntry {
  return {
    mytvSeriesId: 'series-2',
    mytvSeriesTitle: 'A Certain Scientific Accelerator',
    tier: 'NEEDS_REVIEW',
    reason: 'top score 80 is below the auto-apply threshold (85)',
    topCandidate: { tmdbId: '90546', tmdbTitle: 'A Certain Scientific Accelerator', tmdbYear: 2019, confidenceScore: 80, reasonBreakdown: breakdown },
    watchedEpisodeCount: 5,
    tmdbTotalEpisodeCount: 12,
    animeNumberingRiskDetected: false,
    currentUserStatus: UserSeriesStatus.WATCHING,
    proposedUserStatusAfterEnrichment: UserSeriesStatus.WATCHING,
    userStatusChangeReason: 'full episode catalog now known (12 episodes); 7 unwatched episode(s) remain — would move to WATCHING',
    currentReleaseStatus: ReleaseStatus.UNKNOWN,
    tmdbRawStatus: 'Returning Series',
    proposedReleaseStatus: ReleaseStatus.RETURNING,
    ...overrides,
  };
}

function result(overrides: Partial<EnrichmentDryRunResult> = {}): EnrichmentDryRunResult {
  return {
    importBatchId: 'batch-1',
    seriesConsidered: 2,
    autoMatchCandidates: [],
    needsReview: [],
    apiCallCount: 0,
    cacheHitCount: 0,
    ...overrides,
  };
}

const meta = { importBatchId: 'batch-1', startedAt: new Date('2026-07-02T00:00:00.000Z'), finishedAt: new Date('2026-07-02T00:00:01.000Z'), userId: 'user-1' };

describe('buildEnrichmentReport — release status fields', () => {
  it('includes currentReleaseStatus/tmdbRawStatus/proposedReleaseStatus as real fields on auto-match candidates', () => {
    const report = buildEnrichmentReport(meta, result({ autoMatchCandidates: [autoMatchCandidate()] }));
    const [candidate] = report.autoMatchCandidates as Array<Record<string, unknown>>;

    expect(candidate.currentReleaseStatus).toBe(ReleaseStatus.UNKNOWN);
    expect(candidate.tmdbRawStatus).toBe('Ended');
    expect(candidate.proposedReleaseStatus).toBe(ReleaseStatus.ENDED);
  });

  it('does not require parsing userStatusChangeReason prose to know the proposed release status', () => {
    const report = buildEnrichmentReport(meta, result({ autoMatchCandidates: [autoMatchCandidate()] }));
    const [candidate] = report.autoMatchCandidates as Array<Record<string, unknown>>;

    // The prose still mentions it (kept for readability), but the point of
    // this task is that a consumer no longer has to parse it out.
    expect(typeof candidate.proposedReleaseStatus).toBe('string');
    expect(candidate.proposedReleaseStatus).not.toContain(' '); // an enum value, not a sentence
  });
});

describe('buildNeedsReview — release status fields', () => {
  it('includes the three release-status fields on NEEDS_REVIEW entries', () => {
    const needsReview = buildNeedsReview(result({ needsReview: [needsReviewEntry()] })) as Array<Record<string, unknown>>;

    expect(needsReview[0].currentReleaseStatus).toBe(ReleaseStatus.UNKNOWN);
    expect(needsReview[0].tmdbRawStatus).toBe('Returning Series');
    expect(needsReview[0].proposedReleaseStatus).toBe(ReleaseStatus.RETURNING);
  });

  it('leaves all three release-status fields null for NO_MATCH entries, consistent with the userStatus preview fields', () => {
    const noMatch = needsReviewEntry({
      tier: 'NO_MATCH',
      reason: 'search returned zero results',
      topCandidate: null,
      tmdbTotalEpisodeCount: null,
      animeNumberingRiskDetected: null,
      currentUserStatus: null,
      proposedUserStatusAfterEnrichment: null,
      userStatusChangeReason: null,
      currentReleaseStatus: null,
      tmdbRawStatus: null,
      proposedReleaseStatus: null,
    });

    const needsReview = buildNeedsReview(result({ needsReview: [noMatch] })) as Array<Record<string, unknown>>;

    expect(needsReview[0].currentReleaseStatus).toBeNull();
    expect(needsReview[0].tmdbRawStatus).toBeNull();
    expect(needsReview[0].proposedReleaseStatus).toBeNull();
  });
});
