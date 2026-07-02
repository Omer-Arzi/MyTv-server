import 'dotenv/config';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { TmdbClient } from './tmdb-client';
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
  const accessToken = process.env.TMDB_ACCESS_TOKEN;
  if (!accessToken) {
    console.error(
      'Missing TMDB_ACCESS_TOKEN. This script authenticates with TMDb\'s v4 read access token as a ' +
        'Bearer token (not OAuth, not the legacy api_key) — set TMDB_ACCESS_TOKEN in .env. ' +
        'No request is made without it.',
    );
    process.exit(1);
  }

  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  const tmdb = new TmdbClient({ accessToken });
  const startedAt = new Date();

  console.log('TMDb enrichment — dry run (no writes to Series/Season/Episode/ExternalIds/UserSeriesProgress/EpisodeWatch/EpisodeRating/EpisodeEmotion/SeriesRating)');
  console.log(`  target user: ${options.userId}`);
  console.log(`  series limit: ${options.limit ?? 'unlimited'}`);
  console.log(`  ignore cache: ${options.force}`);

  const result = await runEnrichmentDryRun(prisma, tmdb, {
    userId: options.userId,
    limit: options.limit,
    force: options.force,
  });
  const finishedAt = new Date();

  const enrichmentReport = buildEnrichmentReport(
    { importBatchId: result.importBatchId, startedAt, finishedAt, userId: options.userId },
    result,
  );
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
