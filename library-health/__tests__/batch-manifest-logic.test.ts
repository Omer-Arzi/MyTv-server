import { buildBatchManifest } from '../batch-manifest-logic';
import { OperatingOutcomeFields, CatalogReconciliationFields, ProgressChangeFields, PipelineDryRunSafeEntry, ProviderConfirmationPipelineReport } from '../provider-confirmation-pipeline-reports';

function operatingFields(overrides: Partial<OperatingOutcomeFields> = {}): OperatingOutcomeFields {
  return {
    operatingClassification: 'AUTO_MIGRATE',
    identityBand: 'HIGH_CONFIDENCE',
    autoMigrationEligible: true,
    autoMigrationEligibilityReason: 'identity high-confidence, no structural risk',
    ...overrides,
  };
}

function catalogFields(overrides: Partial<CatalogReconciliationFields> = {}): CatalogReconciliationFields {
  return { seasonsCreated: [], episodesCreated: 0, matchedWatchedCount: 3, matchedTotalCount: 3, ...overrides };
}

function progressFields(overrides: Partial<ProgressChangeFields> = {}): ProgressChangeFields {
  return {
    userStatus: { from: 'WATCHING', to: 'COMPLETED', changed: true },
    nextEpisodeId: { from: 'ep-1', to: null, changed: true },
    ...overrides,
  };
}

function dryRunSafeEntry(overrides: Partial<PipelineDryRunSafeEntry> = {}): PipelineDryRunSafeEntry {
  return {
    title: 'Chunibyo',
    seriesId: 's1',
    provider: 'tmdb',
    providerId: '12345',
    classification: 'SAFE_TO_APPLY_LATER',
    episodeUpdateCount: 2,
    wouldUpdatePoster: false,
    preservedOrphanEpisodeCount: 1,
    preservedOrphanEpisodes: [{ id: 'orph-1', seasonNumber: 1, episodeNumber: 99 }],
    migrationIntent: false,
    statusSource: 'derived',
    migrationClassification: null,
    viaAutoMigrationPolicy: true,
    ...operatingFields(),
    ...catalogFields(),
    ...progressFields(),
    ...overrides,
  };
}

function baseReport(overrides: Partial<ProviderConfirmationPipelineReport> = {}): ProviderConfirmationPipelineReport {
  return {
    generatedAt: '2026-07-09T12:00:00.000Z',
    mode: 'dry-run',
    writesToAppTables: false,
    writesToProviderData: false,
    targetUserId: 'user-1',
    decisionsFilePath: '/repo/library-health/provider-confirmation-decisions.json',
    summary: {
      appliedCount: 0,
      dryRunSafeCount: 0,
      alreadyAppliedCount: 0,
      skippedBlockedCount: 0,
      skippedDeferredCount: 0,
      errorCount: 0,
      manualReviewCandidateCount: 0,
      preservedOrphanEpisodeCount: 0,
      viaAutoMigrationPolicyCount: 0,
      seasonsCreatedCount: 0,
      episodesCreatedCount: 0,
      operatingClassificationCounts: { AUTO_MIGRATE: 0, AUTO_REFRESH: 0, REVIEW_IDENTITY: 0, REVIEW_ALIGNMENT: 0, PROVIDER_ERROR: 0 },
      verificationFailureCount: 0,
    },
    appliedSeries: [],
    dryRunSafeSeries: [],
    alreadyAppliedSeries: [],
    skippedBlockedSeries: [],
    skippedDeferredSeries: [],
    errors: [],
    nextManualReviewCandidates: [],
    ...overrides,
  };
}

