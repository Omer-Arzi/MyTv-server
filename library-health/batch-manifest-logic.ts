// Pure logic for building a deterministic, dry-run-only batch manifest —
// Phase 6 of the stable-version migration policy work. No I/O, no Prisma,
// no Date.now()/randomUUID() (batchId/generatedAt are caller-supplied so
// the same report always produces a byte-identical manifest).
//
// Deliberately reads the EXISTING provider-confirmation-pipeline-reports.ts
// structures (dryRunSafeSeries / appliedSeries) rather than recomputing
// anything from raw series data — the task's explicit instruction was to
// extend, not duplicate, existing report structures. See
// run-provider-confirmation-pipeline.ts for where this gets invoked and
// written to disk.

import { PipelineAppliedSeriesEntry, PipelineDryRunSafeEntry, ProviderConfirmationPipelineReport } from './provider-confirmation-pipeline-reports';
import { MigrationOperatingClassification } from '../src/common/migration-operating-classification';

export interface BatchManifestOrphanLocation {
  seasonNumber: number;
  episodeNumber: number;
}

export interface BatchManifestEntry {
  seriesId: string;
  title: string;
  provider: string;
  providerId: string;
  identityBand: string;
  operatingClassification: MigrationOperatingClassification;
  reason: string;
  currentUserStatus: string;
  proposedUserStatus: string;
  statusSource: string;
  matchedWatchedEpisodeCount: number;
  matchedTotalEpisodeCount: number;
  unmatchedWatchedOrphanCount: number;
  orphanLocations: BatchManifestOrphanLocation[];
  // Always true for any entry that made it into a manifest: the write-path
  // invariant (buildMigrationApplyPlan's orphan-collision throw) is the
  // actual authority at apply time — an orphan that couldn't be preserved
  // untouched never reaches a successful plan in the first place, so it
  // never reaches this manifest either. See migration-confirmation-logic.ts.
  allOrphansGuaranteedPreserved: true;
  seasonsToCreate: number[];
  episodesToCreate: number;
  episodeMetadataUpdateCount: number;
  expectedProgressChange: boolean;
  expectedNextEpisodeIdChange: boolean;
}

export interface BatchManifest {
  batchId: string;
  executionMode: 'dry-run';
  generatedAt: string;
  targetUserId: string;
  totalTitlesConsidered: number;
  totalsByOperatingClassification: Record<MigrationOperatingClassification, number>;
  batchSize: number;
  seriesIds: string[];
  entries: BatchManifestEntry[];
  providerErrorCount: number;
  // Reserved for a future engine-invariant-violation reporting path.
  // Currently always 0: an invariant violation throws inside
  // buildMigrationApplyPlan rather than reaching the report as data — see
  // migration-confirmation-logic.ts. Kept as an explicit field (rather than
  // omitted) so a manifest consumer never has to guess whether "0" means
  // "checked, none found" or "not tracked at all."
  invariantFailureCount: 0;
}

function toEntry(s: PipelineDryRunSafeEntry | PipelineAppliedSeriesEntry): BatchManifestEntry {
  return {
    seriesId: s.seriesId,
    title: s.title,
    provider: s.provider,
    providerId: s.providerId,
    identityBand: s.identityBand,
    operatingClassification: s.operatingClassification,
    reason: s.autoMigrationEligibilityReason,
    currentUserStatus: s.userStatus.from,
    proposedUserStatus: s.userStatus.to,
    statusSource: s.statusSource,
    matchedWatchedEpisodeCount: s.matchedWatchedCount,
    matchedTotalEpisodeCount: s.matchedTotalCount,
    unmatchedWatchedOrphanCount: s.preservedOrphanEpisodeCount,
    orphanLocations: s.preservedOrphanEpisodes.map((e) => ({ seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber })),
    allOrphansGuaranteedPreserved: true,
    seasonsToCreate: s.seasonsCreated,
    episodesToCreate: s.episodesCreated,
    episodeMetadataUpdateCount: s.episodeUpdateCount,
    expectedProgressChange: s.userStatus.changed,
    expectedNextEpisodeIdChange: s.nextEpisodeId.changed,
  };
}

const EMPTY_CLASSIFICATION_COUNTS: Record<MigrationOperatingClassification, number> = {
  AUTO_MIGRATE: 0,
  AUTO_REFRESH: 0,
  REVIEW_IDENTITY: 0,
  REVIEW_ALIGNMENT: 0,
  PROVIDER_ERROR: 0,
};

export interface BuildBatchManifestInput {
  report: ProviderConfirmationPipelineReport;
  batchId: string;
  generatedAt: Date;
  // Which top-level outcomes are eligible for inclusion in the proposed
  // batch. Defaults to AUTO_MIGRATE only — AUTO_REFRESH titles have nothing
  // pending to apply, and REVIEW_*/PROVIDER_ERROR are never write
  // candidates by construction (see migration-operating-outcome.ts).
  includeClassifications?: MigrationOperatingClassification[];
  // Optional explicit series-id allow-list, for staged rollout batches
  // (Batch 1 / Batch 2 / Batch 3 — see the controlled rollout plan doc).
  // Omit to include every eligible title the report found.
  seriesIdFilter?: string[];
}

export function buildBatchManifest(input: BuildBatchManifestInput): BatchManifest {
  const includeSet = new Set(input.includeClassifications ?? (['AUTO_MIGRATE'] as MigrationOperatingClassification[]));
  const seriesIdFilterSet = input.seriesIdFilter ? new Set(input.seriesIdFilter) : null;

  const candidates: (PipelineDryRunSafeEntry | PipelineAppliedSeriesEntry)[] = [...input.report.dryRunSafeSeries, ...input.report.appliedSeries];

  const totalsByOperatingClassification: Record<MigrationOperatingClassification, number> = { ...EMPTY_CLASSIFICATION_COUNTS };
  for (const s of candidates) totalsByOperatingClassification[s.operatingClassification] += 1;
  for (const s of input.report.skippedBlockedSeries) {
    if (s.operatingClassification) totalsByOperatingClassification[s.operatingClassification] += 1;
  }
  totalsByOperatingClassification.PROVIDER_ERROR += input.report.errors.length;

  const entries = candidates
    .filter((s) => includeSet.has(s.operatingClassification))
    .filter((s) => !seriesIdFilterSet || seriesIdFilterSet.has(s.seriesId))
    // Deterministic ordering by seriesId (not insertion order), so the same
    // report always produces byte-identical manifest output regardless of
    // decisions.json iteration order.
    .sort((a, b) => a.seriesId.localeCompare(b.seriesId))
    .map(toEntry);

  const totalTitlesConsidered =
    input.report.appliedSeries.length +
    input.report.dryRunSafeSeries.length +
    input.report.alreadyAppliedSeries.length +
    input.report.skippedBlockedSeries.length +
    input.report.skippedDeferredSeries.length +
    input.report.errors.length;

  return {
    batchId: input.batchId,
    executionMode: 'dry-run',
    generatedAt: input.generatedAt.toISOString(),
    targetUserId: input.report.targetUserId,
    totalTitlesConsidered,
    totalsByOperatingClassification,
    batchSize: entries.length,
    seriesIds: entries.map((e) => e.seriesId),
    entries,
    providerErrorCount: input.report.errors.length,
    invariantFailureCount: 0,
  };
}
