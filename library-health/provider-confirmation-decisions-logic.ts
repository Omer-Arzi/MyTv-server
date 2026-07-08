// Pure decision logic for the provider-confirmation decisions dry-run. No
// I/O, no Prisma, no provider calls — this only ever reasons about data
// already handed to it (a decision file entry, plus an already-computed
// episode-release-refresh/refresh-logic.ts compareSeriesCatalog result for
// confirmed decisions). Same pattern as every other *-logic.ts file here.
//
// This is a REPORTING/CLASSIFICATION layer only. Its most confident outcome
// (SAFE_TO_APPLY_LATER) means exactly what it says — "later," via a
// separate, still-to-be-built apply step — never applied here. See
// run-provider-confirmation-dry-run.ts's header for why no apply mode
// exists yet.

import { extractTitleYearHint, normalizeTitle, titleSimilarity } from '../trakt-enrichment/scoring';
import { CompareSeriesCatalogResult } from '../episode-release-refresh/refresh-logic';
import { SeasonZeroOrphanCheckResult } from './season-zero-orphan-logic';

export type ProviderConfirmationDecisionType = 'confirm' | 'skip' | 'defer';
export type SupportedProvider = 'tmdb' | 'tvmaze';

// Mirrors the shape of one entry in provider-confirmation-decisions.example.json.
export interface ProviderConfirmationDecision {
  title: string;
  decision: ProviderConfirmationDecisionType;
  provider?: SupportedProvider;
  providerId?: string | number;
  notes?: string;
}

export type DryRunClassification =
  | 'SAFE_TO_APPLY_LATER'
  // Distinct from — and deliberately weaker than — SAFE_TO_APPLY_LATER:
  // the ONLY blocker found is a benign local season-0 orphan (see
  // season-zero-orphan-logic.ts). Not auto-promoted to full safety because
  // no apply step exists yet to confirm it would actually preserve that
  // orphaned episode rather than silently dropping/remapping it — see this
  // classification's `recommendation` report field.
  | 'SAFE_WITH_LOCAL_SPECIAL_ORPHAN'
  | 'NEEDS_MANUAL_REVIEW'
  | 'BLOCKED_RISK'
  | 'PROVIDER_NOT_FOUND'
  | 'LOCAL_SERIES_NOT_FOUND';

export interface TitleYearSanityCheckInput {
  localTitle: string;
  candidateTitle: string;
  candidateYear: number | null;
}

export interface TitleYearSanityCheckResult {
  passed: boolean;
  reason: string;
}

// Independent of whatever the human decided — verifies the FETCHED provider
// candidate still actually looks like the local series before trusting it
// any further. A human confirming "yes, apply this" doesn't get a free
// pass past this check; if the providerId in the decision file were ever
// wrong (typo, stale id, copy-paste error), this is what catches it.
const MIN_TITLE_SIMILARITY = 0.6;
const YEAR_MISMATCH_THRESHOLD = 1;

export function checkTitleYearSanity(input: TitleYearSanityCheckInput): TitleYearSanityCheckResult {
  const hint = extractTitleYearHint(input.localTitle);
  const localNorm = normalizeTitle(hint.bareTitle);
  const candidateNorm = normalizeTitle(input.candidateTitle);

  if (localNorm === candidateNorm) {
    if (hint.titleYear !== null && input.candidateYear !== null && Math.abs(hint.titleYear - input.candidateYear) > YEAR_MISMATCH_THRESHOLD) {
      return {
        passed: false,
        reason: `title matches exactly but year differs sharply (local hint ${hint.titleYear} vs candidate ${input.candidateYear}) — possible remake/reboot mismatch`,
      };
    }
    return { passed: true, reason: 'exact title match' };
  }

  const similarity = titleSimilarity(hint.bareTitle, input.candidateTitle);
  if (similarity < MIN_TITLE_SIMILARITY) {
    return {
      passed: false,
      reason: `candidate title "${input.candidateTitle}" does not resemble local title "${input.localTitle}" (similarity ${similarity.toFixed(2)}, below the ${MIN_TITLE_SIMILARITY} floor)`,
    };
  }
  return { passed: true, reason: `title similarity ${similarity.toFixed(2)} — close enough to trust alongside a confirmed human decision` };
}

