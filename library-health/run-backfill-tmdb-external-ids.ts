// ExternalIds.tmdbId Backfill — a narrow, one-time fix for a gap found
// during provider-confirmation investigation: run-provider-confirmation-pipeline.ts's
// apply transaction wrote ExternalIds.provider/providerId for every
// confirmed tmdb match, but never the dedicated, uniquely-constrained
// ExternalIds.tmdbId column that health-logic.ts (classifySeriesHealth's
// hasProviderMatch), episode-release-refresh (checkSeriesEligibility), and
// the app's own series.service.ts (hasAnyExternalId) all actually read.
// Confirmed titles were therefore still showing up as MISSING_PROVIDER_MATCH,
// ineligible for future episode refresh, and externalIds: null in the app.
// See docs/library-health-provider-confirmation-runbook.md.
//
// Scope is deliberately narrow and safe: only rows where provider='tmdb',
// tmdbId IS NULL, and matchSource starts with
// 'library-health:provider-confirmation-pipeline' — i.e. only rows this
// specific pipeline wrote. Never touches a row managed by a different
// process (e.g. the older tmdb-enrichment/apply-plan.ts pipeline, which
// already sets tmdbId itself via its own apply flow).
//
// Every candidate is checked for a tmdbId uniqueness collision (against
// every existing tmdbId in the table, not just this pipeline's own rows,
// and against every other candidate in the same batch) before being
// planned as safe to backfill — see tmdb-external-ids-backfill-logic.ts.
//
// Default mode is DRY RUN: fetches live data, builds the plan, reports it,
// writes nothing. Apply mode requires the explicit
// --apply-tmdb-id-backfill flag, and even then updates one row at a time
// with its own try/catch, so one unexpected failure never blocks another
// row — same isolation convention as run-provider-confirmation-pipeline.ts.
// Never creates or deletes an ExternalIds row, never touches provider,
// providerId, matchConfidence, matchSource, or matchedAt — the ONLY field
// this script ever writes is tmdbId.

import 'dotenv/config';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { BackfillCandidateRow, planTmdbIdBackfill } from './tmdb-external-ids-backfill-logic';
import {
  BackfillErrorEntry,
  buildTmdbExternalIdsBackfillMarkdownReport,
  buildTmdbExternalIdsBackfillReport,
  writeTmdbExternalIdsBackfillReports,
} from './tmdb-external-ids-backfill-reports';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');
const MATCH_SOURCE_PREFIX = 'library-health:provider-confirmation-pipeline';
const APPLY_FLAG = '--apply-tmdb-id-backfill';

interface CliOptions {
  outDir: string;
  apply: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('--apply') && !argv.includes(APPLY_FLAG)) {
    console.log(`Note: bare --apply is not the trigger for this script. Re-run with ${APPLY_FLAG} to actually write. Continuing as dry-run.`);
  }
  const options: CliOptions = { outDir: DEFAULT_OUT_DIR, apply: argv.includes(APPLY_FLAG) };
  for (const arg of argv) {
    if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  const generatedAt = new Date();

  console.log(`ExternalIds.tmdbId Backfill — mode: ${options.apply ? 'APPLY (writes will happen for safe candidates)' : 'DRY RUN (no writes)'}`);

  const [candidateRows, allTmdbIdRows] = await Promise.all([
    prisma.externalIds.findMany({
      where: { provider: 'tmdb', tmdbId: null, matchSource: { startsWith: MATCH_SOURCE_PREFIX } },
      select: { seriesId: true, providerId: true, matchSource: true, series: { select: { title: true } } },
    }),
    prisma.externalIds.findMany({ where: { tmdbId: { not: null } }, select: { tmdbId: true } }),
  ]);

  const candidates: BackfillCandidateRow[] = candidateRows.map((r) => ({
    seriesId: r.seriesId,
    title: r.series.title,
    providerId: r.providerId!,
    matchSource: r.matchSource,
  }));
  const existingTmdbIds = new Set(allTmdbIdRows.map((r) => r.tmdbId as string));

  console.log(`  candidates found: ${candidates.length}`);

  const plan = planTmdbIdBackfill({ candidates, existingTmdbIds });
  const backfillEntries = plan.filter((p) => p.action === 'backfill');
  const collisionEntries = plan.filter((p) => p.action === 'skip_collision');

  console.log(`  would backfill: ${backfillEntries.length} | collisions skipped: ${collisionEntries.length}`);
  for (const p of plan) console.log(`  [${p.action === 'backfill' ? 'BACKFILL' : 'SKIP_COLLISION'}] ${p.title} — tmdbId -> ${p.providerId}`);

  let appliedCount = 0;
  const errors: BackfillErrorEntry[] = [];

  if (options.apply) {
    for (const entry of backfillEntries) {
      try {
        await prisma.externalIds.update({ where: { seriesId: entry.seriesId }, data: { tmdbId: entry.providerId } });
        appliedCount++;
        console.log(`  [APPLIED] ${entry.title} — tmdbId set to ${entry.providerId}`);
      } catch (err) {
        const message = (err as Error).message;
        errors.push({ seriesId: entry.seriesId, title: entry.title, message });
        console.log(`  [ERROR] ${entry.title} — ${message}`);
      }
    }
  }

  const report = buildTmdbExternalIdsBackfillReport({ generatedAt, applied: options.apply, plan, appliedCount, errors });
  const markdown = buildTmdbExternalIdsBackfillMarkdownReport(report);
  const written = writeTmdbExternalIdsBackfillReports(options.outDir, report, markdown);

  console.log(`\nDone. Reports written:`);
  console.log(`  ${written.latestJsonPath}`);
  console.log(`  ${written.latestMarkdownPath}`);
  console.log(`  ${written.archivedJsonPath}`);
  console.log(`  ${written.archivedMarkdownPath}`);
  console.log('\nSummary:');
  console.log(JSON.stringify({ candidateCount: report.candidateCount, backfillCount: report.backfillCount, collisionCount: report.collisionCount, appliedCount: report.appliedCount, errorCount: report.errorCount }, null, 2));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
