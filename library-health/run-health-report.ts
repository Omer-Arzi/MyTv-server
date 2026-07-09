// Library Health report — READ-ONLY. See the task this was built for: an
// internal system that classifies every series into actionable data-health
// categories, without relying on ad hoc developer scripts or manual
// inspection to answer "which series are ready, which are risky, what
// needs to happen next."
//
// This script NEVER writes to the database and NEVER calls a provider API
// (unlike episode-release-refresh/run-refresh.ts) — every signal it uses is
// already in Postgres. Safe to run manually at any time, as often as you like.

import 'dotenv/config';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { classifySeriesHealth } from './health-logic';
import { loadSeriesHealthInputs } from './load-series-health-inputs';
import { buildLibraryHealthReport, buildMarkdownReport, writeLibraryHealthReports } from './reports';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');

interface CliOptions {
  userId: string;
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('--apply')) {
    console.error(
      'library-health does not support --apply and never will as currently scoped — this report is read-only ' +
        'by design (no DB writes, no provider writes). Re-run without --apply.',
    );
    process.exit(1);
  }

  const options: CliOptions = { userId: DEV_USER_ID, outDir: DEFAULT_OUT_DIR };
  for (const arg of argv) {
    if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  const generatedAt = new Date();

  console.log('Library Health report — READ-ONLY (no DB writes, no provider calls)');
  console.log(`  target user: ${options.userId}`);

  const inputs = await loadSeriesHealthInputs(prisma, options.userId);
  console.log(`  series inspected: ${inputs.length}`);

  const results = inputs.map((input) => classifySeriesHealth({ ...input, now: generatedAt }));

  const report = buildLibraryHealthReport({ generatedAt, targetUserId: options.userId, series: results });
  const markdown = buildMarkdownReport(report);
  const written = writeLibraryHealthReports(options.outDir, report, markdown);

  console.log(`\nDone. Reports written:`);
  console.log(`  ${written.latestJsonPath}`);
  console.log(`  ${written.latestMarkdownPath}`);
  console.log(`  ${written.archivedJsonPath}`);
  console.log(`  ${written.archivedMarkdownPath}`);
  console.log('\nSummary:');
  console.log(JSON.stringify(report.summary, null, 2));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
