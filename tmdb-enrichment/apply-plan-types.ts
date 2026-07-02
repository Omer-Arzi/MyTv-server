// Shape of tmdb-apply-plan.json (written by build-apply-plan / the plan
// documented in docs — see the tmdb-apply-plan.md this ships alongside).
// The apply step (apply-plan.ts) reads ONLY this file's safeApplyCandidates
// array as input — it never re-runs scoring/matching/tiering itself. See
// apply-plan.ts's file header for why.

export type ApplyPlanRealTier = 'AUTO_MATCH' | 'NEEDS_REVIEW' | 'NO_MATCH';
export type ApplyPlanStructuralTier = 'AUTO_MATCH' | 'NEEDS_REVIEW' | null;

export interface ApplyPlanCandidate {
  mytvSeriesId: string;
  mytvSeriesTitle: string;
  realTier: ApplyPlanRealTier;
  proposedTierAfterStructuralRule: ApplyPlanStructuralTier;
  tmdbId: string;
  tmdbTitle: string;
  tmdbYear: number | null;
  watchedEpisodeCount: number;
  tmdbTotalEpisodeCount: number;
  animeNumberingRiskDetected: boolean;
  closeCompetitorDetected: boolean;
  closeCompetitorReason: string | null;
  currentUserStatus: string;
  proposedUserStatusAfterEnrichment: string;
  proposedReleaseStatus: string;
}

export interface ApplyPlanManualReviewEntry {
  mytvSeriesId: string;
  mytvSeriesTitle: string;
  [key: string]: unknown;
}

export interface ApplyPlanManualReview {
  duplicate_title_year_suffix_collision: ApplyPlanManualReviewEntry[];
  remake_reboot_collision: ApplyPlanManualReviewEntry[];
  placeholder_title: ApplyPlanManualReviewEntry[];
  anime_numbering_risk: ApplyPlanManualReviewEntry[];
  watched_gt_total: ApplyPlanManualReviewEntry[];
  close_competitor: ApplyPlanManualReviewEntry[];
  no_match: ApplyPlanManualReviewEntry[];
}

export interface TmdbApplyPlan {
  sourceBatchId: string;
  writesToAppTables: boolean;
  appliedAnything: boolean;
  summary: {
    seriesConsidered: number;
    realAutoMatchCount: number;
    structuralAutoMatchProposedCount: number;
    candidateUnionCount: number;
    safeApplyCandidateCount: number;
    excludedFromCandidateUnionCount: number;
    manualReviewCounts: Record<string, number>;
    dataQualityIssueCount: number;
  };
  safeApplyCandidates: ApplyPlanCandidate[];
  excludedFromCandidateUnion: Array<{ entry: { mytvSeriesId: string; mytvSeriesTitle: string }; reasons: string[] }>;
  manualReview: ApplyPlanManualReview;
  dangerousExamples: Array<{ mytvSeriesId?: string; mytvSeriesTitle: string }>;
}
