// One-off data backfill accompanying the
// 20260702120541_introduce_release_and_user_series_status migration. The
// migration itself already gets Series.releaseStatus right (every row lands
// on the column default, UNKNOWN, which is the correct value for every
// series here since none has been enriched yet — no further action needed
// for releaseStatus). This script's job is UserSeriesProgress.userStatus,
// which the migration can only default to UNKNOWN, not correctly classify.
//
// Rules implemented here are exactly docs/status-model-plan.md §5:
//   - is_archived (TV Time) = true  -> DROPPED, unconditionally
//   - a known next episode exists   -> WATCHING (true regardless of source)
//   - watched, imported, catalog incomplete -> WATCHING (non-committal
//     placeholder — NOT caught_up/completed, we don't know the full catalog)
//   - watched, organic (not TV-Time-imported), no next episode -> derived
//     from releaseStatus (caught_up vs completed) — safe here because
//     organic/seed data has a real, bounded episode catalog
//   - on the watchlist (WatchlistItem exists, or TV Time is_for_later), no
//     watch activity -> WATCHLIST
//   - nothing else -> UNKNOWN
//
// is_archived/is_for_later aren't stored on any app table today (only
// WatchlistItem.rawMetadata carries isArchived, and only for the subset of
// series that also happen to be on the watchlist) — so this script re-parses
// the already-cached raw TV Time rows via the same parseTrackingV2Rows used
// by the importer itself, rather than re-reading any CSV.

import { ImportIssueSeverity, ImportStatus, PrismaClient, UserSeriesStatus } from '@prisma/client';
import { parseTrackingV2Rows } from '../import-tvtime/parse-tracking-v2';
import { UserSeriesRow } from '../import-tvtime/types';
import { DEV_USER_ID } from '../src/common/constants';
import { decideBackfillUserStatus } from './backfill-status-model-logic';

const BATCH_SOURCE = 'status-model-backfill';
const TRACKING_V2_SOURCE_FILE = 'tracking-prod-records-v2.csv';

