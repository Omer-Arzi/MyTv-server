import { UserSeriesStatus } from '@prisma/client';
import { BatchManifestEntry } from '../../../../library-health/batch-manifest-logic';
import { PipelineManualReviewCandidate, PipelineSkippedSeriesEntry } from '../../../../library-health/provider-confirmation-pipeline-reports';
import { classifyBatchManifestEntry, classifySkippedBlockedEntry, correctProposedStatusForProtection, fromManualReviewCandidate } from '../migration-workbench-logic';

function batchEntry(overrides: Partial<BatchManifestEntry> = {}): BatchManifestEntry {
  return {
    seriesId: 's1',
    title: 'Some Show',
    provider: 'tmdb',
    providerId: '123',
    identityBand: 'HIGH_CONFIDENCE',
    operatingClassification: 'AUTO_MIGRATE',
    reason: 'eligible',
    currentUserStatus: 'WATCHING',
    proposedUserStatus: 'WATCHING',
    statusSource: 'derived',
    matchedWatchedEpisodeCount: 10,
    matchedTotalEpisodeCount: 10,
    unmatchedWatchedOrphanCount: 0,
    orphanLocations: [],
    allOrphansGuaranteedPreserved: true,
    seasonsToCreate: [],
    episodesToCreate: 0,
    episodeMetadataUpdateCount: 0,
    expectedProgressChange: false,
    expectedNextEpisodeIdChange: false,
    ...overrides,
  };
}

describe('correctProposedStatusForProtection', () => {
  it('preserves PAUSED regardless of the proposed status', () => {
    expect(correctProposedStatusForProtection(UserSeriesStatus.PAUSED, UserSeriesStatus.WATCHING)).toBe(UserSeriesStatus.PAUSED);
  });

  it('preserves DROPPED regardless of the proposed status', () => {
    expect(correctProposedStatusForProtection(UserSeriesStatus.DROPPED, UserSeriesStatus.COMPLETED)).toBe(UserSeriesStatus.DROPPED);
  });

  it('passes through the proposed status for a non-protected current status', () => {
    expect(correctProposedStatusForProtection(UserSeriesStatus.WATCHING, UserSeriesStatus.COMPLETED)).toBe(UserSeriesStatus.COMPLETED);
  });
});

describe('classifyBatchManifestEntry', () => {
  it('classifies a HIGH_CONFIDENCE, zero-orphan entry as READY_AUTOMATIC', () => {
    const result = classifyBatchManifestEntry(batchEntry());
    expect(result.category).toBe('READY_AUTOMATIC');
  });

  it('classifies a BORDERLINE-confidence entry as READY_FOR_CONFIRMATION', () => {
    const result = classifyBatchManifestEntry(batchEntry({ identityBand: 'BORDERLINE' }));
    expect(result.category).toBe('READY_FOR_CONFIRMATION');
  });

  it('classifies a HIGH_CONFIDENCE entry with preserved orphans as READY_FOR_CONFIRMATION', () => {
    const result = classifyBatchManifestEntry(batchEntry({ unmatchedWatchedOrphanCount: 2 }));
    expect(result.category).toBe('READY_FOR_CONFIRMATION');
  });

  it('defensively corrects a PAUSED->WATCHING proposal to stay PAUSED', () => {
    const result = classifyBatchManifestEntry(batchEntry({ currentUserStatus: 'PAUSED', proposedUserStatus: 'WATCHING' }));
    expect(result.proposal?.currentUserStatus).toBe('PAUSED');
    expect(result.proposal?.proposedUserStatus).toBe('PAUSED');
  });

  it('leaves a legitimate ended+all-watched -> COMPLETED proposal untouched', () => {
    const result = classifyBatchManifestEntry(batchEntry({ currentUserStatus: 'CAUGHT_UP', proposedUserStatus: 'COMPLETED' }));
    expect(result.proposal?.proposedUserStatus).toBe('COMPLETED');
  });

  it('maps identityBand into a HIGH/BORDERLINE confidence field', () => {
    expect(classifyBatchManifestEntry(batchEntry({ identityBand: 'HIGH_CONFIDENCE' })).proposal?.confidence).toBe('HIGH');
    expect(classifyBatchManifestEntry(batchEntry({ identityBand: 'BORDERLINE' })).proposal?.confidence).toBe('BORDERLINE');
  });
});

describe('classifySkippedBlockedEntry', () => {
  const base: PipelineSkippedSeriesEntry = {
    title: 'Some Show',
    seriesId: 's1',
    classification: 'BLOCKED_RISK',
    reason: 'season shrink detected',
    migrationIntent: false,
    migrationClassification: null,
    operatingClassification: 'REVIEW_ALIGNMENT',
  };

  it('classifies REVIEW_ALIGNMENT as NEEDS_EPISODE_REVIEW', () => {
    const result = classifySkippedBlockedEntry(base);
    expect(result?.category).toBe('NEEDS_EPISODE_REVIEW');
    expect(result?.proposal).toBeNull();
  });

  it('classifies REVIEW_IDENTITY as NO_RELIABLE_PROVIDER', () => {
    const result = classifySkippedBlockedEntry({ ...base, operatingClassification: 'REVIEW_IDENTITY' });
    expect(result?.category).toBe('NO_RELIABLE_PROVIDER');
  });

  it('classifies a null operatingClassification as NO_RELIABLE_PROVIDER (REVIEW_IDENTITY by construction)', () => {
    const result = classifySkippedBlockedEntry({ ...base, operatingClassification: null });
    expect(result?.category).toBe('NO_RELIABLE_PROVIDER');
  });

  it('returns null when there is no local series match at all', () => {
    const result = classifySkippedBlockedEntry({ ...base, seriesId: null });
    expect(result).toBeNull();
  });
});

describe('fromManualReviewCandidate', () => {
  it('maps a manual review candidate to NO_RELIABLE_PROVIDER with a null proposal', () => {
    const candidate: PipelineManualReviewCandidate = { title: 'Unmatched Show', seriesId: 's2', reason: 'no confirmed provider match and no decisions-file entry at all.' };
    const result = fromManualReviewCandidate(candidate);
    expect(result).toEqual({ seriesId: 's2', title: 'Unmatched Show', category: 'NO_RELIABLE_PROVIDER', reason: candidate.reason, proposal: null });
  });
});
