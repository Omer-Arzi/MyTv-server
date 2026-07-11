import { buildRollbackManifest, evaluateRollbackEligibility, buildRollbackPreviewEntry, RollbackManifestEntry } from '../rollback-logic';
import { OperatingOutcomeFields, CatalogReconciliationFields, ProgressChangeFields, PipelineAppliedSeriesEntry, ProviderConfirmationPipelineReport } from '../provider-confirmation-pipeline-reports';

const BATCH_ID = 'library-health:provider-confirmation-pipeline:catalog-reconciliation';

function operatingFields(overrides: Partial<OperatingOutcomeFields> = {}): OperatingOutcomeFields {
  return { operatingClassification: 'AUTO_MIGRATE', identityBand: 'HIGH_CONFIDENCE', autoMigrationEligible: true, autoMigrationEligibilityReason: 'ok', ...overrides };
}
function catalogFields(overrides: Partial<CatalogReconciliationFields> = {}): CatalogReconciliationFields {
  return { seasonsCreated: [2], episodesCreated: 2, matchedWatchedCount: 3, matchedTotalCount: 3, ...overrides };
}
function progressFields(overrides: Partial<ProgressChangeFields> = {}): ProgressChangeFields {
  return { userStatus: { from: 'WATCHING', to: 'COMPLETED', changed: true }, nextEpisodeId: { from: 'ep-1', to: null, changed: true }, ...overrides };
}

function appliedEntry(overrides: Partial<PipelineAppliedSeriesEntry> = {}): PipelineAppliedSeriesEntry {
  return {
    title: 'Chunibyo',
    seriesId: 's1',
    provider: 'tmdb',
    providerId: '12345',
    classification: 'BLOCKED_RISK',
    episodeUpdateCount: 0,
    posterUpdated: false,
    preservedOrphanEpisodeCount: 1,
    preservedOrphanEpisodes: [{ id: 'orph1', seasonNumber: 1, episodeNumber: 99 }],
    migrationIntent: false,
    statusSource: 'derived',
    migrationClassification: null,
    viaAutoMigrationPolicy: true,
    verification: { passed: true, failedChecks: [] },
    ...operatingFields(),
    ...catalogFields(),
    ...progressFields(),
    ...overrides,
  };
}

