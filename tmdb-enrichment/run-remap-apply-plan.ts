// Rewrites a tmdb-apply-plan.json's mytvSeriesId fields to match the
// CURRENT database, by exact title lookup. Read-only against app tables —
// only writes a new plan JSON file alongside the original (never modifies
// the original). See remap-apply-plan.ts's header for why this exists.
//
// Refuses to write anything if any candidate's title is unmatched or
// ambiguous in the current database — a partial remap is not safe to feed
// into run-apply-plan.ts, since that would silently apply fewer candidates
// than the original plan without an explicit decision to do so.

import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { TmdbApplyPlan } from './apply-plan-types';
import { remapApplyPlanSeriesIds } from './remap-apply-plan';

interface CliOptions {
  planPath: string;
  outPath?: string;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.length === 0) {
    console.error('Usage: run-remap-apply-plan.ts --plan=<path to tmdb-apply-plan.json> [--out=<path>]');
    process.exit(1);
  }
  const options: Partial<CliOptions> = {};
  for (const arg of argv) {
    if (arg.startsWith('--plan=')) options.planPath = path.resolve(arg.slice('--plan='.length));
    else if (arg.startsWith('--out=')) options.outPath = path.resolve(arg.slice('--out='.length));
  }
  if (!options.planPath) {
    console.error('Missing required --plan=<path>');
    process.exit(1);
  }
  return options as CliOptions;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(options.planPath)) {
    console.error(`Plan file not found: ${options.planPath}`);
    process.exit(1);
  }

  const plan = JSON.parse(readFileSync(options.planPath, 'utf-8')) as TmdbApplyPlan;
  console.log(`Loaded plan from ${options.planPath}`);
  console.log(`  sourceBatchId: ${plan.sourceBatchId}`);
  console.log(`  safeApplyCandidates: ${plan.safeApplyCandidates.length}`);

  const prisma = new PrismaClient();
  const currentSeries = await prisma.series.findMany({ select: { id: true, title: true } });
  await prisma.$disconnect();

  const result = remapApplyPlanSeriesIds(plan, currentSeries);

  console.log(`\nRemapped: ${result.remapped.length}`);
  console.log(`Unmatched (no series with this title exists): ${result.unmatched.length}`);
  console.log(`Ambiguous (more than one series with this title exists): ${result.ambiguous.length}`);

  if (result.unmatched.length > 0) {
    console.log('\nUnmatched titles:');
    for (const t of result.unmatched) console.log(`  - ${t}`);
  }
  if (result.ambiguous.length > 0) {
    console.log('\nAmbiguous titles:');
    for (const t of result.ambiguous) console.log(`  - ${t}`);
  }

  if (result.unmatched.length > 0 || result.ambiguous.length > 0) {
    console.error('\nRefusing to write a remapped plan: not every candidate resolved to exactly one current series. Fix the mismatch and re-run.');
    process.exit(1);
  }

  const outPath = options.outPath ?? path.join(path.dirname(options.planPath), 'tmdb-apply-plan-remapped.json');
  writeFileSync(outPath, JSON.stringify(result.plan, null, 2));
  console.log(`\nAll ${result.remapped.length} candidates remapped cleanly. Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
