// Applies watch-next-decisions.json. Default mode is dry-run — nothing is
// written unless --apply is passed. Only ever acts on decision ===
// "mark_caught_up" rows; every other decision value is informational only
// (keep_in_watch_next/needs_mapping/ignore_for_now never trigger a write).
//
// For each mark_caught_up row, re-checks the CURRENT UserSeriesProgress
// state against what was true when the decision was written
// (reviewedUserStatus/reviewedNextEpisodeId) — see apply-logic.ts. A row
// only gets touched if userStatus is still WATCHING and nextEpisodeId still
// matches; anything else is skipped as stale/conflicting, never forced.
//
// A "would_apply" write clears nextEpisodeId and sets userStatus to
// CAUGHT_UP — the exact same "no next episode -> CAUGHT_UP" outcome
// deriveUserStatusFromNextEpisode already uses everywhere else in this app,
// just applied here from a human decision instead of a recomputed catalog
// lookup.

import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { ImportIssueSeverity, ImportStatus, PrismaClient, UserSeriesStatus } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { DecisionToEvaluate, evaluateMarkCaughtUpDecision } from './apply-logic';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');
const DEFAULT_DECISIONS_PATH = path.join(DEFAULT_OUT_DIR, 'watch-next-decisions.json');
const BATCH_SOURCE = 'watch-next-review-apply-decisions';

interface CliOptions {
  decisionsPath: string;
  userId?: string; // decisions.json doesn't carry userId per-row (single-user review), so it's supplied here
  apply: boolean;
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { decisionsPath: DEFAULT_DECISIONS_PATH, apply: false, outDir: DEFAULT_OUT_DIR };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--decisions=')) options.decisionsPath = path.resolve(arg.slice('--decisions='.length));
    else if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
  }
  return options;
}

interface DecisionRow extends DecisionToEvaluate {
  mytvSeriesId: string;
  seriesTitle: string;
  category: string;
}

interface RowResult {
  mytvSeriesId: string;
  seriesTitle: string;
  category: string;
  decision: string;
  outcome: string;
  reason: string;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(options.decisionsPath)) {
    console.error(`Decisions file not found: ${options.decisionsPath} — run run-build-decisions.ts first.`);
    process.exit(1);
  }

  const decisionsFile = JSON.parse(readFileSync(options.decisionsPath, 'utf-8'));
  const rows: DecisionRow[] = decisionsFile.decisions ?? [];

  const userId = options.userId ?? DEV_USER_ID;

  const prisma = new PrismaClient();

  console.log(`Watch Next decisions apply — mode: ${options.apply ? 'REAL APPLY' : 'DRY RUN (default)'}`);
  console.log(`  decisions file: ${options.decisionsPath}`);
  console.log(`  target user: ${userId}`);
  if (!options.apply) {
    console.log('  Default mode is dry-run: nothing will be written. Pass --apply to write for real.');
  }

  const progressRows = await prisma.userSeriesProgress.findMany({
    where: { userId, seriesId: { in: rows.map((r) => r.mytvSeriesId) } },
    select: { id: true, seriesId: true, userStatus: true, nextEpisodeId: true },
  });
  const progressBySeriesId = new Map(progressRows.map((p) => [p.seriesId, p]));

  const results: RowResult[] = rows.map((row) => {
    const current = progressBySeriesId.get(row.mytvSeriesId) ?? null;
    const evaluation = evaluateMarkCaughtUpDecision(row, current ? { userStatus: current.userStatus, nextEpisodeId: current.nextEpisodeId } : null);
    return {
      mytvSeriesId: row.mytvSeriesId,
      seriesTitle: row.seriesTitle,
      category: row.category,
      decision: row.decision,
      outcome: evaluation.outcome,
      reason: evaluation.reason,
    };
  });

  const toApply = results.filter((r) => r.outcome === 'would_apply');

  let importBatchId: string | null = null;

  if (options.apply && toApply.length > 0) {
    await prisma.$transaction(async (tx) => {
      const batch = await tx.importBatch.create({ data: { source: BATCH_SOURCE, status: ImportStatus.RUNNING, startedAt: new Date() } });
      importBatchId = batch.id;

      for (const r of toApply) {
        const progress = progressBySeriesId.get(r.mytvSeriesId)!;
        await tx.userSeriesProgress.update({
          where: { id: progress.id },
          data: { nextEpisodeId: null, userStatus: UserSeriesStatus.CAUGHT_UP },
        });
        r.outcome = 'applied';
      }

      await tx.importIssue.createMany({
        data: toApply.map((r) => ({
          importBatchId: batch.id,
          severity: ImportIssueSeverity.INFO,
          relatedEntityType: 'Series',
          relatedEntityId: r.mytvSeriesId,
          message: `Watch Next manual decision applied: "${r.seriesTitle}" marked CAUGHT_UP (was WATCHING) per reviewer decision.`,
        })),
      });

      await tx.importBatch.update({ where: { id: batch.id }, data: { status: ImportStatus.COMPLETED, finishedAt: new Date() } });
    });
  }

  const counts: Record<string, number> = {};
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;

  console.log('\n' + JSON.stringify(counts, null, 2));
  for (const r of results) {
    console.log(`  [${r.outcome}] ${r.seriesTitle} (${r.category}, decision=${r.decision}) — ${r.reason}`);
  }

  mkdirSync(options.outDir, { recursive: true });
  const reportPath = path.join(options.outDir, options.apply ? 'watch-next-decisions-apply-report.json' : 'watch-next-decisions-dry-run-report.json');
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode: options.apply ? 'apply' : 'dry-run',
        writesToAppTables: options.apply,
        importBatchId,
        userId,
        counts,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${reportPath}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
