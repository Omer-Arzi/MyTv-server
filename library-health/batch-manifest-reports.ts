// Markdown rendering + file-writing for the batch manifest (batch-manifest-logic.ts).
// Split the same way provider-confirmation-pipeline-reports.ts and
// episode-release-refresh/reports.ts split their pure report-shape logic
// from disk I/O — kept separate here too, even though this file is small,
// so batch-manifest-logic.ts stays zero-I/O and fully unit-testable.

import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { BatchManifest } from './batch-manifest-logic';

export function buildBatchManifestMarkdown(manifest: BatchManifest): string {
  const lines: string[] = [];
  lines.push('# Batch Manifest — Proposed Auto-Migration Batch');
  lines.push('');
  lines.push('**This manifest is a dry-run artifact. No writes have occurred.** See `docs/stable-version-migration-todo.md` §Phase 6.');
  lines.push('');
  lines.push(`Batch id: \`${manifest.batchId}\``);
  lines.push(`Execution mode: \`${manifest.executionMode}\``);
  lines.push(`Generated: ${manifest.generatedAt}`);
  lines.push(`Target user: \`${manifest.targetUserId}\``);
  lines.push('');
  lines.push(`- Total titles considered: **${manifest.totalTitlesConsidered}**`);
  lines.push(`- Titles in this proposed batch: **${manifest.batchSize}**`);
  lines.push(`- Provider errors: ${manifest.providerErrorCount}`);
  lines.push(`- Invariant failures: ${manifest.invariantFailureCount}`);
  lines.push('');
  lines.push('| Operating classification | Count |');
  lines.push('| --- | --- |');
  for (const [classification, count] of Object.entries(manifest.totalsByOperatingClassification)) {
    lines.push(`| ${classification} | ${count} |`);
  }
  lines.push('');

  if (manifest.entries.length === 0) {
    lines.push('_No titles are currently proposed for this batch._');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## Proposed batch');
  lines.push('');
  for (const e of manifest.entries) {
    lines.push(`### ${e.title}`);
    lines.push('');
    lines.push(`- Series id: \`${e.seriesId}\` · Provider: \`${e.provider}:${e.providerId}\` · Identity: ${e.identityBand}`);
    lines.push(`- Reason: ${e.reason}`);
    lines.push(`- Status: ${e.currentUserStatus}${e.expectedProgressChange ? ` → **${e.proposedUserStatus}**` : ' (unchanged)'} (source: ${e.statusSource})`);
    lines.push(`- Matched episodes: ${e.matchedWatchedEpisodeCount}/${e.matchedTotalEpisodeCount} watched · Orphans preserved: ${e.unmatchedWatchedOrphanCount} (guaranteed: ${e.allOrphansGuaranteedPreserved})`);
    if (e.orphanLocations.length > 0) {
      lines.push(`  - Orphan locations: ${e.orphanLocations.map((o) => `S${o.seasonNumber}E${o.episodeNumber}`).join(', ')}`);
    }
    if (e.seasonsToCreate.length > 0 || e.episodesToCreate > 0) {
      lines.push(`- Catalog reconciliation: ${e.seasonsToCreate.length} season(s), ${e.episodesToCreate} episode(s) to create`);
    }
    lines.push(`- Episode metadata updates: ${e.episodeMetadataUpdateCount}`);
    lines.push(`- nextEpisodeId would change: ${e.expectedNextEpisodeIdChange}`);
    lines.push('');
  }

  return lines.join('\n');
}

export interface WrittenBatchManifestPaths {
  latestJsonPath: string;
  latestMarkdownPath: string;
  archivedJsonPath: string;
  archivedMarkdownPath: string;
}

export function writeBatchManifest(outDir: string, manifest: BatchManifest, markdown: string): WrittenBatchManifestPaths {
  const runsDir = path.join(outDir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  const json = JSON.stringify(manifest, null, 2);
  const timestamp = manifest.generatedAt.replace(/[:.]/g, '-');

  const latestJsonPath = path.join(outDir, 'latest-batch-manifest.json');
  const latestMarkdownPath = path.join(outDir, 'latest-batch-manifest.md');
  const archivedJsonPath = path.join(runsDir, `${timestamp}-batch-manifest.json`);
  const archivedMarkdownPath = path.join(runsDir, `${timestamp}-batch-manifest.md`);

  writeFileSync(latestJsonPath, json);
  writeFileSync(latestMarkdownPath, markdown);
  writeFileSync(archivedJsonPath, json);
  writeFileSync(archivedMarkdownPath, markdown);

  return { latestJsonPath, latestMarkdownPath, archivedJsonPath, archivedMarkdownPath };
}