describe('buildBatchManifest', () => {
  it('includes only AUTO_MIGRATE entries by default, with full per-title detail', () => {
    const report = baseReport({ dryRunSafeSeries: [dryRunSafeEntry()] });
    const manifest = buildBatchManifest({ report, batchId: 'batch-1', generatedAt: new Date('2026-07-09T12:00:00.000Z') });

    expect(manifest.executionMode).toBe('dry-run');
    expect(manifest.batchId).toBe('batch-1');
    expect(manifest.batchSize).toBe(1);
    expect(manifest.seriesIds).toEqual(['s1']);

    const entry = manifest.entries[0];
    expect(entry.seriesId).toBe('s1');
    expect(entry.provider).toBe('tmdb');
    expect(entry.providerId).toBe('12345');
    expect(entry.identityBand).toBe('HIGH_CONFIDENCE');
    expect(entry.currentUserStatus).toBe('WATCHING');
    expect(entry.proposedUserStatus).toBe('COMPLETED');
    expect(entry.matchedWatchedEpisodeCount).toBe(3);
    expect(entry.matchedTotalEpisodeCount).toBe(3);
    expect(entry.unmatchedWatchedOrphanCount).toBe(1);
    expect(entry.orphanLocations).toEqual([{ seasonNumber: 1, episodeNumber: 99 }]);
    expect(entry.allOrphansGuaranteedPreserved).toBe(true);
    expect(entry.expectedProgressChange).toBe(true);
    expect(entry.expectedNextEpisodeIdChange).toBe(true);
  });

  it('excludes AUTO_REFRESH, REVIEW_IDENTITY, REVIEW_ALIGNMENT, and PROVIDER_ERROR entries from the proposed batch by default', () => {
    const report = baseReport({
      dryRunSafeSeries: [
        dryRunSafeEntry({ seriesId: 's-refresh', ...operatingFields({ operatingClassification: 'AUTO_REFRESH' }) }),
        dryRunSafeEntry({ seriesId: 's-review-identity', ...operatingFields({ operatingClassification: 'REVIEW_IDENTITY' }) }),
        dryRunSafeEntry({ seriesId: 's-review-alignment', ...operatingFields({ operatingClassification: 'REVIEW_ALIGNMENT' }) }),
        dryRunSafeEntry({ seriesId: 's-auto-migrate', ...operatingFields({ operatingClassification: 'AUTO_MIGRATE' }) }),
      ],
    });
    const manifest = buildBatchManifest({ report, batchId: 'batch-2', generatedAt: new Date() });
    expect(manifest.seriesIds).toEqual(['s-auto-migrate']);
  });

  it('is deterministic: sorts entries by seriesId regardless of input order', () => {
    const report = baseReport({
      dryRunSafeSeries: [dryRunSafeEntry({ seriesId: 'z-show' }), dryRunSafeEntry({ seriesId: 'a-show' }), dryRunSafeEntry({ seriesId: 'm-show' })],
    });
    const manifest = buildBatchManifest({ report, batchId: 'batch-3', generatedAt: new Date() });
    expect(manifest.seriesIds).toEqual(['a-show', 'm-show', 'z-show']);
  });

  it('respects an explicit seriesIdFilter, for staged rollout batches', () => {
    const report = baseReport({
      dryRunSafeSeries: [dryRunSafeEntry({ seriesId: 's1' }), dryRunSafeEntry({ seriesId: 's2' }), dryRunSafeEntry({ seriesId: 's3' })],
    });
    const manifest = buildBatchManifest({ report, batchId: 'batch-4', generatedAt: new Date(), seriesIdFilter: ['s2'] });
    expect(manifest.seriesIds).toEqual(['s2']);
    // totalTitlesConsidered still reflects the whole report, not just the filtered batch.
    expect(manifest.totalTitlesConsidered).toBe(3);
  });

  it('counts totalTitlesConsidered across every report bucket, and totalsByOperatingClassification across applied+dryRunSafe+blocked+errors', () => {
    const report = baseReport({
      dryRunSafeSeries: [dryRunSafeEntry()],
      alreadyAppliedSeries: [{ title: 'X', seriesId: 'sx', provider: 'tmdb', providerId: '1', classification: 'SAFE_TO_APPLY_LATER', migrationIntent: false, migrationClassification: null }],
      skippedBlockedSeries: [
        { title: 'Y', seriesId: 'sy', classification: 'BLOCKED_RISK', reason: 'season shrink', migrationIntent: false, migrationClassification: null, operatingClassification: 'REVIEW_ALIGNMENT' },
      ],
      skippedDeferredSeries: [{ title: 'Z', seriesId: null, classification: null, reason: 'deferred', migrationIntent: false, migrationClassification: null, operatingClassification: null }],
      errors: [{ title: 'W', message: 'fetch failed' }],
    });
    const manifest = buildBatchManifest({ report, batchId: 'batch-5', generatedAt: new Date() });
    expect(manifest.totalTitlesConsidered).toBe(5); // 1 dryRunSafe + 1 alreadyApplied + 1 blocked + 1 deferred + 1 error
    expect(manifest.totalsByOperatingClassification.AUTO_MIGRATE).toBe(1);
    expect(manifest.totalsByOperatingClassification.REVIEW_ALIGNMENT).toBe(1);
    expect(manifest.totalsByOperatingClassification.PROVIDER_ERROR).toBe(1);
    expect(manifest.providerErrorCount).toBe(1);
  });

  it('never writes anything — executionMode is always dry-run regardless of report.mode', () => {
    const report = baseReport({ mode: 'apply', appliedSeries: [] });
    const manifest = buildBatchManifest({ report, batchId: 'batch-6', generatedAt: new Date() });
    expect(manifest.executionMode).toBe('dry-run');
  });

  it('reports seasons/episodes to create from the preview fields, for a title with a large catalog gap', () => {
    const report = baseReport({
      dryRunSafeSeries: [dryRunSafeEntry({ ...catalogFields({ seasonsCreated: [2, 3], episodesCreated: 44, matchedWatchedCount: 20, matchedTotalCount: 20 }) })],
    });
    const manifest = buildBatchManifest({ report, batchId: 'batch-7', generatedAt: new Date() });
    expect(manifest.entries[0].seasonsToCreate).toEqual([2, 3]);
    expect(manifest.entries[0].episodesToCreate).toBe(44);
  });
});
