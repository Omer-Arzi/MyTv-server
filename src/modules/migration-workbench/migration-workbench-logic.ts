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
