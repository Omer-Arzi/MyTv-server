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

import { UserSeriesStatus } from '@prisma/client';
import { extractTitleYearHint, normalizeTitle, titleSimilarity } from '../trakt-enrichment/scoring';
import { CompareSeriesCatalogResult } from '../episode-release-refresh/refresh-logic';
import { OrphanedWatchedEpisode, SeasonZeroOrphanCheckResult } from './season-zero-orphan-logic';
import { SplitEpisodeTailCheckResult } from './split-episode-tail-logic';

export type ProviderConfirmationDecisionType = 'confirm' | 'skip' | 'defer';
export type SupportedProvider = 'tmdb' | 'tvmaze';

// Mirrors the shape of one entry in the human-maintained source-of-truth
// decisions file, provider-confirmation-decisions.json (see
// provider-confirmation-decisions.example.json for the schema/template
// only — that file holds placeholder data, not real decisions).
//
// migrationIntent/statusOverride are purely additive and OPTIONAL — an
// entry that omits them behaves exactly as it always has (this interface
// change alone doesn't touch classifyProviderConfirmationDryRun's
// behavior at all). They only ever mean anything when read by
// migration-confirmation-logic.ts's classifyMigrationConfirmation, which
// is itself only reachable when migrationIntent === true (see that
// module's header for why this must be an explicit, human-set signal
// rather than inferred from data).
export interface ProviderConfirmationDecision {
  title: string;
  decision: ProviderConfirmationDecisionType;
  provider?: SupportedProvider;
  providerId?: string | number;
  notes?: string;
  // Explicit human approval that this title is being migrated from one
  // provider/episode-database to another, and that structural mismatch
  // (orphaned watched episodes, even in large numbers) should not block
  // confirmation the way it would for a non-migration match. Never
  // inferred automatically — must be set by a human per title.
  migrationIntent?: boolean;
  // When set (and migrationIntent is true), the human's explicit statement
  // of what userStatus should become after migration — used INSTEAD OF
  // recomputing status from the new provider's episode counts. Still
  // subject to the DROPPED/PAUSED protection (see migration-confirmation-logic.ts).
  statusOverride?: UserSeriesStatus;
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
  // Distinct from — and deliberately weaker than — SAFE_TO_APPLY_LATER,
  // same posture as SAFE_WITH_LOCAL_SPECIAL_ORPHAN but for a different
  // benign pattern: the ONLY blocker found is a confirmed tail-only
  // split/merged-episode numbering difference (see
  // split-episode-tail-logic.ts — first confirmed real case: The Office
  // (US) seasons 4/6/7). Not auto-promoted to full safety because no apply
  // step exists yet to confirm it would actually preserve those tail
  // orphan rows as local-only watched episodes rather than deleting,
  // renumbering, or overwriting them.
  | 'SAFE_WITH_SPLIT_EPISODE_TAIL'
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
  // Same optionality contract as seasonZeroOrphanCheck — omitting it is
  // equivalent to "definitely not a split-episode tail."
  splitEpisodeTailCheck?: SplitEpisodeTailCheckResult;
}

export interface ClassifyDryRunResult {
  classification: DryRunClassification;
  reason: string;
  // Only ever set alongside SAFE_WITH_LOCAL_SPECIAL_ORPHAN or
  // SAFE_WITH_SPLIT_EPISODE_TAIL — the exact, fixed recommendation text for
  // that classification, verbatim, so a report consumer doesn't need to
  // reconstruct it from the classification name.
  recommendation: string | null;
  // Only ever set alongside SAFE_WITH_SPLIT_EPISODE_TAIL — the exact
  // orphaned watched episodes a future apply step MUST preserve as
  // local-only watched episodes (no delete, no renumber, no overwrite).
  tailOrphanedEpisodes: OrphanedWatchedEpisode[] | null;
}

const SEASON_ZERO_ORPHAN_RECOMMENDATION = 'Can be applied later if apply mode preserves local season-0 orphan episodes.';
const SPLIT_EPISODE_TAIL_RECOMMENDATION =
  'Can be applied later if apply mode preserves unmatched local tail episodes as local-only watched episodes (no delete, no renumber, no overwrite).';

