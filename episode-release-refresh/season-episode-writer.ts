// The one shared Prisma write path for "create missing Season rows, then
// create missing Episode rows" — extracted out of apply-refresh-transaction.ts
// (Phase 1 / ongoing release refresh) so library-health's catalog
// reconciliation pipeline (Phase A / initial migration) can reuse the exact
// same tested, invariant-preserving write mechanics instead of a second,
// possibly-drifting copy. Both callers pass their own `importBatchId` so
// provenance stays distinguishable per pipeline (see
// docs/stable-version-migration-todo.md's Phase 1 baseline audit for why
// that distinction matters for rollback).
//
// This function ONLY creates rows. It never updates or deletes an existing
// Season/Episode, and never touches EpisodeWatch or UserSeriesProgress —
// those stay each caller's own responsibility, since the two pipelines
// resolve status differently (Phase 1: derive-from-next-episode; Phase A:
// objective-derivation-or-preserve, see migration-policy-logic.ts).

import { Prisma } from '@prisma/client';
import { EpisodeInsertPlan } from './build-episode-insert-plan';

export interface CreateMissingSeasonsAndEpisodesInput {
  seriesId: string;
  insertPlan: EpisodeInsertPlan;
  importBatchId: string;
}

export interface CreateMissingSeasonsAndEpisodesResult {
  // Actual DB write results only — a season/episode that already existed
  // by the time this ran (a concurrent writer, or a safe re-run after an
  // earlier partial run) is correctly excluded, never falsely reported.
  seasonsCreated: number[];
  episodesInserted: number;
  duplicatesSkipped: number;
  // The real Episode.id of every row THIS call inserted — additive field
  // (library-health's migration-history recording needs the exact ids to
  // build a rollback plan; episode-release-refresh's own caller is free to
  // keep ignoring it). Empty when episodesInserted is 0.
  episodeIdsInserted: string[];
}

export async function createMissingSeasonsAndEpisodes(
  tx: Prisma.TransactionClient,
  input: CreateMissingSeasonsAndEpisodesInput,
): Promise<CreateMissingSeasonsAndEpisodesResult> {
  // Season resolution — a live read inside this transaction. Never assumes
  // a season is missing just because the caller's pre-transaction snapshot
  // didn't have it, and never assumes one exists for the same reason.
  const neededSeasonNumbers = [...new Set(input.insertPlan.episodesToInsert.map((ep) => ep.seasonNumber))];
  const existingSeasons = await tx.season.findMany({
    where: { seriesId: input.seriesId, seasonNumber: { in: neededSeasonNumbers } },
    select: { id: true, seasonNumber: true },
  });
  const seasonIdByNumber = new Map(existingSeasons.map((s) => [s.seasonNumber, s.id]));
  const seasonNumbersToAttempt = neededSeasonNumbers.filter((n) => !seasonIdByNumber.has(n));

  let seasonsCreated: number[] = [];
  if (seasonNumbersToAttempt.length > 0) {
    // createManyAndReturn (not upsert) so seasonsCreated reflects exactly
    // the rows THIS statement inserted — skipDuplicates means a season
    // concurrently created by another writer in the narrow window since
    // the existence check above is silently omitted from the returned
    // rows, never falsely attributed to this run.
    const createdSeasons = await tx.season.createManyAndReturn({
      data: seasonNumbersToAttempt.map((seasonNumber) => ({ seriesId: input.seriesId, seasonNumber, importBatchId: input.importBatchId })),
      skipDuplicates: true,
    });
    for (const s of createdSeasons) seasonIdByNumber.set(s.seasonNumber, s.id);
    seasonsCreated = createdSeasons.map((s) => s.seasonNumber).sort((a, b) => a - b);

    // If a concurrent writer won the race for one of these season numbers,
    // we still need its id to insert episodes into it — just without
    // claiming credit for creating it.
    const stillMissing = seasonNumbersToAttempt.filter((n) => !seasonIdByNumber.has(n));
    if (stillMissing.length > 0) {
      const raceWinners = await tx.season.findMany({ where: { seriesId: input.seriesId, seasonNumber: { in: stillMissing } }, select: { id: true, seasonNumber: true } });
      for (const s of raceWinners) seasonIdByNumber.set(s.seasonNumber, s.id);
    }
  }

  const createData = input.insertPlan.episodesToInsert.map((ep) => ({
    seasonId: seasonIdByNumber.get(ep.seasonNumber)!,
    episodeNumber: ep.episodeNumber,
    title: ep.title,
    overview: ep.overview,
    airDate: ep.airDate,
    imageUrl: ep.imageUrl,
    runtimeMinutes: ep.runtimeMinutes,
    importBatchId: input.importBatchId,
  }));

  // skipDuplicates turns a (seasonId, episodeNumber) collision into a
  // silently-skipped row via a single INSERT ... ON CONFLICT DO NOTHING —
  // never an update, and never a thrown error that would leave the
  // surrounding Postgres transaction in an aborted state the way a caught
  // per-row create() error would. .count is the exact number of rows this
  // statement actually inserted. createManyAndReturn (not createMany) so
  // callers that need the real inserted ids (e.g. migration-history
  // recording) can have them without a second round-trip query — same
  // skipDuplicates semantics as the season insert above.
  const insertedEpisodes = await tx.episode.createManyAndReturn({ data: createData, skipDuplicates: true, select: { id: true } });
  const episodesInserted = insertedEpisodes.length;
  const duplicatesSkipped = createData.length - episodesInserted;

  return { seasonsCreated, episodesInserted, duplicatesSkipped, episodeIdsInserted: insertedEpisodes.map((e) => e.id) };
}
