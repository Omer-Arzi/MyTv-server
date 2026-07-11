import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  buildProviderConfirmationPipelineMarkdownReport,
  buildProviderConfirmationPipelineReport,
  OperatingOutcomeFields,
  CatalogReconciliationFields,
  ProgressChangeFields,
  AppliedVerificationResult,
  writeProviderConfirmationPipelineReports,
} from '../provider-confirmation-pipeline-reports';

const generatedAt = new Date('2026-07-09T12:00:00.000Z');

// Sensible defaults for the stable-version migration policy fields, so
// existing fixtures below stay focused on what each test actually cares
// about instead of repeating this boilerplate everywhere.
function operatingFields(overrides: Partial<OperatingOutcomeFields> = {}): OperatingOutcomeFields {
  return {
    operatingClassification: 'AUTO_REFRESH',
    identityBand: 'HIGH_CONFIDENCE',
    autoMigrationEligible: false,
    autoMigrationEligibilityReason: 'not evaluated for this fixture',
    ...overrides,
  };
}

function catalogFields(overrides: Partial<CatalogReconciliationFields> = {}): CatalogReconciliationFields {
  return {
    seasonsCreated: [],
    episodesCreated: 0,
    matchedWatchedCount: 0,
    matchedTotalCount: 0,
    ...overrides,
  };
}

function progressFields(overrides: Partial<ProgressChangeFields> = {}): ProgressChangeFields {
  return {
    userStatus: { from: 'WATCHING', to: 'WATCHING', changed: false },
    nextEpisodeId: { from: null, to: null, changed: false },
    ...overrides,
  };
}

function passingVerification(overrides: Partial<AppliedVerificationResult> = {}): AppliedVerificationResult {
  return { passed: true, failedChecks: [], ...overrides };
}

function baseInput() {
  return {
    generatedAt,
    mode: 'dry-run' as const,
    targetUserId: 'user-1',
    decisionsFilePath: '/repo/library-health/provider-confirmation-decisions.json',
    appliedSeries: [],
    dryRunSafeSeries: [],
    alreadyAppliedSeries: [],
    skippedBlockedSeries: [],
    skippedDeferredSeries: [],
    errors: [],
    nextManualReviewCandidates: [],
  };
}

