import { Prisma, PrismaClient, UserSeriesStatus } from '@prisma/client';
import { groupWatchEvents, parseTrackingV2Rows } from './parse-tracking-v2';
import { EpisodeWatchAggregate, ImportIssueInput, UserSeriesRow, WatchEvent } from './types';

type PrismaTx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

const SOURCE_FILE = 'tracking-prod-records-v2.csv';

export interface NormalizeResult {
  seriesCreated: number;
  seriesReused: number;
  episodeWatchesCreated: number;
  episodeWatchesUpdated: number;
  episodeWatchesSkippedExisting: number;
  watchlistItemsUpserted: number;
  userSeriesProgressUpserted: number;
  issues: ImportIssueInput[];
}

// Phase 2: reads back the raw rows Phase 1 already wrote for
// tracking-prod-records-v2.csv (never re-parses the CSV — see
// docs/mytv-prisma-schema-plan.md §3), and creates/updates Series, Season,
// Episode, EpisodeWatch, WatchlistItem, and UserSeriesProgress for `userId`.
export async function normalizeWatchedEpisodes(
  tx: PrismaTx,
  importBatchId: string,
  userId: string,
): Promise<NormalizeResult> {
  const issues: ImportIssueInput[] = [];

  const rawRows = await tx.importRawRow.findMany({
    where: { importBatchId, sourceFile: SOURCE_FILE },
    orderBy: { sourceRowNumber: 'asc' },
  });

  const csvRows = rawRows.map((r) => r.payload as Record<string, string>);
  const { watchEvents, userSeriesRows, issues: parseIssues } = parseTrackingV2Rows(csvRows);

  for (const issue of parseIssues) {
    issues.push({
      severity: 'WARNING',
      sourceFile: SOURCE_FILE,
      sourceRowNumber: issue.sourceRowNumber,
      message: issue.message,
    });
  }

  // Sanity check from docs/tvtime-data-audit.md §7.4: every row in a
  // single-account export should carry the same TV Time user_id. A stray
  // row with a different id would indicate export corruption — flag and
  // exclude it rather than silently attributing it to the wrong account.
  const expectedTvtimeUserId = mostCommonUserId(watchEvents, userSeriesRows);
  const { events: validEvents, mismatched: mismatchedEvents } = partitionByUserId(watchEvents, expectedTvtimeUserId);
  const { events: validUserSeriesRows, mismatched: mismatchedUserSeries } = partitionByUserId(
    userSeriesRows,
    expectedTvtimeUserId,
  );

  for (const event of [...mismatchedEvents, ...mismatchedUserSeries]) {
    issues.push({
      severity: 'ERROR',
      sourceFile: SOURCE_FILE,
      sourceRowNumber: event.sourceRowNumber,
      message: `row's tvtime user_id (${event.tvtimeUserId}) does not match the expected account id (${expectedTvtimeUserId}) — excluded from import`,
    });
  }

  const aggregates = groupWatchEvents(validEvents);

  const seriesIdCache = new Map<string, string>();
  let seriesCreated = 0;
  let seriesReused = 0;

  async function findOrCreateSeries(title: string): Promise<string> {
    const cached = seriesIdCache.get(title);
    if (cached) return cached;

    const existing = await tx.series.findFirst({ where: { title } });
    if (existing) {
      seriesReused += 1;
      seriesIdCache.set(title, existing.id);
      return existing.id;
    }

    const created = await tx.series.create({
      data: { title, rawMetadata: {}, importBatchId },
    });
    seriesCreated += 1;
    seriesIdCache.set(title, created.id);
    return created.id;
  }

  let episodeWatchesCreated = 0;
  let episodeWatchesUpdated = 0;
  let episodeWatchesSkippedExisting = 0;

  // series -> latest watchedAt seen, used to compute UserSeriesProgress below
  // without a second pass over the DB.
  const seriesLastWatchedAt = new Map<string, Date>();
  const seriesIdsWithWatches = new Set<string>();

  // A show's episodes all share a handful of seasons, so without this cache
  // every episode re-queries the same season row — for a library-sized
  // export (tens of thousands of watch events) that's the difference
  // between a run that finishes in seconds and one that times out.
  const seasonIdCache = new Map<string, string>();

  async function findOrCreateSeason(seriesId: string, seasonNumber: number): Promise<string> {
    const cacheKey = `${seriesId}:${seasonNumber}`;
    const cached = seasonIdCache.get(cacheKey);
    if (cached) return cached;

    const season = await tx.season.upsert({
      where: { seriesId_seasonNumber: { seriesId, seasonNumber } },
      create: { seriesId, seasonNumber },
      update: {},
    });
    seasonIdCache.set(cacheKey, season.id);
    return season.id;
  }

  for (const aggregate of aggregates) {
    const seriesId = await findOrCreateSeries(aggregate.seriesName);
    seriesIdsWithWatches.add(seriesId);

    const seasonId = await findOrCreateSeason(seriesId, aggregate.seasonNumber);

    const episode = await upsertEpisode(tx, seasonId, aggregate, importBatchId);

    const watchResult = await upsertEpisodeWatch(tx, userId, episode.id, aggregate, importBatchId);
    if (watchResult.outcome === 'created') episodeWatchesCreated += 1;
    if (watchResult.outcome === 'updated') episodeWatchesUpdated += 1;
    if (watchResult.outcome === 'skipped-organic') {
      episodeWatchesSkippedExisting += 1;
      issues.push({
        severity: 'INFO',
        relatedEntityType: 'EpisodeWatch',
        relatedEntityId: watchResult.watchId,
        message: `existing EpisodeWatch for episode ${aggregate.seriesName} S${aggregate.seasonNumber}E${aggregate.episodeNumber} was not created by an import — left untouched rather than overwritten`,
      });
    }

    await tx.importRawRow.updateMany({
      where: { importBatchId, sourceFile: SOURCE_FILE, sourceRowNumber: { in: aggregate.contributingRowNumbers } },
      data: { resolvedEntityType: 'EpisodeWatch', resolvedEntityId: watchResult.watchId, processedAt: new Date() },
    });

    const current = seriesLastWatchedAt.get(seriesId);
    if (!current || aggregate.watchedAt > current) {
      seriesLastWatchedAt.set(seriesId, aggregate.watchedAt);
    }
  }

  // Cross-check TV Time's own per-series watched-episode count against what
  // we actually imported, per docs/tvtime-data-audit.md §7.4. Mismatches are
  // expected in some cases (TV Time counts rewatches/specials differently)
  // so this is a WARNING, not an ERROR — a prompt to look, not a failure.
  const importedEpisodeCountBySeries = new Map<string, number>();
  for (const aggregate of aggregates) {
    const key = aggregate.seriesName;
    importedEpisodeCountBySeries.set(key, (importedEpisodeCountBySeries.get(key) ?? 0) + 1);
  }

  let watchlistItemsUpserted = 0;

  // Tracked across all user-series rows (not just isForLater ones) so the
  // UserSeriesProgress pass below can apply "is_archived -> DROPPED" and
  // "is_for_later, never watched -> WATCHLIST" per docs/status-model-plan.md
  // §5, regardless of which signal a given series happened to carry.
  const isArchivedBySeriesId = new Map<string, boolean>();
  const isForLaterBySeriesId = new Map<string, boolean>();

  for (const row of validUserSeriesRows) {
    const seriesId = await findOrCreateSeries(row.seriesName);
    isArchivedBySeriesId.set(seriesId, row.isArchived);
    isForLaterBySeriesId.set(seriesId, row.isForLater);
    let resolvedEntityType: string | undefined;
    let resolvedEntityId: string | undefined;

    if (row.isForLater) {
      const watchlistItem = await tx.watchlistItem.upsert({
        where: { userId_seriesId: { userId, seriesId } },
        create: {
          userId,
          seriesId,
          addedAt: row.followedAt ?? row.updatedAt ?? new Date(),
          rawMetadata: {
            tvtimeShowId: row.tvtimeShowId,
            isFollowed: row.isFollowed,
            isArchived: row.isArchived,
            epWatchCount: row.epWatchCount,
            sourceFile: SOURCE_FILE,
          } as Prisma.InputJsonValue,
          importBatchId,
        },
        update: {
          rawMetadata: {
            tvtimeShowId: row.tvtimeShowId,
            isFollowed: row.isFollowed,
            isArchived: row.isArchived,
            epWatchCount: row.epWatchCount,
            sourceFile: SOURCE_FILE,
          } as Prisma.InputJsonValue,
          importBatchId,
        },
      });
      watchlistItemsUpserted += 1;
      resolvedEntityType = 'WatchlistItem';
      resolvedEntityId = watchlistItem.id;
    }

    if (row.epWatchCount !== null) {
      const imported = importedEpisodeCountBySeries.get(row.seriesName) ?? 0;
      if (imported !== row.epWatchCount) {
        issues.push({
          severity: 'WARNING',
          sourceFile: SOURCE_FILE,
          sourceRowNumber: row.sourceRowNumber,
          relatedEntityType: 'Series',
          relatedEntityId: seriesId,
          message: `TV Time reports ep_watch_count=${row.epWatchCount} for "${row.seriesName}" but the importer created EpisodeWatch rows for ${imported} distinct episodes — worth a manual look`,
        });
      }
    }

    await tx.importRawRow.updateMany({
      where: { importBatchId, sourceFile: SOURCE_FILE, sourceRowNumber: row.sourceRowNumber },
      data: { resolvedEntityType, resolvedEntityId, processedAt: new Date() },
    });
  }

  // UserSeriesProgress.nextEpisodeId is deliberately left null for every
  // imported series: TV Time only tells us about episodes the user
  // interacted with, not a show's full episode catalog, so "next episode"
  // is unknowable until a future Trakt/TMDb enrichment pass provides the
  // full episode list. See docs/mytv-prisma-schema-plan.md §6.
  //
  // userStatus follows docs/status-model-plan.md §5 exactly:
  //   - is_archived=true                          -> DROPPED, always
  //   - watched, no full catalog yet               -> WATCHING (placeholder,
  //     never CAUGHT_UP/COMPLETED — we don't know if more episodes exist)
  //   - never watched, is_for_later=true            -> WATCHLIST
  // A row that already carries a "protected" status this importer itself
  // wouldn't have set (PAUSED/CAUGHT_UP/COMPLETED — only the live app sets
  // those) is left untouched unless is_archived now says otherwise, so a
  // re-import can never quietly undo real personal-status decisions.
  const seriesIdsNeedingProgress = new Set<string>([
    ...seriesIdsWithWatches,
    ...[...isForLaterBySeriesId.entries()].filter(([, isForLater]) => isForLater).map(([seriesId]) => seriesId),
  ]);

  let userSeriesProgressUpserted = 0;
  for (const seriesId of seriesIdsNeedingProgress) {
    const lastWatchedAt = seriesLastWatchedAt.get(seriesId) ?? null;
    const isArchived = isArchivedBySeriesId.get(seriesId) ?? false;
    const hasWatches = seriesIdsWithWatches.has(seriesId);

    // Anything reaching this loop without watches got here via
    // isForLaterBySeriesId (see seriesIdsNeedingProgress above), so
    // "not archived, no watches" implies WATCHLIST by construction.
    const desiredStatus = isArchived
      ? UserSeriesStatus.DROPPED
      : hasWatches
        ? UserSeriesStatus.WATCHING
        : UserSeriesStatus.WATCHLIST;

    const existing = await tx.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId, seriesId } } });
    const protectedStatuses: UserSeriesStatus[] = [UserSeriesStatus.PAUSED, UserSeriesStatus.CAUGHT_UP, UserSeriesStatus.COMPLETED];
    const isProtectedExistingStatus = !!existing && protectedStatuses.includes(existing.userStatus);

    await tx.userSeriesProgress.upsert({
      where: { userId_seriesId: { userId, seriesId } },
      create: { userId, seriesId, userStatus: desiredStatus, lastWatchedAt, nextEpisodeId: null },
      update: {
        lastWatchedAt:
          lastWatchedAt && (!existing?.lastWatchedAt || lastWatchedAt > existing.lastWatchedAt) ? lastWatchedAt : undefined,
        userStatus: isArchived ? UserSeriesStatus.DROPPED : isProtectedExistingStatus ? undefined : desiredStatus,
      },
    });
    userSeriesProgressUpserted += 1;
  }

  return {
    seriesCreated,
    seriesReused,
    episodeWatchesCreated,
    episodeWatchesUpdated,
    episodeWatchesSkippedExisting,
    watchlistItemsUpserted,
    userSeriesProgressUpserted,
    issues,
  };
}

