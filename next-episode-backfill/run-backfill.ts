// One-time backfill: UserSeriesProgress.nextEpisodeId, for every row this
// backfill is allowed to touch (see derive-next-episode.ts). Reads only
// the current database — never calls TMDb, never touches
// tmdb-enrichment/'s matching/scoring logic, never re-decides which
// candidate a series matched. That decision (ExternalIds.tmdbId, the full
// Season/Episode catalog) is treated as already-settled input here.
//
// Default mode is dry-run. Real writes require --apply.

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { ImportIssueSeverity, ImportStatus, PrismaClient, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { deriveNextEpisodeUpdate, NextEpisodeAction, OrderedEpisode } from './derive-next-episode';

const BATCH_SOURCE = 'next-episode-backfill';
const DEFAULT_OUTPUT_ROOT = path.join(__dirname, 'output');

interface CliOptions {
  userId?: string; // omitted = every user in UserSeriesProgress
  apply: boolean;
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { apply: false, outDir: DEFAULT_OUTPUT_ROOT };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
  }
  return options;
}

interface RowReport {
  progressId: string;
  userId: string;
  seriesId: string;
  seriesTitle: string;
  currentUserStatus: UserSeriesStatus;
  currentNextEpisodeId: string | null;
  releaseStatus: ReleaseStatus;
  hasFullCatalog: boolean;
  action: NextEpisodeAction;
  newNextEpisodeId: string | null;
  newUserStatus: UserSeriesStatus | null;
  changed: boolean;
  reason: string;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  console.log(`Next-episode backfill — mode: ${options.apply ? 'REAL APPLY' : 'DRY RUN (default)'}`);
  console.log(`  target user: ${options.userId ?? 'ALL users'}`);
  if (!options.apply) {
    console.log('  Default mode is dry-run: nothing will be written. Pass --apply to write for real.');
  }

  const progressRows = await prisma.userSeriesProgress.findMany({
    where: options.userId ? { userId: options.userId } : undefined,
    select: { id: true, userId: true, seriesId: true, userStatus: true, nextEpisodeId: true },
  });

  const seriesIds = [...new Set(progressRows.map((p) => p.seriesId))];
  const userIds = [...new Set(progressRows.map((p) => p.userId))];

  const [seriesRows, episodeRows, watchRows] = await Promise.all([
    prisma.series.findMany({
      where: { id: { in: seriesIds } },
      select: { id: true, title: true, releaseStatus: true, externalIds: { select: { tmdbId: true } } },
    }),
    prisma.episode.findMany({
      where: { season: { seriesId: { in: seriesIds } } },
      select: { id: true, episodeNumber: true, airDate: true, season: { select: { seriesId: true, seasonNumber: true } } },
      orderBy: [{ season: { seasonNumber: 'asc' } }, { episodeNumber: 'asc' }],
    }),
    prisma.episodeWatch.findMany({
      where: { userId: { in: userIds }, episode: { season: { seriesId: { in: seriesIds } } } },
      select: { userId: true, episodeId: true },
    }),
  ]);

  const seriesById = new Map(seriesRows.map((s) => [s.id, s]));

  const episodesBySeriesId = new Map<string, OrderedEpisode[]>();
  for (const e of episodeRows) {
    const list = episodesBySeriesId.get(e.season.seriesId) ?? [];
    list.push({ id: e.id, airDate: e.airDate, seasonNumber: e.season.seasonNumber });
    episodesBySeriesId.set(e.season.seriesId, list);
  }

  const watchedEpisodeIdsByUserId = new Map<string, Set<string>>();
  for (const w of watchRows) {
    const set = watchedEpisodeIdsByUserId.get(w.userId) ?? new Set<string>();
    set.add(w.episodeId);
    watchedEpisodeIdsByUserId.set(w.userId, set);
  }

