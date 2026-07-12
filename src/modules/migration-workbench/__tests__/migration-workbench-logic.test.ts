import { UserSeriesStatus } from '@prisma/client';
import { BatchManifestEntry } from '../../../../library-health/batch-manifest-logic';
import { PipelineManualReviewCandidate, PipelineSkippedSeriesEntry } from '../../../../library-health/provider-confirmation-pipeline-reports';
import {
  classifyBatchManifestEntry,
  classifySkippedBlockedEntry,
  correctProposedStatusForProtection,
  dedupeBySeriesId,
  deriveProposalReasonCode,
  fromManualReviewCandidate,
  MigrationWorkbenchItem,
} from '../migration-workbench-logic';

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

describe('dedupeBySeriesId', () => {
  function item(overrides: Partial<MigrationWorkbenchItem> = {}): MigrationWorkbenchItem {
    return { seriesId: 's1', title: 'Some Show', category: 'NO_RELIABLE_PROVIDER', reason: 'reason', proposal: null, ...overrides };
  }

  it('reproduces the real double-listing bug: keeps the NEEDS_EPISODE_REVIEW copy over the generic NO_RELIABLE_PROVIDER copy for the same series', () => {
    const alignmentCopy = item({ category: 'NEEDS_EPISODE_REVIEW', reason: 'season 1 shrank relative to the provider' });
    const manualReviewCopy = item({ category: 'NO_RELIABLE_PROVIDER', reason: 'no confirmed provider match and no decisions-file entry at all.' });

    expect(dedupeBySeriesId([alignmentCopy, manualReviewCopy])).toEqual([alignmentCopy]);
    expect(dedupeBySeriesId([manualReviewCopy, alignmentCopy])).toEqual([alignmentCopy]); // order-independent
  });

  it('prefers READY_AUTOMATIC over every other category for the same series', () => {
    const ready = item({ category: 'READY_AUTOMATIC' });
    const review = item({ category: 'NEEDS_EPISODE_REVIEW' });
    const none = item({ category: 'NO_RELIABLE_PROVIDER' });
    expect(dedupeBySeriesId([review, ready, none])).toEqual([ready]);
  });

  it('leaves distinct series completely untouched', () => {
    const a = item({ seriesId: 's1' });
    const b = item({ seriesId: 's2' });
    expect(dedupeBySeriesId([a, b])).toEqual([a, b]);
  });

  it('returns an empty array for an empty input', () => {
    expect(dedupeBySeriesId([])).toEqual([]);
  });
});

describe('deriveProposalReasonCode', () => {
  it('maps no-decision to NO_CONFIRMED_IDENTITY with a FIND_NEW_PROVIDER action', () => {
    expect(deriveProposalReasonCode({ kind: 'no-decision' })).toEqual({ reasonCode: 'NO_CONFIRMED_IDENTITY', availableActions: ['FIND_NEW_PROVIDER'] });
  });

  it('maps already-applied to ALREADY_MIGRATED with no actions', () => {
    expect(deriveProposalReasonCode({ kind: 'already-applied' })).toEqual({ reasonCode: 'ALREADY_MIGRATED', availableActions: [] });
  });

  it('maps eligible to SAFE_TO_APPLY with CONFIRM_MIGRATION', () => {
    expect(deriveProposalReasonCode({ kind: 'eligible' })).toEqual({ reasonCode: 'SAFE_TO_APPLY', availableActions: ['CONFIRM_MIGRATION'] });
  });

  it('maps a provider fetch error to PROVIDER_CATALOG_INCOMPLETE with FIND_NEW_PROVIDER', () => {
    expect(deriveProposalReasonCode({ kind: 'error' })).toEqual({ reasonCode: 'PROVIDER_CATALOG_INCOMPLETE', availableActions: ['FIND_NEW_PROVIDER'] });
  });

  it('maps blocked + REVIEW_ALIGNMENT to SEASON_STRUCTURE_MISMATCH with REVIEW_SEASON_MISMATCH — the Ranma ½ (2024) real case', () => {
    const result = deriveProposalReasonCode({ kind: 'blocked', operatingClassification: 'REVIEW_ALIGNMENT', reasonText: 'season 2 (12 local episode(s)) is missing entirely from the provider response' });
    expect(result).toEqual({ reasonCode: 'SEASON_STRUCTURE_MISMATCH', availableActions: ['REVIEW_SEASON_MISMATCH'] });
  });

  it('maps blocked + REVIEW_IDENTITY + a title-mismatch reason to ALTERNATE_TITLE — the Mirai Nikki real case', () => {
    const result = deriveProposalReasonCode({
      kind: 'blocked',
      operatingClassification: 'REVIEW_IDENTITY',
      reasonText: 'title/year sanity check failed: candidate title "The Future Diary" does not resemble local title "Mirai Nikki" (similarity 0.13, below the 0.6 floor)',
    });
    expect(result).toEqual({ reasonCode: 'ALTERNATE_TITLE', availableActions: ['FIND_NEW_PROVIDER'] });
  });

  it('maps blocked + REVIEW_IDENTITY + a year-conflict reason to IDENTITY_CONFLICT — the remake/reboot case', () => {
    const result = deriveProposalReasonCode({
      kind: 'blocked',
      operatingClassification: 'REVIEW_IDENTITY',
      reasonText: 'title matches exactly but year differs sharply (local hint 2005 vs candidate 2023) — possible remake/reboot mismatch',
    });
    expect(result).toEqual({ reasonCode: 'IDENTITY_CONFLICT', availableActions: ['FIND_NEW_PROVIDER'] });
  });

  it('maps blocked + real-season orphan reason to WATCH_HISTORY_UNMAPPED with no actions', () => {
    const result = deriveProposalReasonCode({
      kind: 'blocked',
      operatingClassification: 'REVIEW_IDENTITY',
      reasonText: '3 orphaned watched episode(s) are in real (non-zero) seasons — not benign',
    });
    expect(result).toEqual({ reasonCode: 'WATCH_HISTORY_UNMAPPED', availableActions: [] });
  });

  it('falls back to PROVIDER_CATALOG_INCOMPLETE for an unrecognized blocked reason', () => {
    const result = deriveProposalReasonCode({ kind: 'blocked', operatingClassification: 'PROVIDER_ERROR', reasonText: 'missing provider/providerId' });
    expect(result).toEqual({ reasonCode: 'PROVIDER_CATALOG_INCOMPLETE', availableActions: ['FIND_NEW_PROVIDER'] });
  });
});
