import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { buildDataQualityIssues, buildEnrichmentReport, buildNeedsReview } from '../reports';
import { AutoMatchCandidateReport, DataQualityIssueReportEntry, EnrichmentDryRunResult, NeedsReviewEntry, TopCandidateSummary } from '../enrichment-dry-run';
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

const topCandidate1: TopCandidateSummary = {
  tmdbId: '21855',
  tmdbTitle: '07-Ghost',
  tmdbYear: 2009,
  confidenceScore: 80,
  reasonBreakdown: breakdown,
  resultPosition: 0,
};

function autoMatchCandidate(overrides: Partial<AutoMatchCandidateReport> = {}): AutoMatchCandidateReport {
  return {
    mytvSeriesId: 'series-1',
    mytvSeriesTitle: '07-Ghost',
    chosen: { tmdbId: '21855', tmdbTitle: '07-Ghost', tmdbYear: 2009, confidenceScore: 80, reasonBreakdown: breakdown },
    watchedEpisodeCount: 25,
    tmdbTotalEpisodeCount: 25,
    animeNumberingRiskDetected: false,
    topCandidates: [topCandidate1],
    candidateCount: 1,
    closeCompetitorDetected: false,
    closeCompetitorReason: null,
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
    topCandidates: [{ ...topCandidate1, tmdbId: '90546', tmdbTitle: 'A Certain Scientific Accelerator', tmdbYear: 2019 }],
    candidateCount: 1,
    closeCompetitorDetected: false,
    closeCompetitorReason: null,
    currentUserStatus: UserSeriesStatus.WATCHING,
    proposedUserStatusAfterEnrichment: UserSeriesStatus.WATCHING,
    userStatusChangeReason: 'full episode catalog now known (12 episodes); 7 unwatched episode(s) remain — would move to WATCHING',
    currentReleaseStatus: ReleaseStatus.UNKNOWN,
    tmdbRawStatus: 'Returning Series',
    proposedReleaseStatus: ReleaseStatus.RETURNING,
    proposedTierAfterStructuralRule: 'NEEDS_REVIEW',
    structuralRuleReason: 'watched episode count (5) is below TMDb\'s known total (12) — still in progress, kept conservative for this first structural-rule pass',
    ...overrides,
  };
}

function dataQualityIssue(overrides: Partial<DataQualityIssueReportEntry> = {}): DataQualityIssueReportEntry {
  return {
    mytvSeriesId: 'series-3',
    mytvSeriesTitle: '***Movies are not allowed***',
    issueType: 'PLACEHOLDER_TITLE',
    message: '"***Movies are not allowed***" looks like a placeholder/error string from the TV Time export, not a real series title — review before ever matching or importing it',
    ...overrides,
  };
}