function mostCommonUserId(events: WatchEvent[], userSeriesRows: UserSeriesRow[]): string | null {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.tvtimeUserId, (counts.get(e.tvtimeUserId) ?? 0) + 1);
  for (const r of userSeriesRows) counts.set(r.tvtimeUserId, (counts.get(r.tvtimeUserId) ?? 0) + 1);

  let best: string | null = null;
  let bestCount = -1;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

function partitionByUserId<T extends { tvtimeUserId: string; sourceRowNumber: number }>(
  items: T[],
  expected: string | null,
): { events: T[]; mismatched: T[] } {
  if (!expected) return { events: items, mismatched: [] };
  const events: T[] = [];
  const mismatched: T[] = [];
  for (const item of items) {
    if (item.tvtimeUserId === expected) events.push(item);
    else mismatched.push(item);
  }
  return { events, mismatched };
}

async function upsertEpisode(
  tx: PrismaTx,
  seasonId: string,
  aggregate: EpisodeWatchAggregate,
  importBatchId: string,
) {
  const existing = await tx.episode.findUnique({
    where: { seasonId_episodeNumber: { seasonId, episodeNumber: aggregate.episodeNumber } },
  });

  if (!existing) {
    return tx.episode.create({
      data: {
        seasonId,
        episodeNumber: aggregate.episodeNumber,
        title: null,
        runtimeMinutes: aggregate.runtimeMinutes,
        rawMetadata: { tvtimeEpisodeId: aggregate.tvtimeEpisodeId, tvtimeShowId: aggregate.tvtimeShowId } as Prisma.InputJsonValue,
        importBatchId,
      },
    });
  }

  // Don't clobber real metadata (e.g. a future Trakt-enriched title/runtime)
  // with import data — only fill in what's currently missing.
  return tx.episode.update({
    where: { id: existing.id },
    data: {
      runtimeMinutes: existing.runtimeMinutes ?? aggregate.runtimeMinutes,
      rawMetadata: existing.rawMetadata ?? ({ tvtimeEpisodeId: aggregate.tvtimeEpisodeId, tvtimeShowId: aggregate.tvtimeShowId } as Prisma.InputJsonValue),
    },
  });
}

