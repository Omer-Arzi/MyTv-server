// Pure classification/shaping logic for the Migration Workbench — no I/O,
// no Prisma, no live provider calls. Takes data the service layer already
// read from the library-health CLI pipeline's own persisted reports
// (library-health/output/latest-batch-manifest.json and
// latest-provider-confirmation-pipeline-report.json) and buckets it into
// the 4 user-facing categories. Deliberately reuses the CLI pipeline's own
// TypeScript types (BatchManifestEntry, PipelineSkippedSeriesEntry,
// PipelineManualReviewCandidate) rather than redefining a parallel shape —
// this is the first src/ file to import library-health/* types, which is
// exactly the point: the mobile app and the CLI must derive from the same
// canonical source, never a second algorithm.
//
// The 4 categories map onto library-health's existing
// MigrationOperatingClassification vocabulary (src/common/migration-operating-classification.ts):
//   - READY_AUTOMATIC / READY_FOR_CONFIRMATION: both drawn from AUTO_MIGRATE
//     batch-manifest entries — split by whether the identity match is
//     HIGH_CONFIDENCE with zero preserved orphans (fully deterministic, no
//     review needed) vs. BORDERLINE confidence or non-zero preserved
//     orphans (still safe to write, but worth a human's quick approval).
//   - NEEDS_EPISODE_REVIEW: REVIEW_ALIGNMENT — season shrink or an engine
//     invariant violation was detected; the catalog itself needs a human
//     look via the Series page, not just a status/confirmation click.
//   - NO_RELIABLE_PROVIDER: REVIEW_IDENTITY (including a confirmed decision
//     whose title/year sanity check failed) plus every series with no
//     decisions.json entry at all — genuinely unresolved identity.

import { UserSeriesStatus } from '@prisma/client';
import { isProtectedMigrationStatus } from '../../../library-health/migration-confirmation-logic';
import { BatchManifestEntry } from '../../../library-health/batch-manifest-logic';
import { PipelineManualReviewCandidate, PipelineSkippedSeriesEntry } from '../../../library-health/provider-confirmation-pipeline-reports';
import { MigrationOperatingClassification } from '../../common/migration-operating-classification';

export type MigrationWorkbenchCategory = 'READY_AUTOMATIC' | 'READY_FOR_CONFIRMATION' | 'NEEDS_EPISODE_REVIEW' | 'NO_RELIABLE_PROVIDER';

export interface MigrationWorkbenchProposalSummary {
  currentUserStatus: UserSeriesStatus;
  proposedUserStatus: UserSeriesStatus;
  matchedWatchedEpisodeCount: number;
  matchedTotalEpisodeCount: number;
  episodesToCreate: number;
  seasonsToCreate: number[];
  unmatchedWatchedOrphanCount: number;
  confidence: 'HIGH' | 'BORDERLINE';
}

export interface MigrationWorkbenchItem {
  seriesId: string;
  title: string;
  category: MigrationWorkbenchCategory;
  reason: string;
  // Only ever set for READY_AUTOMATIC/READY_FOR_CONFIRMATION — the batch
  // manifest is the only source with real, pre-computed proposal numbers.
  // NEEDS_EPISODE_REVIEW/NO_RELIABLE_PROVIDER items have nothing safe to
  // propose yet (that's precisely why they need a human first).
  proposal: MigrationWorkbenchProposalSummary | null;
}

// The dry-run preview's proposedUserStatus/statusSource can be wrong for a
// currently-PAUSED/DROPPED series that took the pipeline's older
// non-migration-aware write path (compareSeriesCatalog's own
// deriveUserStatusFromNextEpisode has no concept of protected statuses —
// see episode-release-refresh/refresh-logic.ts). The REAL apply-time write
// (tmdb-enrichment/apply-plan-writes.ts's decideUserStatusUpdate) always
// correctly refuses to override DROPPED/PAUSED regardless of what the
// preview claims, so this function makes the DISPLAYED proposal agree with
// what will actually happen, rather than surfacing a misleading preview.
// Reuses isProtectedMigrationStatus (migration-confirmation-logic.ts) —
// the exact same protected-status list the real write path checks against.
export function correctProposedStatusForProtection(currentUserStatus: UserSeriesStatus, proposedUserStatus: UserSeriesStatus): UserSeriesStatus {
  return isProtectedMigrationStatus(currentUserStatus) ? currentUserStatus : proposedUserStatus;
}