// Maps episode-release-refresh's general-sweep RefreshClassification onto
// this pipeline's stricter vocabulary. Deliberately stricter than
// episode-release-refresh's own posture in one place: RISKY_DO_NOT_APPLY
// AND NEEDS_MANUAL_REVIEW (which, from compareSeriesCatalog, specifically
// means "a watched episode has no matching provider slot" — see
// episode-release-refresh/refresh-logic.ts) both become BLOCKED_RISK here,
// per this task's explicit rule that an orphaned/ambiguously-remapped
// watched episode must block, not just get flagged for review — this dry
// run is one step closer to a real apply than a general sweep, so it earns
// the stricter gate. TWO carve-outs, checked in order: if the sole reason
// either of those two would otherwise block is (1) a benign local season-0
// orphan (see season-zero-orphan-logic.ts), this downgrades to
// SAFE_WITH_LOCAL_SPECIAL_ORPHAN; else if (2) a confirmed tail-only
// split/merged-episode numbering difference (see
// split-episode-tail-logic.ts), this downgrades to
// SAFE_WITH_SPLIT_EPISODE_TAIL. Neither is promoted to full
// SAFE_TO_APPLY_LATER, since no apply step exists yet to confirm it would
// actually preserve those orphaned/tail episodes rather than
// dropping/remapping/overwriting them.
export function classifyProviderConfirmationDryRun(input: ClassifyDryRunInput): ClassifyDryRunResult {
  if (!input.titleYearSanity.passed) {
    return { classification: 'BLOCKED_RISK', reason: `title/year sanity check failed: ${input.titleYearSanity.reason}`, recommendation: null, tailOrphanedEpisodes: null };
  }

  const isBlockedByComparison = input.comparison.classification === 'RISKY_DO_NOT_APPLY' || input.comparison.classification === 'NEEDS_MANUAL_REVIEW';

  if (isBlockedByComparison) {
    if (input.seasonZeroOrphanCheck?.isBenignSeasonZeroOrphan) {
      return {
        classification: 'SAFE_WITH_LOCAL_SPECIAL_ORPHAN',
        reason: `the only blocker is ${input.seasonZeroOrphanCheck.orphanSeasonZeroEpisodeCount} benign local season-0 special episode(s) not present in the provider catalog — ${input.seasonZeroOrphanCheck.reason}`,
        recommendation: SEASON_ZERO_ORPHAN_RECOMMENDATION,
        tailOrphanedEpisodes: null,
      };
    }

    if (input.splitEpisodeTailCheck?.isSplitEpisodeTailOnly) {
      return {
        classification: 'SAFE_WITH_SPLIT_EPISODE_TAIL',
        reason: `the only blocker is a confirmed tail-only split/merged-episode numbering difference — ${input.splitEpisodeTailCheck.reason}`,
        recommendation: SPLIT_EPISODE_TAIL_RECOMMENDATION,
        tailOrphanedEpisodes: input.splitEpisodeTailCheck.tailOrphanedEpisodes,
      };
    }

    if (input.comparison.classification === 'RISKY_DO_NOT_APPLY') {
      return {
        classification: 'BLOCKED_RISK',
        reason: `provider catalog shape is risky relative to local — ${input.comparison.warnings.join('; ') || 'season/episode structure mismatch'}`,
        recommendation: null,
        tailOrphanedEpisodes: null,
      };
    }
    return {
      classification: 'BLOCKED_RISK',
      reason: `at least one watched episode would be orphaned or ambiguously remapped — ${input.comparison.warnings.join('; ') || 'watched-episode alignment mismatch'}`,
      recommendation: null,
      tailOrphanedEpisodes: null,
    };
  }

  return {
    classification: 'SAFE_TO_APPLY_LATER',
    reason: `title/year sanity check passed and the provider catalog comparison (${input.comparison.classification}) found no structural risk or orphaned watch history.`,
    recommendation: null,
    tailOrphanedEpisodes: null,
  };
}
