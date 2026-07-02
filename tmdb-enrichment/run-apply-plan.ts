import 'dotenv/config';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { TmdbClient } from './tmdb-client';
import { runApplyPlan } from './apply-plan';
import { TmdbApplyPlan } from './apply-plan-types';
import { ArgParseError, parseApplyPlanArgs } from './apply-plan-cli-args';

const DEFAULT_OUTPUT_ROOT = path.join(__dirname, 'output');

// tmdb-apply-plan.json lives at tmdb-enrichment/output/<batchId>/tmdb-apply-plan.json
// (see docs/tmdb-matching-tuning-notes.md's apply-plan turn) — without an
// explicit --plan=, pick whichever batch directory's plan file was written
// most recently, matching how every other script in this session's manual
// inspections found "the latest batch."
function findLatestApplyPlan(outputRoot: string): string {
  if (!existsSync(outputRoot)) {
    throw new Error(`no ${outputRoot} directory — generate a tmdb-apply-plan.json first, or pass --plan <path>`);
  }

  const candidates = readdirSync(outputRoot)
    .map((name) => path.join(outputRoot, name, 'tmdb-apply-plan.json'))
    .filter((p) => existsSync(p));

  if (candidates.length === 0) {
    throw new Error(`no tmdb-apply-plan.json found under ${outputRoot}/*/ — generate one first, or pass --plan=<path>`);
  }

  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0];
}

async function main() {
  const accessToken = process.env.TMDB_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('Missing TMDB_ACCESS_TOKEN — set it in .env. No request is made without it.');
    process.exit(1);
  }

  let options;
  try {
    options = parseApplyPlanArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ArgParseError) {
      console.error(`Argument error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const planPath = options.planPath ?? findLatestApplyPlan(DEFAULT_OUTPUT_ROOT);
  const plan = JSON.parse(readFileSync(planPath, 'utf-8')) as TmdbApplyPlan;
  const outDir = path.dirname(planPath);

  const prisma = new PrismaClient();
  const tmdb = new TmdbClient({ accessToken });

  console.log(`TMDb enrichment apply — mode: ${options.apply ? 'REAL APPLY' : 'DRY RUN (default)'}`);
  console.log(`  plan: ${planPath}`);
  console.log(`  source batch: ${plan.sourceBatchId}`);
  console.log(`  target user: ${options.userId}`);
  console.log(`  safe apply candidates in plan: ${plan.safeApplyCandidates.length}`);
  if (options.seriesIds) console.log(`  restricted to --series=: ${options.seriesIds.join(', ')}`);
  if (!options.apply) {
    console.log('  Default mode is dry-run: nothing will be written. Pass --apply to write for real.');
  }

  let result;
  try {
    result = await runApplyPlan(prisma, tmdb, plan, {
      userId: options.userId,
      apply: options.apply,
      seriesIds: options.seriesIds,
      force: options.force,
    });
  } catch (err) {
    console.error('\nApply plan validation failed — refusing to apply anything:');
    console.error((err as Error).message);
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log(`\nCandidates requested: ${result.candidatesRequested}`);
  console.log(`Ready (TMDb data available): ${result.candidatesReady}`);
  console.log(`Missing TMDb data (skipped): ${result.candidatesMissingData}`);
  console.log(`Written: ${result.candidatesWritten}`);

  if (!options.apply) {
    console.log('\n--- Exactly what would be updated (dry-run) ---');
    for (const p of result.candidatesPlanned) {
      if (p.status === 'missing-tmdb-data') {
        console.log(`\n[SKIP — missing data] ${p.mytvSeriesTitle}: ${p.reason}`);
        continue;
      }
      console.log(`\n${p.mytvSeriesTitle} (tmdbId ${p.tmdbId})`);
      console.log(`  Series.title: ${p.series!.newTitle ? `"${p.series!.currentTitle}" -> "${p.series!.newTitle}" (${p.series!.titleChangeReason})` : `unchanged (${p.series!.titleChangeReason})`}`);
      console.log(`  Series.overview: ${p.series!.overview ? `${p.series!.overview.slice(0, 60)}...` : 'unchanged'}`);
      console.log(`  Series.posterUrl: ${p.series!.posterUrl ?? 'unchanged'}`);
      console.log(`  Series.backdropUrl: ${p.series!.backdropUrl ?? 'unchanged'}`);
      console.log(`  Series.releaseStatus -> ${p.series!.releaseStatus}`);
      console.log(`  ExternalIds.tmdbId -> ${p.externalIds!.tmdbId} (matchSource: ${p.externalIds!.matchSource})`);
      console.log(`  Seasons: ${p.seasons!.length}, Episodes: ${p.episodes!.length}`);
      console.log(`  UserSeriesProgress.userStatus: ${p.userStatus!.shouldUpdate ? `${p.userStatus!.currentLiveStatus} -> ${p.userStatus!.proposedUserStatus}` : `unchanged (${p.userStatus!.reason})`}`);
    }
  }

  const reportFileName = options.apply ? 'tmdb-apply-report.json' : 'tmdb-apply-dry-run-report.json';
  const report = {
    generatedAt: new Date().toISOString(),
    mode: options.apply ? 'apply' : 'dry-run',
    planPath,
    sourceBatchId: plan.sourceBatchId,
    userId: options.userId,
    writesToAppTables: options.apply,
    importBatchId: result.importBatchId,
    summary: {
      candidatesRequested: result.candidatesRequested,
      candidatesReady: result.candidatesReady,
      candidatesMissingData: result.candidatesMissingData,
      candidatesWritten: result.candidatesWritten,
    },
    candidates: result.candidatesPlanned,
  };
  writeFileSync(path.join(outDir, reportFileName), JSON.stringify(report, null, 2));
  console.log(`\nWrote ${path.join(outDir, reportFileName)}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