function toProposalSummary(entry: BatchManifestEntry): MigrationWorkbenchProposalSummary {
  const currentUserStatus = entry.currentUserStatus as UserSeriesStatus;
  return {
    currentUserStatus,
    proposedUserStatus: correctProposedStatusForProtection(currentUserStatus, entry.proposedUserStatus as UserSeriesStatus),
    matchedWatchedEpisodeCount: entry.matchedWatchedEpisodeCount,
    matchedTotalEpisodeCount: entry.matchedTotalEpisodeCount,
    episodesToCreate: entry.episodesToCreate,
    seasonsToCreate: entry.seasonsToCreate,
    unmatchedWatchedOrphanCount: entry.unmatchedWatchedOrphanCount,
    confidence: entry.identityBand === 'HIGH_CONFIDENCE' ? 'HIGH' : 'BORDERLINE',
  };
}

// A batch-manifest AUTO_MIGRATE entry only needs no further human review
// when identity is HIGH_CONFIDENCE AND nothing is being silently preserved
// around it (zero orphans) — anything else is still safe to write (the
// manifest only ever contains already-safe entries) but worth a quick
// human glance before it happens, per the product's "Ready for
// confirmation" tier.
export function classifyBatchManifestEntry(entry: BatchManifestEntry): MigrationWorkbenchItem {
  const isFullyDeterministic = entry.identityBand === 'HIGH_CONFIDENCE' && entry.unmatchedWatchedOrphanCount === 0;
  return {
    seriesId: entry.seriesId,
    title: entry.title,
    category: isFullyDeterministic ? 'READY_AUTOMATIC' : 'READY_FOR_CONFIRMATION',
    reason: entry.reason,
    proposal: toProposalSummary(entry),
  };
}

export function classifySkippedBlockedEntry(entry: PipelineSkippedSeriesEntry): MigrationWorkbenchItem | null {
  if (!entry.seriesId) return null; // no local series match at all — nothing to link a Workbench item to.
  if (entry.operatingClassification === 'REVIEW_ALIGNMENT') {
    return { seriesId: entry.seriesId, title: entry.title, category: 'NEEDS_EPISODE_REVIEW', reason: entry.reason, proposal: null };
  }
  // REVIEW_IDENTITY (including null, which PipelineSkippedSeriesEntry's own
  // docstring says is REVIEW_IDENTITY "by construction") — a confirmed
  // decision whose identity didn't actually check out live.
  return { seriesId: entry.seriesId, title: entry.title, category: 'NO_RELIABLE_PROVIDER', reason: entry.reason, proposal: null };
}

export function fromManualReviewCandidate(candidate: PipelineManualReviewCandidate): MigrationWorkbenchItem {
  return { seriesId: candidate.seriesId, title: candidate.title, category: 'NO_RELIABLE_PROVIDER', reason: candidate.reason, proposal: null };
}

// Lower number = more specific/actionable, wins when the same series
// appears more than once in a cache-derived item list.
const CATEGORY_SPECIFICITY: Record<MigrationWorkbenchCategory, number> = {
  READY_AUTOMATIC: 0,
  READY_FOR_CONFIRMATION: 1,
  NEEDS_EPISODE_REVIEW: 2,
  NO_RELIABLE_PROVIDER: 3,
};

// The CLI pipeline report can list the same series twice — historically, a
// REVIEW_ALIGNMENT outcome (identity fine, catalog shape needs review) was
// reported both under skippedBlockedSeries (correctly, as
// NEEDS_EPISODE_REVIEW via classifySkippedBlockedEntry) AND under
// nextManualReviewCandidates (always NO_RELIABLE_PROVIDER via
// fromManualReviewCandidate, a generic "no decision" fallback that doesn't
// actually apply once a decision exists) — see
// run-provider-confirmation-for-decision.ts's nextManualReviewCandidate
// construction, which now guards against generating this duplicate for new
// reports. This function defends the list() view against any cache file
// generated before that fix (regenerating the cache takes hours, so the
// list must stay correct without waiting for a fresh CLI run) and against
// any other future double-counting the cache might introduce, by keeping
// only the more specific/actionable of any duplicate seriesId entries.
export function dedupeBySeriesId(items: MigrationWorkbenchItem[]): MigrationWorkbenchItem[] {
  const bySeriesId = new Map<string, MigrationWorkbenchItem>();
  for (const item of items) {
    const existing = bySeriesId.get(item.seriesId);
    if (!existing || CATEGORY_SPECIFICITY[item.category] < CATEGORY_SPECIFICITY[existing.category]) {
      bySeriesId.set(item.seriesId, item);
    }
  }
  return [...bySeriesId.values()];
}