function baseReport(overrides: Partial<ProviderConfirmationPipelineReport> = {}): ProviderConfirmationPipelineReport {
  return {
    generatedAt: '2026-07-09T12:00:00.000Z',
    mode: 'apply',
    writesToAppTables: true,
    writesToProviderData: false,
    targetUserId: 'user-1',
    decisionsFilePath: '/repo/library-health/provider-confirmation-decisions.json',
    summary: {
      appliedCount: 0, dryRunSafeCount: 0, alreadyAppliedCount: 0, skippedBlockedCount: 0, skippedDeferredCount: 0, errorCount: 0, manualReviewCandidateCount: 0,
      preservedOrphanEpisodeCount: 0, viaAutoMigrationPolicyCount: 0, seasonsCreatedCount: 0, episodesCreatedCount: 0,
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

describe('buildRollbackManifest', () => {
  it('builds one entry per applied series, sorted by seriesId, carrying prior/applied progress and created-row counts', () => {
    const report = baseReport({ appliedSeries: [appliedEntry({ seriesId: 'z1' }), appliedEntry({ seriesId: 'a1' })] });
    const manifest = buildRollbackManifest({ report, batchId: 'batch-1', generatedAt: new Date(), importBatchId: BATCH_ID });
    expect(manifest.entries.map((e) => e.seriesId)).toEqual(['a1', 'z1']);
    expect(manifest.entries[0].priorUserStatus).toBe('WATCHING');
    expect(manifest.entries[0].appliedUserStatus).toBe('COMPLETED');
    expect(manifest.entries[0].createdSeasonNumbers).toEqual([2]);
    expect(manifest.entries[0].hasReversibleChanges).toBe(true);
  });

  it('flags entries with only unsupported metadata changes as not having reversible changes', () => {
    const report = baseReport({
      appliedSeries: [
        appliedEntry({
          ...catalogFields({ seasonsCreated: [], episodesCreated: 0 }),
          ...progressFields({ userStatus: { from: 'WATCHING', to: 'WATCHING', changed: false }, nextEpisodeId: { from: null, to: null, changed: false } }),
          episodeUpdateCount: 5,
        }),
      ],
    });
    const manifest = buildRollbackManifest({ report, batchId: 'batch-2', generatedAt: new Date(), importBatchId: BATCH_ID });
    expect(manifest.entries[0].hasReversibleChanges).toBe(false);
    expect(manifest.entries[0].unsupportedChangeNote).toContain('5 episode metadata field update(s)');
  });

  it('always carries an explicit scope note documenting what is NOT reversible', () => {
    const manifest = buildRollbackManifest({ report: baseReport({ appliedSeries: [appliedEntry()] }), batchId: 'batch-3', generatedAt: new Date(), importBatchId: BATCH_ID });
    expect(manifest.scopeNote).toContain('NOT reversible');
  });
});

describe('evaluateRollbackEligibility', () => {
  function manifestEntry(overrides: Partial<RollbackManifestEntry> = {}): RollbackManifestEntry {
    return {
      seriesId: 's1',
      title: 'Chunibyo',
      importBatchId: BATCH_ID,
      priorUserStatus: 'WATCHING',
      priorNextEpisodeId: 'ep-1',
      appliedUserStatus: 'COMPLETED',
      appliedNextEpisodeId: null,
      createdSeasonNumbers: [2],
      createdEpisodeCount: 2,
      episodeMetadataUpdateCount: 0,
      hasReversibleChanges: true,
      unsupportedChangeNote: null,
      ...overrides,
    };
  }

  it('allows rollback when nothing has changed since the apply', () => {
    const result = evaluateRollbackEligibility({
      entry: manifestEntry(),
      currentUserStatus: 'COMPLETED',
      currentNextEpisodeId: null,
      createdEpisodesWithWatches: [],
    });
    expect(result.eligible).toBe(true);
    expect(result.refusalReasons).toEqual([]);
  });

  it('refuses when a newly-created episode has since been watched', () => {
    const result = evaluateRollbackEligibility({
      entry: manifestEntry(),
      currentUserStatus: 'COMPLETED',
      currentNextEpisodeId: null,
      createdEpisodesWithWatches: ['new-ep-1'],
    });
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons).toContain('CREATED_EPISODE_HAS_BEEN_WATCHED');
  });

  it('refuses when progress has drifted since the apply (user status changed since)', () => {
    const result = evaluateRollbackEligibility({
      entry: manifestEntry(),
      currentUserStatus: 'DROPPED', // no longer COMPLETED, as the batch left it
      currentNextEpisodeId: null,
      createdEpisodesWithWatches: [],
    });
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons).toContain('PROGRESS_HAS_DRIFTED_SINCE_APPLY');
  });

  it('refuses when progress has drifted since the apply (nextEpisodeId moved on — user watched further)', () => {
    const result = evaluateRollbackEligibility({
      entry: manifestEntry(),
      currentUserStatus: 'COMPLETED',
      currentNextEpisodeId: 'some-later-episode',
      createdEpisodesWithWatches: [],
    });
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons).toContain('PROGRESS_HAS_DRIFTED_SINCE_APPLY');
  });

  it('refuses when there is nothing safely attributable to this batch to reverse (no reversible changes recorded)', () => {
    const result = evaluateRollbackEligibility({
      entry: manifestEntry({ hasReversibleChanges: false, createdSeasonNumbers: [], createdEpisodeCount: 0, priorUserStatus: 'WATCHING', appliedUserStatus: 'WATCHING', priorNextEpisodeId: null, appliedNextEpisodeId: null }),
      currentUserStatus: 'WATCHING',
      currentNextEpisodeId: null,
      createdEpisodesWithWatches: [],
    });
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons).toContain('NO_REVERSIBLE_CHANGES');
  });

  it('can report multiple simultaneous refusal reasons', () => {
    const result = evaluateRollbackEligibility({
      entry: manifestEntry(),
      currentUserStatus: 'DROPPED',
      currentNextEpisodeId: null,
      createdEpisodesWithWatches: ['new-ep-1'],
    });
    expect(result.refusalReasons).toEqual(expect.arrayContaining(['CREATED_EPISODE_HAS_BEEN_WATCHED', 'PROGRESS_HAS_DRIFTED_SINCE_APPLY']));
  });
});

describe('buildRollbackPreviewEntry', () => {
  const entry: RollbackManifestEntry = {
    seriesId: 's1',
    title: 'Chunibyo',
    importBatchId: BATCH_ID,
    priorUserStatus: 'WATCHING',
    priorNextEpisodeId: 'ep-1',
    appliedUserStatus: 'COMPLETED',
    appliedNextEpisodeId: null,
    createdSeasonNumbers: [2],
    createdEpisodeCount: 2,
    episodeMetadataUpdateCount: 0,
    hasReversibleChanges: true,
    unsupportedChangeNote: null,
  };

  it('shows what WOULD be reverted for an eligible series, without performing any write', () => {
    const preview = buildRollbackPreviewEntry(entry, { seriesId: 's1', eligible: true, refusalReasons: [] });
    expect(preview.eligible).toBe(true);
    expect(preview.wouldDeleteEpisodeCount).toBe(2);
    expect(preview.wouldDeleteSeasonNumbers).toEqual([2]);
    expect(preview.wouldRestoreUserStatus).toBe('WATCHING');
    expect(preview.wouldRestoreNextEpisodeId).toBe('ep-1');
  });

  it('shows nothing planned for a refused series', () => {
    const preview = buildRollbackPreviewEntry(entry, { seriesId: 's1', eligible: false, refusalReasons: ['CREATED_EPISODE_HAS_BEEN_WATCHED'] });
    expect(preview.eligible).toBe(false);
    expect(preview.wouldDeleteEpisodeCount).toBe(0);
    expect(preview.wouldDeleteSeasonNumbers).toEqual([]);
    expect(preview.wouldRestoreUserStatus).toBeNull();
    expect(preview.wouldRestoreNextEpisodeId).toBeNull();
  });
});