  const rows: RowReport[] = [];
  for (const progress of progressRows) {
    const series = seriesById.get(progress.seriesId);
    if (!series) continue; // orphaned progress row — shouldn't happen, defensively skip rather than crash

    const decision = deriveNextEpisodeUpdate({
      currentUserStatus: progress.userStatus,
      releaseStatus: series.releaseStatus,
      hasFullCatalog: series.externalIds?.tmdbId != null,
      orderedEpisodes: episodesBySeriesId.get(progress.seriesId) ?? [],
      watchedEpisodeIds: watchedEpisodeIdsByUserId.get(progress.userId) ?? new Set(),
    });

    // Only 'set-next-episode'/'mark-caught-up'/'mark-completed' ever
    // propose a real write — 'skip'/'unchanged-incomplete-catalog'/
    // 'no-op-up-to-date' all report nextEpisodeId: null meaning "no change
    // proposed", NOT "set it to null." Diffing that null against whatever
    // happens to already be in the DB (e.g. a DROPPED row that still has a
    // stale nextEpisodeId from before it was dropped) would wrongly mark a
    // row this backfill must never touch as "changed."
    const isActionable = decision.action === 'set-next-episode' || decision.action === 'mark-caught-up' || decision.action === 'mark-completed';
    const changed =
      isActionable && (decision.nextEpisodeId !== progress.nextEpisodeId || (decision.newUserStatus !== null && decision.newUserStatus !== progress.userStatus));

    rows.push({
      progressId: progress.id,
      userId: progress.userId,
      seriesId: progress.seriesId,
      seriesTitle: series.title,
      currentUserStatus: progress.userStatus,
      currentNextEpisodeId: progress.nextEpisodeId,
      releaseStatus: series.releaseStatus,
      hasFullCatalog: series.externalIds?.tmdbId != null,
      action: decision.action,
      newNextEpisodeId: decision.nextEpisodeId,
      newUserStatus: decision.newUserStatus,
      changed,
      reason: decision.reason,
    });
  }

  const counts = {
    progressRowsInspected: rows.length,
    rowsSkippedByUserStatus: rows.filter((r) => r.action === 'skip').length,
    rowsWithNextEpisodeSet: rows.filter((r) => r.action === 'set-next-episode').length,
    // Subset of rowsWithNextEpisodeSet: specifically the CAUGHT_UP rows
    // that found a newly-available episode and therefore moved to
    // WATCHING (docs/status-model-plan.md §4 — caught_up is only valid
    // while nextEpisodeId is null, so this transition is mandatory, not
    // optional, once a next episode is found).
    rowsMovedCaughtUpToWatching: rows.filter((r) => r.action === 'set-next-episode' && r.newUserStatus === UserSeriesStatus.WATCHING).length,
    rowsMovedWatchingToCaughtUp: rows.filter((r) => r.action === 'mark-caught-up').length,
    rowsMovedWatchingToCompleted: rows.filter((r) => r.action === 'mark-completed').length,
    rowsUnchangedIncompleteCatalog: rows.filter((r) => r.action === 'unchanged-incomplete-catalog').length,
    // Bonus, beyond the required counters — CAUGHT_UP rows that were
    // already correct and needed no change at all, tracked separately so
    // every row is accounted for (sum of all buckets === progressRowsInspected).
    rowsAlreadyUpToDate: rows.filter((r) => r.action === 'no-op-up-to-date').length,
    rowsActuallyChanged: rows.filter((r) => r.changed).length,
  };

  console.log('\n' + JSON.stringify(counts, null, 2));

  let importBatchId: string | null = null;

  if (options.apply) {
    const toWrite = rows.filter((r) => r.changed);
    await prisma.$transaction(
      async (tx) => {
        const batch = await tx.importBatch.create({
          data: { source: BATCH_SOURCE, status: ImportStatus.RUNNING, startedAt: new Date() },
        });
        importBatchId = batch.id;

        for (const row of toWrite) {
          await tx.userSeriesProgress.update({
            where: { id: row.progressId },
            data: {
              nextEpisodeId: row.action === 'mark-caught-up' || row.action === 'mark-completed' ? null : row.newNextEpisodeId ?? undefined,
              userStatus: row.newUserStatus ?? undefined,
            },
          });
        }

        const infoRows = rows.filter((r) => r.action === 'unchanged-incomplete-catalog');
        if (infoRows.length > 0) {
          await tx.importIssue.createMany({
            data: infoRows.map((r) => ({
              importBatchId: batch.id,
              severity: ImportIssueSeverity.INFO,
              relatedEntityType: 'Series',
              relatedEntityId: r.seriesId,
              message: `"${r.seriesTitle}": ${r.reason}`,
            })),
          });
        }

        await tx.importBatch.update({ where: { id: batch.id }, data: { status: ImportStatus.COMPLETED, finishedAt: new Date() } });
      },
      { maxWait: 10_000, timeout: 120_000 },
    );
  }

  mkdirSync(options.outDir, { recursive: true });
  const reportFileName = options.apply ? 'next-episode-backfill-report.json' : 'next-episode-backfill-dry-run-report.json';
  const report = {
    generatedAt: new Date().toISOString(),
    mode: options.apply ? 'apply' : 'dry-run',
    writesToAppTables: options.apply,
    importBatchId,
    targetUserId: options.userId ?? null,
    counts,
    rows,
  };
  writeFileSync(path.join(options.outDir, reportFileName), JSON.stringify(report, null, 2));
  console.log(`\nWrote ${path.join(options.outDir, reportFileName)}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