// --- Proposal reason codes (Migration Confirmation UX) --------------------
//
// GET /:seriesId/proposal used to surface only a long, free-text `reason`
// string as the PRIMARY UI signal — sometimes hundreds of characters (e.g.
// a real season-shrink case lists every unmatched watched episode by id).
// Mobile now renders a short, human summary derived from `reasonCode`,
// with the full `reason` text available as collapsible detail. The free
// text itself is unchanged and still returned — this is additive.

export type ProposalReasonCode =
  | 'NO_CONFIRMED_IDENTITY'
  | 'ALTERNATE_TITLE'
  | 'IDENTITY_CONFLICT'
  | 'PROVIDER_CATALOG_INCOMPLETE'
  | 'SEASON_STRUCTURE_MISMATCH'
  | 'WATCH_HISTORY_UNMAPPED'
  | 'ALREADY_MIGRATED'
  | 'SAFE_TO_APPLY';

export type ProposalAction = 'CONFIRM_MIGRATION' | 'REVIEW_SEASON_MISMATCH' | 'FIND_NEW_PROVIDER';

export interface ProposalReasonCodeInput {
  // Coarse outcome bucket the service layer already derived from
  // runProviderConfirmationForDecision's outcome.kind — kept as a small,
  // explicit union here (not the full outcome type) so this file stays a
  // pure, dependency-free *-logic.ts module.
  kind: 'no-decision' | 'already-applied' | 'eligible' | 'blocked' | 'error';
  // Only meaningful for kind: 'blocked' — the same operatingClassification
  // classifySkippedBlockedEntry already keys off, reused here for the same
  // REVIEW_ALIGNMENT vs REVIEW_IDENTITY split. Typed as the full canonical
  // union (rather than a narrower blocked-only subset) simply so callers
  // can pass PipelineSkippedSeriesEntry.operatingClassification through
  // unmodified — a 'blocked' outcome is never actually AUTO_MIGRATE/AUTO_REFRESH
  // in practice, but this file stays dependency-free by not asserting that here.
  operatingClassification?: MigrationOperatingClassification | null;
  // The raw reason text — pattern-matched ONLY to distinguish the two
  // title/year sanity sub-cases (a fixed, small set of template strings
  // checkTitleYearSanity itself produces — see provider-confirmation-decisions-logic.ts).
  reasonText?: string;
}

const YEAR_CONFLICT_MARKER = 'year differs sharply';
const TITLE_MISMATCH_MARKER = 'does not resemble local title';

export function deriveProposalReasonCode(input: ProposalReasonCodeInput): { reasonCode: ProposalReasonCode; availableActions: ProposalAction[] } {
  switch (input.kind) {
    case 'no-decision':
      return { reasonCode: 'NO_CONFIRMED_IDENTITY', availableActions: ['FIND_NEW_PROVIDER'] };
    case 'already-applied':
      return { reasonCode: 'ALREADY_MIGRATED', availableActions: [] };
    case 'eligible':
      return { reasonCode: 'SAFE_TO_APPLY', availableActions: ['CONFIRM_MIGRATION'] };
    case 'error':
      return { reasonCode: 'PROVIDER_CATALOG_INCOMPLETE', availableActions: ['FIND_NEW_PROVIDER'] };
    case 'blocked': {
      if (input.operatingClassification === 'REVIEW_ALIGNMENT') {
        return { reasonCode: 'SEASON_STRUCTURE_MISMATCH', availableActions: ['REVIEW_SEASON_MISMATCH'] };
      }
      const reasonText = input.reasonText ?? '';
      if (reasonText.includes(YEAR_CONFLICT_MARKER)) {
        return { reasonCode: 'IDENTITY_CONFLICT', availableActions: ['FIND_NEW_PROVIDER'] };
      }
      if (reasonText.includes(TITLE_MISMATCH_MARKER)) {
        return { reasonCode: 'ALTERNATE_TITLE', availableActions: ['FIND_NEW_PROVIDER'] };
      }
      if (reasonText.includes('orphaned watched episode') || reasonText.includes('real (non-zero) season')) {
        return { reasonCode: 'WATCH_HISTORY_UNMAPPED', availableActions: [] };
      }
      return { reasonCode: 'PROVIDER_CATALOG_INCOMPLETE', availableActions: ['FIND_NEW_PROVIDER'] };
    }
  }
}