function result(overrides: Partial<EnrichmentDryRunResult> = {}): EnrichmentDryRunResult {
  return {
    importBatchId: 'batch-1',
    seriesConsidered: 2,
    autoMatchCandidates: [],
    needsReview: [],
    dataQualityIssues: [],
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

describe('buildEnrichmentReport — candidate visibility fields', () => {
  it('includes topCandidates, candidateCount, and closeCompetitor fields on auto-match candidates', () => {
    const secondCandidate: TopCandidateSummary = { tmdbId: '999', tmdbTitle: 'Some Other Show', tmdbYear: 2015, confidenceScore: 50, reasonBreakdown: breakdown, resultPosition: 1 };
    const candidate = autoMatchCandidate({
      topCandidates: [topCandidate1, secondCandidate],
      candidateCount: 2,
      closeCompetitorDetected: false,
      closeCompetitorReason: null,
    });

    const report = buildEnrichmentReport(meta, result({ autoMatchCandidates: [candidate] }));
    const [reported] = report.autoMatchCandidates as Array<Record<string, unknown>>;

    expect(reported.topCandidates).toEqual([topCandidate1, secondCandidate]);
    expect(reported.candidateCount).toBe(2);
    expect(reported.closeCompetitorDetected).toBe(false);
    expect(reported.closeCompetitorReason).toBeNull();
  });

  it('surfaces structuralAutoMatchProposedCount in the summary without changing autoMatchCount', () => {
    const promoted = needsReviewEntry({ mytvSeriesId: 'series-4', proposedTierAfterStructuralRule: 'AUTO_MATCH', structuralRuleReason: 'qualifies' });
    const notPromoted = needsReviewEntry({ mytvSeriesId: 'series-5', proposedTierAfterStructuralRule: 'NEEDS_REVIEW', structuralRuleReason: 'still in progress' });

    const report = buildEnrichmentReport(meta, result({ autoMatchCandidates: [autoMatchCandidate()], needsReview: [promoted, notPromoted] }));

    expect(report.summary.autoMatchCount).toBe(1);
    expect(report.summary.structuralAutoMatchProposedCount).toBe(1);
  });
});

describe('buildNeedsReview — candidate visibility and structural-rule preview fields', () => {
  it('includes topCandidates/candidateCount/closeCompetitor fields', () => {
    const entry = needsReviewEntry({
      candidateCount: 3,
      closeCompetitorDetected: true,
      closeCompetitorReason: 'candidate "A Certain Scientific Accelerator" (2019, tmdbId 90546) has an identical normalized title to the top candidate',
    });

    const [reported] = buildNeedsReview(result({ needsReview: [entry] })) as Array<Record<string, unknown>>;

    expect(reported.candidateCount).toBe(3);
    expect(reported.closeCompetitorDetected).toBe(true);
    expect(reported.closeCompetitorReason).toContain('identical normalized title');
    expect(Array.isArray(reported.topCandidates)).toBe(true);
  });

  it('surfaces proposedTierAfterStructuralRule/structuralRuleReason as real fields, never applied to the real tier', () => {
    const entry = needsReviewEntry({
      tier: 'NEEDS_REVIEW',
      proposedTierAfterStructuralRule: 'AUTO_MATCH',
      structuralRuleReason: 'exact title, top search result, no close competitor, no anime-numbering risk, and watched episode count exactly matches TMDb\'s known total',
    });

    const [reported] = buildNeedsReview(result({ needsReview: [entry] })) as Array<Record<string, unknown>>;

    // The real tier is untouched — still NEEDS_REVIEW — even though the
    // structural-rule preview says it would qualify for AUTO_MATCH.
    expect(reported.tier).toBe('NEEDS_REVIEW');
    expect(reported.proposedTierAfterStructuralRule).toBe('AUTO_MATCH');
    expect(typeof reported.structuralRuleReason).toBe('string');
  });
});

describe('buildDataQualityIssues', () => {
  it('serializes placeholder-title, remake-collision, and duplicate-title issues', () => {
    const issues = buildDataQualityIssues(
      result({
        dataQualityIssues: [
          dataQualityIssue(),
          dataQualityIssue({ mytvSeriesId: 'series-6', mytvSeriesTitle: 'Avatar: The Last Airbender', issueType: 'REMAKE_COLLISION', message: 'likely a remake/reboot mismatch' }),
          dataQualityIssue({ mytvSeriesId: 'series-7', mytvSeriesTitle: 'Avatar: The Last Airbender (2021)', issueType: 'DUPLICATE_TITLE_DIFFERENT_YEAR_SUFFIX', message: 'shares a normalized title' }),
        ],
      }),
    );

    expect(issues).toHaveLength(3);
    expect(issues.map((i) => i.issueType)).toEqual(['PLACEHOLDER_TITLE', 'REMAKE_COLLISION', 'DUPLICATE_TITLE_DIFFERENT_YEAR_SUFFIX']);
  });

  it('is empty when no data-quality issues were detected', () => {
    expect(buildDataQualityIssues(result())).toEqual([]);
  });
});
