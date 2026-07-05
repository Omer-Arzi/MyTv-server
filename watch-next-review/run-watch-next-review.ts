// CLI for the Watch Next manual-review report. Read-only against app
// tables; makes zero TVmaze API calls (reuses the most recent
// secondary-provider-audit report already on disk). Writes only the two
// report files below — never Series/Season/Episode/ExternalIds/
// UserSeriesProgress/EpisodeWatch.

import 'dotenv/config';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { buildWatchNextReview, TvMazeAuditComparisonSlice } from './build-review';
import { writeWatchNextReview } from './reports';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');
const TVMAZE_AUDIT_OUTPUT_ROOT = path.join(__dirname, '..', 'secondary-provider-audit', 'output');

interface CliOptions {
  userId: string;
  outDir: string;
  tvmazeReportPath?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { userId: DEV_USER_ID, outDir: DEFAULT_OUT_DIR };
  for (const arg of argv) {
    if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
    else if (arg.startsWith('--tvmaze-report=')) options.tvmazeReportPath = path.resolve(arg.slice('--tvmaze-report='.length));
  }
  return options;
}

// Finds the most recently generated tvmaze-match-report.json under
// secondary-provider-audit/output/<batchId>/ — one directory per audit run,
// most recent batch (by mtime) wins unless --tvmaze-report= overrides it.
function findLatestTvMazeReport(): string | null {
  if (!existsSync(TVMAZE_AUDIT_OUTPUT_ROOT)) return null;

  const batchDirs = readdirSync(TVMAZE_AUDIT_OUTPUT_ROOT)
    .map((name) => path.join(TVMAZE_AUDIT_OUTPUT_ROOT, name))
    .filter((p) => statSync(p).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  for (const dir of batchDirs) {
    const candidate = path.join(dir, 'tvmaze-match-report.json');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  const tvmazeReportPath = options.tvmazeReportPath ?? findLatestTvMazeReport();

  console.log('Watch Next manual review — report-only, no writes to app tables, no TVmaze API calls');
  console.log(`  target user: ${options.userId}`);
  console.log(`  TVmaze audit source: ${tvmazeReportPath ?? 'none found — TVmaze fields will be empty'}`);

  let tvmazeComparisons: TvMazeAuditComparisonSlice[] = [];
  if (tvmazeReportPath) {
    const parsed = JSON.parse(readFileSync(tvmazeReportPath, 'utf-8'));
    tvmazeComparisons = parsed.comparisons ?? [];
  }

  const rows = await buildWatchNextReview(prisma, options.userId, tvmazeComparisons);

  const { jsonPath, mdPath } = writeWatchNextReview(
    options.outDir,
    { generatedAt: new Date(), userId: options.userId, tvmazeAuditSourcePath: tvmazeReportPath },
    rows,
  );

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.category] = (counts[r.category] ?? 0) + 1;

  console.log(`\nWatch Next items reviewed: ${rows.length}`);
  console.log(JSON.stringify(counts, null, 2));
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
