// Applies manual-progress-correction-decisions.json. Default mode is
// dry-run — nothing is written unless --apply is passed. Only ever acts on
// decision === "apply" rows; every other decision value (skip/needs_mapping/
// report_only) is informational only and never triggers a write. Same shape
// as watch-next-review/run-apply-decisions.ts.
//
// For each "apply" row, re-checks the CURRENT UserSeriesProgress + episode
// state (not what the plan said months/minutes ago) — see apply-logic.ts. A
// row only gets touched if userStatus is still WATCHING, nextEpisodeId is
// still null, and every known episode is still watched; anything else is
// skipped as stale/conflicting, never forced.
//
// This only ever writes UserSeriesProgress.userStatus (and clears
// nextEpisodeId, which is already null for every eligible row here). It
// never creates/updates/deletes an Episode, EpisodeWatch, Season, Series, or
// ExternalIds row — no enrichment, no metadata rewrite, no merge.

import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { ImportIssueSeverity, ImportStatus, PrismaClient, UserSeriesStatus } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { CurrentSeriesState, DecisionRow, evaluateMarkCaughtUpApply } from './apply-logic';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');
const DEFAULT_DECISIONS_PATH = path.join(DEFAULT_OUT_DIR, 'manual-progress-correction-decisions.json');
const BATCH_SOURCE = 'manual-progress-corrections-apply-decisions';

interface CliOptions {
  decisionsPath: string;
  userId?: string;
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

interface InputDecisionRow extends DecisionRow {
  seriesId: string;
  seriesTitle: string;
  proposedAction: string;
}

interface RowResult {
  seriesId: string;
  seriesTitle: string;
  proposedAction: string;
  decision: string;
  outcome: string;
  reason: string;
  userStatusChange?: { from: string; to: string };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(options.decisionsPath)) {
    console.error(`Decisions file not found: ${options.decisionsPath}`);
    process.exit(1);
  }

  const rows: InputDecisionRow[] = JSON.parse(readFileSync(options.decisionsPath, 'utf-8'));
  const userId = options.userId ?? DEV_USER_ID;

  const prisma = new PrismaClient();

  console.log(`Manual progress correction decisions apply — mode: ${options.apply ? 'REAL APPLY' : 'DRY RUN (default)'}`);
  console.log(`  decisions file: ${options.decisionsPath}`);
  console.log(`  target user: ${userId}`);
  if (!options.apply) {
    console.log('  Default mode is dry-run: nothing will be written. Pass --apply to write for real.');
  }

  const currentStateBySeriesId = new Map<string, CurrentSeriesState & { progressId: string }>();
  for (const row of rows) {
    const series = await prisma.series.findUnique({ where: { id: row.seriesId } });
    const progress = await prisma.userSeriesProgress.findUnique({
      where: { userId_seriesId: { userId, seriesId: row.seriesId } },
    });
    if (!series || !progress) continue;

    const knownEpisodeCount = await prisma.episode.count({ where: { season: { seriesId: row.seriesId } } });
    const watchedEpisodeCount = await prisma.episodeWatch.count({ where: { userId, episode: { season: { seriesId: row.seriesId } } } });

    currentStateBySeriesId.set(row.seriesId, {
      progressId: progress.id,
      userStatus: progress.userStatus,
      nextEpisodeId: progress.nextEpisodeId,
      watchedEpisodeCount,
      knownEpisodeCount,
      releaseStatus: series.releaseStatus,
    });
  }

  const results: RowResult[] = rows.map((row) => {
    const current = currentStateBySeriesId.get(row.seriesId) ?? null;
    const evaluation = evaluateMarkCaughtUpApply(row, current);
    return {
      seriesId: row.seriesId,
      seriesTitle: row.seriesTitle,
      proposedAction: row.proposedAction,
      decision: row.decision,
      outcome: evaluation.outcome,
      reason: evaluation.reason,
      ...(evaluation.proposedUserStatus && current ? { userStatusChange: { from: current.userStatus, to: evaluation.proposedUserStatus } } : {}),
    };
  });

  const toApply = results.filter((r) => r.outcome === 'would_apply');

  let importBatchId: string | null = null;

  if (options.apply && toApply.length > 0) {
    await prisma.$transaction(async (tx) => {
      const batch = await tx.importBatch.create({ data: { source: BATCH_SOURCE, status: ImportStatus.RUNNING, startedAt: new Date() } });
      importBatchId = batch.id;

      for (const r of toApply) {
        const current = currentStateBySeriesId.get(r.seriesId)!;
        const newStatus = r.userStatusChange!.to as UserSeriesStatus;
        await tx.userSeriesProgress.update({
          where: { id: current.progressId },
          data: { userStatus: newStatus, nextEpisodeId: null },
        });
        r.outcome = 'applied';
      }

      await tx.importIssue.createMany({
        data: toApply.map((r) => ({
          importBatchId: batch.id,
          severity: ImportIssueSeverity.INFO,
          relatedEntityType: 'Series',
          relatedEntityId: r.seriesId,
          message: `Manual progress correction applied: "${r.seriesTitle}" set to ${r.userStatusChange!.to} (was ${r.userStatusChange!.from}) per manual-progress-correction-decisions.json.`,
        })),
      });

      await tx.importBatch.update({ where: { id: batch.id }, data: { status: ImportStatus.COMPLETED, finishedAt: new Date() } });
    });
  }

  const counts: Record<string, number> = {};
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;

  console.log('\n' + JSON.stringify(counts, null, 2));
  for (const r of results) {
    console.log(`  [${r.outcome}] ${r.seriesTitle} (decision=${r.decision}) — ${r.reason}`);
  }

  mkdirSync(options.outDir, { recursive: true });
  const reportPath = path.join(options.outDir, options.apply ? 'manual-progress-correction-apply-report.json' : 'manual-progress-correction-dry-run-report.json');
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode: options.apply ? 'apply' : 'dry-run',
        writesToAppTables: options.apply,
        importBatchId,
        userId,
        note: 'Only ever writes UserSeriesProgress.userStatus (+ nextEpisodeId, already null for every eligible row). Never touches Episode/EpisodeWatch/Season/Series/ExternalIds — no enrichment, no metadata rewrite, no merge.',
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
