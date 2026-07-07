// Pure classification logic for the image-coverage report. No I/O —
// testable without a database, same pattern as every other audit module in
// this repo (watch-next-audit/audit-logic.ts, secondary-provider-audit/
// tvmaze-compare.ts). Only ever categorizes; nothing here writes anything.

export type ImageCoverageIssueCategory =
  | 'NOT_ENRICHED_YET'
  | 'ENRICHED_BUT_PROVIDER_HAS_NO_IMAGE'
  | 'MANUAL_REVIEW_NO_SAFE_MATCH'
  | 'POSSIBLE_PROVIDER_MISMATCH';

export interface ClassifyMissingImageInput {
  hasTmdbMatch: boolean;
  // Whether this series appeared anywhere in a prior TMDb dry run at all
  // (either the needs-review list or the auto-match candidate list) — false
  // means it has genuinely never been scanned, as opposed to having been
  // scanned and found wanting.
  hasPriorDryRunData: boolean;
  // A remake/reboot collision or a duplicate-title-different-year-suffix
  // flag from the dry run's data-quality pass, OR a duplicate-title-group
  // member in the CURRENT database, OR a close-competitor candidate — any
  // of these mean a match likely exists but picking the right one is risky,
  // which is a materially different problem from "no candidate was good
  // enough."
  isPossibleMismatch: boolean;
}

export interface ClassifyMissingImageResult {
  category: ImageCoverageIssueCategory;
  reason: string;
}

// Priority-ordered, mutually exclusive. Only called for a series that is
// actually missing at least one of posterUrl/backdropUrl — callers should
// not call this for a fully-covered series.
export function classifyMissingImage(input: ClassifyMissingImageInput): ClassifyMissingImageResult {
  if (input.hasTmdbMatch) {
    return {
      category: 'ENRICHED_BUT_PROVIDER_HAS_NO_IMAGE',
      reason: 'series has a confirmed TMDb match, but TMDb itself has no poster/backdrop for this title',
    };
  }

  if (input.isPossibleMismatch) {
    return {
      category: 'POSSIBLE_PROVIDER_MISMATCH',
      reason: 'a candidate exists but is flagged as a likely remake/reboot/duplicate-title collision — resolving the match itself comes before filling in images',
    };
  }

  if (!input.hasPriorDryRunData) {
    return {
      category: 'NOT_ENRICHED_YET',
      reason: 'no TMDb match attempt has been made for this series at all',
    };
  }

  return {
    category: 'MANUAL_REVIEW_NO_SAFE_MATCH',
    reason: 'a TMDb dry run was attempted but found no auto-apply-safe match (either no candidate cleared the confidence bar, or no candidate was found at all)',
  };
}
