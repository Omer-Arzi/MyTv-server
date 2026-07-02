import 'dotenv/config';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { TraktClient } from './trakt-client';
import { runEnrichmentDryRun } from './enrichment-dry-run';
import { buildEnrichmentReport, buildNeedsReview, writeDryRunReports } from './reports';
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
  const clientId = process.env.TRAKT_CLIENT_ID;
  if (!clientId) {
    console.error(
      'Missing TRAKT_CLIENT_ID. This script only calls Trakt\'s public GET endpoints (no OAuth), ' +
        'but those still require a client_id from a registered Trakt API app — set TRAKT_CLIENT_ID in .env. ' +
        'No request is made without it.',
    );
    process.exit(1);
  }

  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  const trakt = new TraktClient({ clientId });
  const startedAt = new Date();

  console.log('Trakt enrichment — dry run (no writes to Series/Season/Episode/ExternalIds)');
  console.log(`  target user: ${options.userId}`);
  console.log(`  series limit: ${options.limit ?? 'unlimited'}`);
  console.log(`  ignore cache: ${options.force}`);

  const result = await runEnrichmentDryRun(prisma, trakt, {
    userId: options.userId,
    limit: options.limit,
    force: options.force,
  });
  const finishedAt = new Date();

  const enrichmentReport = buildEnrichmentReport({ importBatchId: result.importBatchId, startedAt, finishedAt, userId: options.userId }, result);
  const needsReview = buildNeedsReview(result);
  const batchDir = writeDryRunReports(options.outDir, result.importBatchId, enrichmentReport, needsReview);

  console.log(`\nDone. Reports written to ${batchDir}`);
  console.log(JSON.stringify((enrichmentReport as { summary: unknown }).summary, null, 2));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