describe('buildProviderConfirmationPipelineReport', () => {
  it('aggregates counts correctly across every bucket', () => {
    const report = buildProviderConfirmationPipelineReport({
      ...baseInput(),
      mode: 'apply',
      appliedSeries: [
        {
          title: 'Friends', seriesId: 's1', provider: 'tvmaze', providerId: '431', classification: 'SAFE_TO_APPLY_LATER', episodeUpdateCount: 236, posterUpdated: true,
          preservedOrphanEpisodeCount: 0, preservedOrphanEpisodes: [], migrationIntent: false, statusSource: 'derived',
          migrationClassification: null, viaAutoMigrationPolicy: false, ...operatingFields({ operatingClassification: 'AUTO_MIGRATE' }), ...catalogFields(),
          ...progressFields({ userStatus: { from: 'WATCHING', to: 'COMPLETED', changed: true } }), verification: passingVerification(),
        },
        {
          title: 'The Office (US)', seriesId: 's2', provider: 'tmdb', providerId: '2316', classification: 'SAFE_WITH_SPLIT_EPISODE_TAIL', episodeUpdateCount: 14, posterUpdated: false,
          preservedOrphanEpisodeCount: 5, preservedOrphanEpisodes: [{ id: 'a', seasonNumber: 4, episodeNumber: 15 }],
          migrationIntent: false, statusSource: 'derived', migrationClassification: null, viaAutoMigrationPolicy: false,
          ...operatingFields({ operatingClassification: 'AUTO_MIGRATE' }), ...catalogFields({ seasonsCreated: [5], episodesCreated: 3 }), ...progressFields(), verification: passingVerification(),
        },
      ],
      skippedBlockedSeries: [{ title: 'The Flash (2014)', seriesId: 's3', classification: 'BLOCKED_RISK', reason: 'real mid-season gap', migrationIntent: false, migrationClassification: null, operatingClassification: 'REVIEW_ALIGNMENT' }],
      skippedDeferredSeries: [{ title: 'Naruto Shippuden', seriesId: null, classification: null, reason: 'decision is "defer"', migrationIntent: false, migrationClassification: null, operatingClassification: 'REVIEW_IDENTITY' }],
      errors: [{ title: 'Some Show', message: 'provider fetch failed: 500' }],
      nextManualReviewCandidates: [{ title: 'Brand New Show', seriesId: 's4', reason: 'no decisions-file entry at all' }],
    });

    expect(report.summary).toEqual({
      appliedCount: 2,
      dryRunSafeCount: 0,
      alreadyAppliedCount: 0,
      skippedBlockedCount: 1,
      skippedDeferredCount: 1,
      errorCount: 1,
      manualReviewCandidateCount: 1,
      preservedOrphanEpisodeCount: 5,
      viaAutoMigrationPolicyCount: 0,
      seasonsCreatedCount: 1,
      episodesCreatedCount: 3,
      operatingClassificationCounts: {
        AUTO_MIGRATE: 2,
        AUTO_REFRESH: 0,
        REVIEW_IDENTITY: 1,
        REVIEW_ALIGNMENT: 1,
        PROVIDER_ERROR: 1, // the one error counts here too
      },
      verificationFailureCount: 0,
    });
    expect(report.writesToAppTables).toBe(true);
    expect(report.writesToProviderData).toBe(false);
  });

  it('writesToAppTables is false in dry-run mode even if dryRunSafeSeries is non-empty', () => {
    const report = buildProviderConfirmationPipelineReport({
      ...baseInput(),
      mode: 'dry-run',
      dryRunSafeSeries: [
        {
          title: 'Friends', seriesId: 's1', provider: 'tvmaze', providerId: '431', classification: 'SAFE_TO_APPLY_LATER', episodeUpdateCount: 236, wouldUpdatePoster: true,
          preservedOrphanEpisodeCount: 0, preservedOrphanEpisodes: [], migrationIntent: false, statusSource: 'derived', migrationClassification: null, viaAutoMigrationPolicy: false,
          ...operatingFields(), ...catalogFields(), ...progressFields(),
        },
      ],
    });
    expect(report.writesToAppTables).toBe(false);
    expect(report.summary.dryRunSafeCount).toBe(1);
    expect(report.summary.appliedCount).toBe(0);
  });

  it('writesToAppTables is false in apply mode when nothing actually qualified to be applied', () => {
    const report = buildProviderConfirmationPipelineReport({ ...baseInput(), mode: 'apply', appliedSeries: [] });
    expect(report.writesToAppTables).toBe(false);
  });

  it('counts already-applied series separately from dryRunSafeCount/appliedCount — the fix for repeat-run reporting', () => {
    const report = buildProviderConfirmationPipelineReport({
      ...baseInput(),
      alreadyAppliedSeries: [
        { title: 'Friends', seriesId: 's1', provider: 'tvmaze', providerId: '431', classification: 'SAFE_TO_APPLY_LATER', migrationIntent: false, migrationClassification: null },
        { title: 'The Office (US)', seriesId: 's2', provider: 'tmdb', providerId: '2316', classification: 'SAFE_WITH_SPLIT_EPISODE_TAIL', migrationIntent: false, migrationClassification: null },
      ],
    });
    expect(report.summary.alreadyAppliedCount).toBe(2);
    expect(report.summary.dryRunSafeCount).toBe(0);
    expect(report.summary.appliedCount).toBe(0);
  });

  it('counts titles reached via the new auto-migration policy separately', () => {
    const report = buildProviderConfirmationPipelineReport({
      ...baseInput(),
      mode: 'apply',
      appliedSeries: [
        {
          title: 'Some Auto-Migrated Show', seriesId: 's5', provider: 'tmdb', providerId: '99', classification: 'BLOCKED_RISK', episodeUpdateCount: 2, posterUpdated: false,
          preservedOrphanEpisodeCount: 40, preservedOrphanEpisodes: [], migrationIntent: false, statusSource: 'preserved',
          migrationClassification: null, viaAutoMigrationPolicy: true, ...operatingFields({ operatingClassification: 'AUTO_MIGRATE', autoMigrationEligible: true }), ...catalogFields(),
          ...progressFields({ userStatus: { from: 'CAUGHT_UP', to: 'CAUGHT_UP', changed: false } }), verification: passingVerification(),
        },
      ],
    });
    expect(report.summary.viaAutoMigrationPolicyCount).toBe(1);
  });

  it('counts a verification failure and surfaces it prominently in the markdown report', () => {
    const report = buildProviderConfirmationPipelineReport({
      ...baseInput(),
      mode: 'apply',
      appliedSeries: [
        {
          title: 'Corrupted Apply Example', seriesId: 's6', provider: 'tmdb', providerId: '77', classification: 'SAFE_TO_APPLY_LATER', episodeUpdateCount: 0, posterUpdated: false,
          preservedOrphanEpisodeCount: 0, preservedOrphanEpisodes: [], migrationIntent: false, statusSource: 'derived',
          migrationClassification: null, viaAutoMigrationPolicy: false, ...operatingFields({ operatingClassification: 'AUTO_MIGRATE' }), ...catalogFields(), ...progressFields(),
          verification: { passed: false, failedChecks: ['preserved-orphans-untouched: mutated or missing orphan id(s): orph1'] },
        },
      ],
    });
    expect(report.summary.verificationFailureCount).toBe(1);

    const markdown = buildProviderConfirmationPipelineMarkdownReport(report);
    expect(markdown).toContain('## ⚠ Verification failures');
    expect(markdown).toContain('Corrupted Apply Example');
    expect(markdown).toContain('preserved-orphans-untouched');
  });

  it('omits the verification-failures section entirely when nothing failed', () => {
    const report = buildProviderConfirmationPipelineReport(baseInput());
    const markdown = buildProviderConfirmationPipelineMarkdownReport(report);
    expect(markdown).not.toContain('Verification failures');
  });
});

