import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { ImportIssueSeverity, ImportStatus, Prisma, PrismaClient } from '@prisma/client';
import { planSeriesShowIdBackfill } from './backfill-tvtime-show-id';

const BATCH_SOURCE = 'trakt-enrichment-prerequisite';
const DEFAULT_OUT_DIR = path.join(__dirname, 'output');

function extractTvtimeShowId(rawMetadata: Prisma.JsonValue | null): string | null {
  if (!rawMetadata || typeof rawMetadata !== 'object' || Array.isArray(rawMetadata)) return null;
  const value = (rawMetadata as Record<string, unknown>).tvtimeShowId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function main() {
  const outDir = process.argv.includes('--out=')
    ? process.argv.find((a) => a.startsWith('--out='))!.slice('--out='.length)
    : DEFAULT_OUT_DIR;

  const prisma = new PrismaClient();
  const startedAt = new Date();

  console.log('Trakt enrichment prerequisite: backfilling Series.rawMetadata.tvtimeShowId');

  const [allSeries, episodeRows] = await Promise.all([
    prisma.series.findMany({ select: { id: true, title: true, rawMetadata: true } }),
    prisma.episode.findMany({
      select: { rawMetadata: true, season: { select: { seriesId: true } } },
    }),
  ]);

  const currentTvtimeShowIdBySeriesId = new Map<string, string | null>(
    allSeries.map((s) => [s.id, extractTvtimeShowId(s.rawMetadata)]),
  );
  const rawMetadataBySeriesId = new Map<string, Record<string, unknown>>(
    allSeries.map((s) => [s.id, (s.rawMetadata as Record<string, unknown> | null) ?? {}]),
  );
  const titleBySeriesId = new Map(allSeries.map((s) => [s.id, s.title]));

  const episodeShowIdRows = episodeRows.map((e) => ({
    seriesId: e.season.seriesId,
    tvtimeShowId: extractTvtimeShowId(e.rawMetadata),
  }));

  const plan = planSeriesShowIdBackfill(
    allSeries.map((s) => s.id),
    episodeShowIdRows,
    currentTvtimeShowIdBySeriesId,
  );

  const result = await prisma.$transaction(
    async (tx) => {
      const batch = await tx.importBatch.create({
        data: { source: BATCH_SOURCE, status: ImportStatus.RUNNING, startedAt },
      });

      for (const update of plan.updates) {
        await tx.series.update({
          where: { id: update.seriesId },
          data: {
            rawMetadata: {
              ...rawMetadataBySeriesId.get(update.seriesId),
              tvtimeShowId: update.tvtimeShowId,
            } as Prisma.InputJsonValue,
            importBatchId: batch.id,
          },
        });
      }

      if (plan.conflicts.length > 0) {
        await tx.importIssue.createMany({
          data: plan.conflicts.map((conflict) => ({
            importBatchId: batch.id,
            severity: ImportIssueSeverity.WARNING,
            relatedEntityType: 'Series',
            relatedEntityId: conflict.seriesId,
            message: `Series "${titleBySeriesId.get(conflict.seriesId) ?? conflict.seriesId}" has ${
              conflict.distinctTvtimeShowIds.length
            } conflicting tvtimeShowId values across its imported episodes (${conflict.distinctTvtimeShowIds.join(
              ', ',
            )}) — not backfilled automatically, needs manual review`,
          })),
        });
      }

      const finishedAt = new Date();
      await tx.importBatch.update({
        where: { id: batch.id },
        data: { status: ImportStatus.COMPLETED, finishedAt },
      });

      return { batchId: batch.id, finishedAt };
    },
    { timeout: 120_000, maxWait: 15_000 },
  );

  const report = {
    importBatchId: result.batchId,
    source: BATCH_SOURCE,
    startedAt: startedAt.toISOString(),
    finishedAt: result.finishedAt.toISOString(),
    updatedSeriesCount: plan.updates.length,
    alreadyUpToDateCount: plan.alreadyUpToDate.length,
    skippedCount: plan.skipped.length,
    conflictCount: plan.conflicts.length,
    conflicts: plan.conflicts.map((c) => ({
      seriesId: c.seriesId,
      title: titleBySeriesId.get(c.seriesId) ?? null,
      distinctTvtimeShowIds: c.distinctTvtimeShowIds,
    })),
  };

  const batchDir = path.join(outDir, result.batchId);
  mkdirSync(batchDir, { recursive: true });
  writeFileSync(path.join(batchDir, 'backfill-report.json'), JSON.stringify(report, null, 2));

  console.log(`\nDone. Report written to ${path.join(batchDir, 'backfill-report.json')}`);
  console.log(JSON.stringify(report, null, 2));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