async function main() {
  const prisma = new PrismaClient();
  const userId = process.argv.find((a) => a.startsWith('--user='))?.slice('--user='.length) ?? DEV_USER_ID;

  console.log('Status-model backfill: UserSeriesProgress.userStatus');
  console.log(`  target user: ${userId}`);

  // Reuse whichever tvtime-export batch's raw rows are most recent — every
  // batch is a re-import of the same source CSV, so any one of them is a
  // complete, correct source for is_archived/is_for_later per series.
  const latestTvtimeBatch = await prisma.importBatch.findFirst({
    where: { source: 'tvtime-export', status: ImportStatus.COMPLETED },
    orderBy: { startedAt: 'desc' },
  });

  let userSeriesRows: UserSeriesRow[] = [];
  if (latestTvtimeBatch) {
    const rawRows = await prisma.importRawRow.findMany({
      where: { importBatchId: latestTvtimeBatch.id, sourceFile: TRACKING_V2_SOURCE_FILE },
      orderBy: { sourceRowNumber: 'asc' },
    });
    const csvRows = rawRows.map((r) => r.payload as Record<string, string>);
    userSeriesRows = parseTrackingV2Rows(csvRows).userSeriesRows;
  } else {
    console.warn('  no completed tvtime-export ImportBatch found — proceeding with no TV Time signal at all');
  }

  // Last-one-wins per exact series title, matching how findOrCreateSeries
  // resolved the same title during import.
  const tvTimeRowByTitle = new Map<string, UserSeriesRow>();
  for (const row of userSeriesRows) {
    tvTimeRowByTitle.set(row.seriesName, row);
  }

  const [allSeries, allProgress, allWatchlistItems, watchedRows] = await Promise.all([
    prisma.series.findMany({ select: { id: true, title: true, releaseStatus: true, importBatchId: true } }),
    prisma.userSeriesProgress.findMany({ where: { userId } }),
    prisma.watchlistItem.findMany({ where: { userId }, select: { seriesId: true } }),
    prisma.episodeWatch.findMany({
      where: { userId },
      select: { episode: { select: { season: { select: { seriesId: true } } } } },
    }),
  ]);

  const progressBySeriesId = new Map(allProgress.map((p) => [p.seriesId, p]));
  const watchlistSeriesIds = new Set(allWatchlistItems.map((w) => w.seriesId));
  const watchedCountBySeriesId = new Map<string, number>();
  for (const row of watchedRows) {
    const seriesId = row.episode.season.seriesId;
    watchedCountBySeriesId.set(seriesId, (watchedCountBySeriesId.get(seriesId) ?? 0) + 1);
  }

  interface PlannedUpdate {
    seriesId: string;
    existingProgressId: string | null;
    userStatus: UserSeriesStatus;
  }
  const updates: PlannedUpdate[] = [];
  const issues: { severity: ImportIssueSeverity; seriesId: string; message: string }[] = [];

  let droppedCount = 0;
  let watchingCount = 0;
  let watchlistCount = 0;
  let caughtUpCount = 0;
  let completedCount = 0;
  let skippedCount = 0;

  for (const series of allSeries) {
    const existingProgress = progressBySeriesId.get(series.id) ?? null;
    const onWatchlist = watchlistSeriesIds.has(series.id);
    const watchedCount = watchedCountBySeriesId.get(series.id) ?? 0;
    const tvTimeRow = tvTimeRowByTitle.get(series.title) ?? null;

    const decision = decideBackfillUserStatus({
      hasExistingProgressRow: !!existingProgress,
      onWatchlist,
      watchedCount,
      isArchived: tvTimeRow?.isArchived ?? false,
      isForLater: tvTimeRow?.isForLater ?? false,
      hasTvTimeSignal: !!tvTimeRow,
      isImported: series.importBatchId !== null,
      hasKnownNextEpisode: !!existingProgress?.nextEpisodeId,
      releaseStatus: series.releaseStatus,
    });

    if (decision.action === 'skip') {
      skippedCount += 1;
      continue;
    }

    const { userStatus } = decision;
    if (userStatus === UserSeriesStatus.DROPPED) droppedCount += 1;
    else if (userStatus === UserSeriesStatus.WATCHING) watchingCount += 1;
    else if (userStatus === UserSeriesStatus.WATCHLIST) watchlistCount += 1;
    else if (userStatus === UserSeriesStatus.CAUGHT_UP) caughtUpCount += 1;
    else if (userStatus === UserSeriesStatus.COMPLETED) completedCount += 1;

    if (decision.missingTvTimeSignal) {
      issues.push({
        severity: ImportIssueSeverity.INFO,
        seriesId: series.id,
        message: `"${series.title}" was imported and watched, but no matching tracking-prod-records-v2.csv user-series row was found to check is_archived — defaulted to WATCHING (non-committal) rather than guessing`,
      });
    }

    updates.push({ seriesId: series.id, existingProgressId: existingProgress?.id ?? null, userStatus });
  }

  await prisma.$transaction(
    async (tx) => {
      const batch = await tx.importBatch.create({
        data: { source: BATCH_SOURCE, status: ImportStatus.RUNNING, startedAt: new Date() },
      });

      for (const update of updates) {
        if (update.existingProgressId) {
          await tx.userSeriesProgress.update({
            where: { id: update.existingProgressId },
            data: { userStatus: update.userStatus },
          });
        } else {
          await tx.userSeriesProgress.create({
            data: { userId, seriesId: update.seriesId, userStatus: update.userStatus },
          });
        }
      }

      if (issues.length > 0) {
        await tx.importIssue.createMany({
          data: issues.map((i) => ({
            importBatchId: batch.id,
            severity: i.severity,
            relatedEntityType: 'Series',
            relatedEntityId: i.seriesId,
            message: i.message,
          })),
        });
      }

      await tx.importBatch.update({
        where: { id: batch.id },
        data: { status: ImportStatus.COMPLETED, finishedAt: new Date() },
      });
    },
    { timeout: 120_000, maxWait: 15_000 },
  );

  console.log('\nDone.');
  console.log(
    JSON.stringify(
      {
        seriesConsidered: allSeries.length,
        rowsWritten: updates.length,
        skipped: skippedCount,
        byStatus: {
          DROPPED: droppedCount,
          WATCHING: watchingCount,
          WATCHLIST: watchlistCount,
          CAUGHT_UP: caughtUpCount,
          COMPLETED: completedCount,
        },
        infoIssues: issues.length,
      },
      null,
      2,
    ),
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