describe('buildProviderConfirmationPipelineMarkdownReport', () => {
  it('renders every non-empty section with its content', () => {
    const report = buildProviderConfirmationPipelineReport({
      ...baseInput(),
      mode: 'apply',
      appliedSeries: [
        {
          title: 'Friends', seriesId: 's1', provider: 'tvmaze', providerId: '431', classification: 'SAFE_TO_APPLY_LATER', episodeUpdateCount: 236, posterUpdated: true,
          preservedOrphanEpisodeCount: 0, preservedOrphanEpisodes: [], migrationIntent: false, statusSource: 'derived',
          migrationClassification: null, viaAutoMigrationPolicy: false, ...operatingFields({ operatingClassification: 'AUTO_MIGRATE' }), ...catalogFields(),
          ...progressFields({ userStatus: { from: 'WATCHING', to: 'COMPLETED', changed: true } }), verification: passingVerification(),
        },
      ],
      skippedBlockedSeries: [{ title: 'The Flash (2014)', seriesId: 's3', classification: 'BLOCKED_RISK', reason: 'real mid-season gap', migrationIntent: false, migrationClassification: null, operatingClassification: 'REVIEW_ALIGNMENT' }],
      skippedDeferredSeries: [{ title: 'Naruto Shippuden', seriesId: null, classification: null, reason: 'decision is "defer"', migrationIntent: false, migrationClassification: null, operatingClassification: 'REVIEW_IDENTITY' }],
      errors: [{ title: 'Some Show', message: 'provider fetch failed: 500' }],
      nextManualReviewCandidates: [{ title: 'Brand New Show', seriesId: 's4', reason: 'no decisions-file entry at all' }],
    });

    const markdown = buildProviderConfirmationPipelineMarkdownReport(report);

    expect(markdown).toContain('# Provider Confirmation Pipeline');
    expect(markdown).toContain('## Applied');
    expect(markdown).toContain('Friends');
    expect(markdown).toContain('userStatus WATCHING → COMPLETED');
    expect(markdown).toContain('## Skipped — blocked (never auto-applied)');
    expect(markdown).toContain('The Flash (2014)');
    expect(markdown).toContain('## Skipped — deferred/skip');
    expect(markdown).toContain('Naruto Shippuden');
    expect(markdown).toContain('## Errors');
    expect(markdown).toContain('Some Show');
    expect(markdown).toContain('## Next manual-review candidates');
    expect(markdown).toContain('Brand New Show');
  });

  it('omits empty sections entirely', () => {
    const report = buildProviderConfirmationPipelineReport(baseInput());
    const markdown = buildProviderConfirmationPipelineMarkdownReport(report);
    expect(markdown).not.toContain('## Applied');
    expect(markdown).not.toContain('## Errors');
    expect(markdown).not.toContain('## Next manual-review candidates');
  });

  it('includes preserved orphan episodes explicitly in the applied-series line', () => {
    const report = buildProviderConfirmationPipelineReport({
      ...baseInput(),
      mode: 'apply',
      appliedSeries: [
        {
          title: 'The Office (US)', seriesId: 's2', provider: 'tmdb', providerId: '2316', classification: 'SAFE_WITH_SPLIT_EPISODE_TAIL', episodeUpdateCount: 14, posterUpdated: false,
          preservedOrphanEpisodeCount: 2, preservedOrphanEpisodes: [{ id: 'a', seasonNumber: 4, episodeNumber: 15 }, { id: 'b', seasonNumber: 4, episodeNumber: 16 }],
          migrationIntent: false, statusSource: 'derived', migrationClassification: null, viaAutoMigrationPolicy: false,
          ...operatingFields({ operatingClassification: 'AUTO_MIGRATE' }), ...catalogFields(), ...progressFields(), verification: passingVerification(),
        },
      ],
    });
    const markdown = buildProviderConfirmationPipelineMarkdownReport(report);
    expect(markdown).toContain('preserved orphan(s): S4E15, S4E16');
  });

  it('renders the already-applied section separately from applied/safe-to-apply', () => {
    const report = buildProviderConfirmationPipelineReport({
      ...baseInput(),
      alreadyAppliedSeries: [{ title: 'Friends', seriesId: 's1', provider: 'tvmaze', providerId: '431', classification: 'SAFE_TO_APPLY_LATER', migrationIntent: false, migrationClassification: null }],
    });
    const markdown = buildProviderConfirmationPipelineMarkdownReport(report);
    expect(markdown).toContain('## Already applied (no changes needed)');
    expect(markdown).toContain('Friends');
    expect(markdown).not.toContain('## Applied\n');
    expect(markdown).not.toContain('## Safe to apply, not applied');
  });

  it('caps the manual-review-candidates list in markdown but keeps the full list in JSON', () => {
    const candidates = Array.from({ length: 223 }, (_, i) => ({ title: `Show ${i}`, seriesId: `s${i}`, reason: 'no decisions-file entry at all.' }));
    const report = buildProviderConfirmationPipelineReport({ ...baseInput(), nextManualReviewCandidates: candidates });

    expect(report.nextManualReviewCandidates).toHaveLength(223); // JSON keeps everything

    const markdown = buildProviderConfirmationPipelineMarkdownReport(report);
    expect(markdown).toContain('Show 0');
    expect(markdown).toContain('Show 19');
    expect(markdown).not.toContain('Show 20');
    expect(markdown).toContain('...and 203 more — see the JSON report for the full list.');
  });
});

describe('writeProviderConfirmationPipelineReports', () => {
  it('writes latest + timestamped JSON and markdown files', () => {
    const outDir = mkdtempSync(path.join(tmpdir(), 'pipeline-report-test-'));
    try {
      const report = buildProviderConfirmationPipelineReport(baseInput());
      const markdown = buildProviderConfirmationPipelineMarkdownReport(report);
      const written = writeProviderConfirmationPipelineReports(outDir, report, markdown);

      expect(JSON.parse(readFileSync(written.latestJsonPath, 'utf-8'))).toEqual(report);
      expect(readFileSync(written.latestMarkdownPath, 'utf-8')).toBe(markdown);
      expect(JSON.parse(readFileSync(written.archivedJsonPath, 'utf-8'))).toEqual(report);
      expect(readFileSync(written.archivedMarkdownPath, 'utf-8')).toBe(markdown);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
