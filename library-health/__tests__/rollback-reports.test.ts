import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildRollbackPreview, buildRollbackPreviewMarkdown, writeRollbackArtifacts } from '../rollback-reports';
import { RollbackManifest, RollbackPreviewEntry } from '../rollback-logic';

function manifest(overrides: Partial<RollbackManifest> = {}): RollbackManifest {
  return {
    batchId: 'batch-1',
    generatedAt: '2026-07-09T12:00:00.000Z',
    targetUserId: 'user-1',
    entries: [],
    scopeNote: 'Episode metadata backfills are NOT reversible by this tool.',
    ...overrides,
  };
}

function eligibleEntry(): RollbackPreviewEntry {
  return { seriesId: 's1', title: 'Chunibyo', eligible: true, refusalReasons: [], wouldDeleteEpisodeCount: 2, wouldDeleteSeasonNumbers: [2], wouldRestoreUserStatus: 'WATCHING', wouldRestoreNextEpisodeId: null };
}

function refusedEntry(): RollbackPreviewEntry {
  return { seriesId: 's2', title: 'The Office (US)', eligible: false, refusalReasons: ['CREATED_EPISODE_HAS_BEEN_WATCHED'], wouldDeleteEpisodeCount: 0, wouldDeleteSeasonNumbers: [], wouldRestoreUserStatus: null, wouldRestoreNextEpisodeId: null };
}

describe('buildRollbackPreview', () => {
  it('counts eligible vs refused correctly and never mutates mode', () => {
    const preview = buildRollbackPreview(manifest(), [eligibleEntry(), refusedEntry()]);
    expect(preview.mode).toBe('dry-run-preview');
    expect(preview.eligibleCount).toBe(1);
    expect(preview.refusedCount).toBe(1);
  });
});

describe('buildRollbackPreviewMarkdown', () => {
  it('renders eligible and refused sections with distinct guidance', () => {
    const preview = buildRollbackPreview(manifest(), [eligibleEntry(), refusedEntry()]);
    const md = buildRollbackPreviewMarkdown(preview, manifest().scopeNote);
    expect(md).toContain('No rows have been deleted or restored');
    expect(md).toContain('## Eligible for automatic rollback');
    expect(md).toContain('Chunibyo');
    expect(md).toContain('## Refused — requires manual recovery');
    expect(md).toContain('The Office (US)');
    expect(md).toContain('CREATED_EPISODE_HAS_BEEN_WATCHED');
    expect(md).toContain('not a best-effort destructive undo');
  });
});

describe('writeRollbackArtifacts', () => {
  it('writes manifest and preview JSON/markdown to latest + timestamped paths', () => {
    const outDir = mkdtempSync(path.join(tmpdir(), 'rollback-reports-test-'));
    try {
      const m = manifest({ entries: [] });
      const preview = buildRollbackPreview(m, [eligibleEntry()]);
      const md = buildRollbackPreviewMarkdown(preview, m.scopeNote);
      const written = writeRollbackArtifacts(outDir, m, preview, md);

      expect(JSON.parse(readFileSync(written.latestManifestJsonPath, 'utf-8'))).toEqual(m);
      expect(JSON.parse(readFileSync(written.latestPreviewJsonPath, 'utf-8'))).toEqual(preview);
      expect(readFileSync(written.latestPreviewMarkdownPath, 'utf-8')).toBe(md);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