type WatchUpsertOutcome = { outcome: 'created' | 'updated' | 'skipped-organic'; watchId: string };

async function upsertEpisodeWatch(
  tx: PrismaTx,
  userId: string,
  episodeId: string,
  aggregate: EpisodeWatchAggregate,
  importBatchId: string,
): Promise<WatchUpsertOutcome> {
  const existing = await tx.episodeWatch.findUnique({ where: { userId_episodeId: { userId, episodeId } } });

  const rawMetadata = {
    tvtimeShowId: aggregate.tvtimeShowId,
    tvtimeEpisodeId: aggregate.tvtimeEpisodeId,
    seriesName: aggregate.seriesName,
    sourceFile: SOURCE_FILE,
    contributingRowNumbers: aggregate.contributingRowNumbers,
  } as Prisma.InputJsonValue;

  if (!existing) {
    const created = await tx.episodeWatch.create({
      data: {
        userId,
        episodeId,
        watchedAt: aggregate.watchedAt,
        watchDateApproximate: aggregate.watchDateApproximate,
        rewatchCount: aggregate.rewatchCount,
        rawMetadata,
        importBatchId,
      },
    });
    return { outcome: 'created', watchId: created.id };
  }

  // Organic (non-imported) data always wins — never silently overwrite a
  // watch the app itself created.
  if (!existing.importBatchId) {
    return { outcome: 'skipped-organic', watchId: existing.id };
  }

  const updated = await tx.episodeWatch.update({
    where: { id: existing.id },
    data: {
      watchedAt: aggregate.watchedAt,
      watchDateApproximate: aggregate.watchDateApproximate,
      rewatchCount: aggregate.rewatchCount,
      rawMetadata,
      importBatchId,
    },
  });
  return { outcome: 'updated', watchId: updated.id };
}