export interface ClassifyDryRunInput {
  titleYearSanity: TitleYearSanityCheckResult;
  comparison: CompareSeriesCatalogResult;
  // Always computed by the caller (see run-provider-confirmation-dry-run.ts)
  // from the same local/provider episode data used to build `comparison` —
  // optional here only so existing callers/tests that don't care about the
  // season-0 case don't need to construct one; omitting it is equivalent to
  // "definitely not a benign orphan."
  seasonZeroOrphanCheck?: SeasonZeroOrphanCheckResult;
}

export interface ClassifyDryRunResult {
  classification: DryRunClassification;
  reason: string;
  // Only ever set alongside SAFE_WITH_LOCAL_SPECIAL_ORPHAN — the exact,
  // fixed recommendation text the task specifies, verbatim, so a report
  // consumer doesn't need to reconstruct it from the classification name.
  recommendation: string | null;
}

const SEASON_ZERO_ORPHAN_RECOMMENDATION = 'Can be applied later if apply mode preserves local season-0 orphan episodes.';

// Maps episode-release-refresh's general-sweep RefreshClassification onto
// this pipeline's stricter vocabulary. Deliberately stricter than
// episode-release-refresh's own posture in one place: RISKY_DO_NOT_APPLY
// AND NEEDS_MANUAL_REVIEW (which, from compareSeriesCatalog, specifically
// means "a watched episode has no matching provider slot" — see
// episode-release-refresh/refresh-logic.ts) both become BLOCKED_RISK here,
// per this task's explicit rule that an orphaned/ambiguously-remapped
// watched episode must block, not just get flagged for review — this dry
// run is one step closer to a real apply than a general sweep, so it earns
// the stricter gate. The ONE carve-out: if the sole reason either of those
// two would otherwise block is a benign local season-0 orphan (see
// season-zero-orphan-logic.ts), this downgrades to
// SAFE_WITH_LOCAL_SPECIAL_ORPHAN instead of BLOCKED_RISK — still not full
// SAFE_TO_APPLY_LATER, since no apply step exists yet to confirm it would
// actually preserve that orphaned episode.
export function classifyProviderConfirmationDryRun(input: ClassifyDryRunInput): ClassifyDryRunResult {
  if (!input.titleYearSanity.passed) {
    return { classification: 'BLOCKED_RISK', reason: `title/year sanity check failed: ${input.titleYearSanity.reason}`, recommendation: null };
  }

  const isBlockedByComparison = input.comparison.classification === 'RISKY_DO_NOT_APPLY' || input.comparison.classification === 'NEEDS_MANUAL_REVIEW';

  if (isBlockedByComparison) {
    if (input.seasonZeroOrphanCheck?.isBenignSeasonZeroOrphan) {
      return {
        classification: 'SAFE_WITH_LOCAL_SPECIAL_ORPHAN',
        reason: `the only blocker is ${input.seasonZeroOrphanCheck.orphanSeasonZeroEpisodeCount} benign local season-0 special episode(s) not present in the provider catalog — ${input.seasonZeroOrphanCheck.reason}`,
        recommendation: SEASON_ZERO_ORPHAN_RECOMMENDATION,
      };
    }

    if (input.comparison.classification === 'RISKY_DO_NOT_APPLY') {
      return {
        classification: 'BLOCKED_RISK',
        reason: `provider catalog shape is risky relative to local — ${input.comparison.warnings.join('; ') || 'season/episode structure mismatch'}`,
        recommendation: null,
      };
    }
    return {
      classification: 'BLOCKED_RISK',
      reason: `at least one watched episode would be orphaned or ambiguously remapped — ${input.comparison.warnings.join('; ') || 'watched-episode alignment mismatch'}`,
      recommendation: null,
    };
  }

  return {
    classification: 'SAFE_TO_APPLY_LATER',
    reason: `title/year sanity check passed and the provider catalog comparison (${input.comparison.classification}) found no structural risk or orphaned watch history.`,
    recommendation: null,
  };
}
