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

export type DryRunClassification = 'SAFE_TO_APPLY_LATER' | 'NEEDS_MANUAL_REVIEW' | 'BLOCKED_RISK' | 'PROVIDER_NOT_FOUND' | 'LOCAL_SERIES_NOT_FOUND';

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
}

export interface ClassifyDryRunResult {
  classification: DryRunClassification;
  reason: string;
}

// Maps episode-release-refresh's general-sweep RefreshClassification onto
// this pipeline's stricter vocabulary. Deliberately stricter than
// episode-release-refresh's own posture in one place: RISKY_DO_NOT_APPLY
// AND NEEDS_MANUAL_REVIEW (which, from compareSeriesCatalog, specifically
// means "a watched episode has no matching provider slot" — see
// episode-release-refresh/refresh-logic.ts) both become BLOCKED_RISK here,
// per this task's explicit rule that an orphaned/ambiguously-remapped
// watched episode must block, not just get flagged for review — this dry
// run is one step closer to a real apply than a general sweep, so it earns
// the stricter gate.
export function classifyProviderConfirmationDryRun(input: ClassifyDryRunInput): ClassifyDryRunResult {
  if (!input.titleYearSanity.passed) {
    return { classification: 'BLOCKED_RISK', reason: `title/year sanity check failed: ${input.titleYearSanity.reason}` };
  }

  if (input.comparison.classification === 'RISKY_DO_NOT_APPLY') {
    return {
      classification: 'BLOCKED_RISK',
      reason: `provider catalog shape is risky relative to local — ${input.comparison.warnings.join('; ') || 'season/episode structure mismatch'}`,
    };
  }

  if (input.comparison.classification === 'NEEDS_MANUAL_REVIEW') {
    return {
      classification: 'BLOCKED_RISK',
      reason: `at least one watched episode would be orphaned or ambiguously remapped — ${input.comparison.warnings.join('; ') || 'watched-episode alignment mismatch'}`,
    };
  }

  return {
    classification: 'SAFE_TO_APPLY_LATER',
    reason: `title/year sanity check passed and the provider catalog comparison (${input.comparison.classification}) found no structural risk or orphaned watch history.`,
  };
}
