// Markdown rendering + file-writing for the rollback manifest and rollback
// preview (rollback-logic.ts). Same split as batch-manifest-reports.ts:
// keeps rollback-logic.ts zero-I/O and fully unit-testable.

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { RollbackManifest, RollbackPreviewEntry } from './rollback-logic';

export interface RollbackPreview {
  batchId: string;
  generatedAt: string;
  targetUserId: string;
  mode: 'dry-run-preview';
  entries: RollbackPreviewEntry[];
  eligibleCount: number;
  refusedCount: number;
}

export function buildRollbackPreview(manifest: RollbackManifest, entries: RollbackPreviewEntry[]): RollbackPreview {
  return {
    batchId: manifest.batchId,
    generatedAt: manifest.generatedAt,
    targetUserId: manifest.targetUserId,
    mode: 'dry-run-preview',
    entries,
    eligibleCount: entries.filter((e) => e.eligible).length,
    refusedCount: entries.filter((e) => !e.eligible).length,
  };
}

export function buildRollbackPreviewMarkdown(preview: RollbackPreview, scopeNote: string): string {
  const lines: string[] = [];
  lines.push('# Rollback Preview');
  lines.push('');
  lines.push('**This is a preview only. No rows have been deleted or restored.**');
  lines.push('');
  lines.push(`Batch id: \`${preview.batchId}\``);
  lines.push(`Generated: ${preview.generatedAt}`);
  lines.push(`Target user: \`${preview.targetUserId}\``);
  lines.push('');
  lines.push(`- Eligible for automatic rollback: **${preview.eligibleCount}**`);
  lines.push(`- Refused (require manual recovery): **${preview.refusedCount}**`);
  lines.push('');
  lines.push(`> ${scopeNote}`);
  lines.push('');

  const eligible = preview.entries.filter((e) => e.eligible);
  const refused = preview.entries.filter((e) => !e.eligible);

  if (eligible.length > 0) {
    lines.push('## Eligible for automatic rollback');
    lines.push('');
    for (const e of eligible) {
      lines.push(
        `- **${e.title}** (\`${e.seriesId}\`) — would delete ${e.wouldDeleteEpisodeCount} episode(s) across season(s) [${e.wouldDeleteSeasonNumbers.join(', ')}], would restore status to \`${e.wouldRestoreUserStatus}\` (nextEpisodeId: \`${e.wouldRestoreNextEpisodeId ?? 'none'}\`)`,
      );
    }
    lines.push('');
  }

  if (refused.length > 0) {
    lines.push('## Refused — requires manual recovery');
    lines.push('');
    lines.push('_The preferred behavior for these is refusal, not a best-effort destructive undo. Investigate manually before touching this data._');
    lines.push('');
    for (const e of refused) {
      lines.push(`- **${e.title}** (\`${e.seriesId}\`) — ${e.refusalReasons.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export interface WrittenRollbackPaths {
  latestManifestJsonPath: string;
  latestPreviewJsonPath: string;
  latestPreviewMarkdownPath: string;
}

export function writeRollbackArtifacts(outDir: string, manifest: RollbackManifest, preview: RollbackPreview, previewMarkdown: string): WrittenRollbackPaths {
  const runsDir = path.join(outDir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  const timestamp = manifest.generatedAt.replace(/[:.]/g, '-');

  const latestManifestJsonPath = path.join(outDir, 'latest-rollback-manifest.json');
  const latestPreviewJsonPath = path.join(outDir, 'latest-rollback-preview.json');
  const latestPreviewMarkdownPath = path.join(outDir, 'latest-rollback-preview.md');
  const archivedManifestJsonPath = path.join(runsDir, `${timestamp}-rollback-manifest.json`);
  const archivedPreviewJsonPath = path.join(runsDir, `${timestamp}-rollback-preview.json`);
  const archivedPreviewMarkdownPath = path.join(runsDir, `${timestamp}-rollback-preview.md`);

  writeFileSync(latestManifestJsonPath, JSON.stringify(manifest, null, 2));
  writeFileSync(latestPreviewJsonPath, JSON.stringify(preview, null, 2));
  writeFileSync(latestPreviewMarkdownPath, previewMarkdown);
  writeFileSync(archivedManifestJsonPath, JSON.stringify(manifest, null, 2));
  writeFileSync(archivedPreviewJsonPath, JSON.stringify(preview, null, 2));
  writeFileSync(archivedPreviewMarkdownPath, previewMarkdown);

  return { latestManifestJsonPath, latestPreviewJsonPath, latestPreviewMarkdownPath };
}
