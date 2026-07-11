// Rollback preview — Phase 8/11. READ-ONLY: makes no writes of any kind,
// ever. Reads a completed apply run's report (the same
// latest-provider-confirmation-pipeline-report.json every apply already
// writes), builds a rollback manifest from its appliedSeries entries
// (rollback-logic.ts), live-checks eligibility per title against the
// current database state, and writes a preview showing exactly what an
// actual rollback would do — without doing any of it. Actually executing a
// rollback (rollback-executor.ts) is intentionally not wired to any CLI
// command in this task; see docs/stable-version-migration-todo.md Phase 11
// for why, and what running one for real requires.

import 'dotenv/config';
import path from 'path';
import { readFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { ProviderConfirmationPipelineReport } from './provider-confirmation-pipeline-reports';
import { buildRollbackManifest, evaluateRollbackEligibility, buildRollbackPreviewEntry } from './rollback-logic';
import { buildRollbackPreview, buildRollbackPreviewMarkdown, writeRollbackArtifacts } from './rollback-reports';
import { CATALOG_RECONCILIATION_IMPORT_BATCH_ID } from './migration-catalog-plan-logic';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');
const DEFAULT_REPORT_PATH = path.join(DEFAULT_OUT_DIR, 'latest-provider-confirmation-pipeline-report.json');

interface CliOptions {
  userId: string;
  outDir: string;
  reportPath: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { userId: DEV_USER_ID, outDir: DEFAULT_OUT_DIR, reportPath: DEFAULT_REPORT_PATH };
  for (const arg of argv) {
    if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
    else if (arg.startsWith('--report=')) options.reportPath = path.resolve(arg.slice('--report='.length));
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const generatedAt = new Date();

  console.log('Rollback preview — READ ONLY (no writes of any kind)');
  console.log(`  target user: ${options.userId}`);
  console.log(`  reading applied report: ${options.reportPath}`);

  const report: ProviderConfirmationPipelineReport = JSON.parse(readFileSync(options.reportPath, 'utf-8'));

  if (report.mode !== 'apply' || report.appliedSeries.length === 0) {
    console.log('  This report has no applied series — nothing to preview a rollback for. Re-run after a real apply.');
  }

  const batchId = `rollback-preview:${report.generatedAt}`;
  const manifest = buildRollbackManifest({ report, batchId, generatedAt, importBatchId: CATALOG_RECONCILIATION_IMPORT_BATCH_ID });

  const prisma = new PrismaClient();
  const previewEntries = [];
  for (const entry of manifest.entries) {
    const liveProgress = await prisma.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId: options.userId, seriesId: entry.seriesId } } });
    const createdEpisodes = await prisma.episode.findMany({ where: { importBatchId: entry.importBatchId, season: { seriesId: entry.seriesId } }, select: { id: true } });
    const createdEpisodeIds = createdEpisodes.map((e) => e.id);
    const watchedCreated =
      createdEpisodeIds.length > 0 ? await prisma.episodeWatch.findMany({ where: { episodeId: { in: createdEpisodeIds } }, select: { episodeId: true } }) : [];

    const eligibility = evaluateRollbackEligibility({
      entry,
      currentUserStatus: liveProgress?.userStatus ?? 'UNKNOWN',
      currentNextEpisodeId: liveProgress?.nextEpisodeId ?? null,
      createdEpisodesWithWatches: watchedCreated.map((w) => w.episodeId),
    });

    previewEntries.push(buildRollbackPreviewEntry(entry, eligibility));
    console.log(`  [${eligibility.eligible ? 'ELIGIBLE' : 'REFUSED'}] ${entry.title}${eligibility.eligible ? '' : ` — ${eligibility.refusalReasons.join(', ')}`}`);
  }
  await prisma.$disconnect();

  const preview = buildRollbackPreview(manifest, previewEntries);
  const markdown = buildRollbackPreviewMarkdown(preview, manifest.scopeNote);
  const written = writeRollbackArtifacts(options.outDir, manifest, preview, markdown);

  console.log(`\nDone. Rollback preview written (eligible: ${preview.eligibleCount}, refused: ${preview.refusedCount}):`);
  console.log(`  ${written.latestManifestJsonPath}`);
  console.log(`  ${written.latestPreviewJsonPath}`);
  console.log(`  ${written.latestPreviewMarkdownPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
