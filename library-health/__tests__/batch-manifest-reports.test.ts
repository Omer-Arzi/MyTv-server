import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildBatchManifestMarkdown, writeBatchManifest } from '../batch-manifest-reports';
import { BatchManifest } from '../batch-manifest-logic';

function manifest(overrides: Partial<BatchManifest> = {}): BatchManifest {
  return {
    batchId: 'batch-test-1',
    executionMode: 'dry-run',
    generatedAt: '2026-07-09T12:00:00.000Z',
    targetUserId: 'user-1',
    totalTitlesConsidered: 10,
    totalsByOperatingClassification: { AUTO_MIGRATE: 1, AUTO_REFRESH: 5, REVIEW_IDENTITY: 2, REVIEW_ALIGNMENT: 1, PROVIDER_ERROR: 1 },
    batchSize: 1,
    seriesIds: ['s1'],
    entries: [
      {
        seriesId: 's1',
        title: 'Chunibyo',
        provider: 'tmdb',
        providerId: '12345',
        identityBand: 'HIGH_CONFIDENCE',
        operatingClassification: 'AUTO_MIGRATE',
        reason: 'identity high-confidence, no structural risk',
        currentUserStatus: 'WATCHING',
        proposedUserStatus: 'COMPLETED',
        statusSource: 'derived',
        matchedWatchedEpisodeCount: 24,
        matchedTotalEpisodeCount: 24,
        unmatchedWatchedOrphanCount: 1,
        orphanLocations: [{ seasonNumber: 1, episodeNumber: 99 }],
        allOrphansGuaranteedPreserved: true,
        seasonsToCreate: [],
        episodesToCreate: 0,
        episodeMetadataUpdateCount: 3,
        expectedProgressChange: true,
        expectedNextEpisodeIdChange: true,
      },
    ],
    providerErrorCount: 1,
    invariantFailureCount: 0,
    ...overrides,
  };
}

describe('buildBatchManifestMarkdown', () => {
  it('renders batch id, mode, summary counts, and per-title detail', () => {
    const md = buildBatchManifestMarkdown(manifest());
    expect(md).toContain('dry-run artifact. No writes have occurred');
    expect(md).toContain('batch-test-1');
    expect(md).toContain('Chunibyo');
    expect(md).toContain('WATCHING');
    expect(md).toContain('COMPLETED');
    expect(md).toContain('S1E99');
  });

  it('renders a clear empty-batch message when there are no entries', () => {
    const md = buildBatchManifestMarkdown(manifest({ entries: [], batchSize: 0, seriesIds: [] }));
    expect(md).toContain('No titles are currently proposed for this batch');
  });
});

describe('writeBatchManifest', () => {
  it('writes latest + timestamped JSON and markdown files', () => {
    const outDir = mkdtempSync(path.join(tmpdir(), 'batch-manifest-test-'));
    try {
      const m = manifest();
      const md = buildBatchManifestMarkdown(m);
      const written = writeBatchManifest(outDir, m, md);

      expect(JSON.parse(readFileSync(written.latestJsonPath, 'utf-8'))).toEqual(m);
      expect(readFileSync(written.latestMarkdownPath, 'utf-8')).toBe(md);
      expect(JSON.parse(readFileSync(written.archivedJsonPath, 'utf-8'))).toEqual(m);
      expect(readFileSync(written.archivedMarkdownPath, 'utf-8')).toBe(md);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
