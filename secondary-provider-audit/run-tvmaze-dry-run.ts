// CLI entrypoint for the TVmaze secondary-provider dry run. No API key/OAuth
// needed — TVmaze's API is fully public. Read-only against app tables;
// writes only ImportBatch/ImportRawRow(cache)/ImportIssue, same safety
// contract as tmdb-enrichment/run-enrichment-dry-run.ts.

import 'dotenv/config';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { TvMazeClient } from './tvmaze-client';
import { runTvMazeDryRun } from './tvmaze-dry-run';
import { buildMatchReport, buildNeedsReview, buildSafeImprovements, writeDryRunReports } from './reports';
import { DEV_USER_ID } from '../src/common/constants';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');

interface CliOptions {
  userId: string;
  limit?: number;
  outDir: string;
  force: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { userId: DEV_USER_ID, outDir: DEFAULT_OUT_DIR, force: false };

  for (const arg of argv) {
    if (arg === '--force') options.force = true;
    else if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice('--limit='.length));
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  const tvmaze = new TvMazeClient();
  const startedAt = new Date();

  console.log('TVmaze secondary-provider audit — dry run (no API key needed; no writes to Series/Season/Episode/ExternalIds/UserSeriesProgress/EpisodeWatch)');
  console.log(`  target user: ${options.userId}`);
  console.log(`  series limit: ${options.limit ?? 'unlimited (whole library)'}`);
  console.log(`  ignore cache: ${options.force}`);

  const result = await runTvMazeDryRun(prisma, tvmaze, {
    userId: options.userId,
    limit: options.limit,
    force: options.force,
  });
  const finishedAt = new Date();

  const matchReport = buildMatchReport({ importBatchId: result.importBatchId, startedAt, finishedAt, userId: options.userId }, result);
  const needsReview = buildNeedsReview(result);
  const safeImprovements = buildSafeImprovements(result);
  const batchDir = writeDryRunReports(options.outDir, result.importBatchId, matchReport, needsReview, safeImprovements);

  console.log(`\nDone. Reports written to ${batchDir}`);
  console.log(JSON.stringify((matchReport as { summary: unknown }).summary, null, 2));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
