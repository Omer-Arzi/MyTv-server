// The actual Prisma writes for Phase 1 apply, isolated from run-apply-refresh.ts's
// TMDb-fetching/CLI orchestration so this one function — the only place
// this pipeline ever writes to the database — can be exercised directly
// against a real (throwaway) Postgres database in an integration test,
// without a live TMDb call anywhere near it.
//
// One transaction per call, matching library-health/run-provider-confirmation-pipeline.ts's
// isolation convention: the caller wraps one invocation per series in its
// own try/catch, so one series' failure never affects another's.
//
// Everything this transaction reads about the series/user's current state
// (progress, seasons, series) is read live, inside the transaction — never
// trusted from whatever the caller's pre-transaction candidate snapshot
// said. That snapshot can be stale by the time this specific series' turn
// comes up in a long, sequential, multi-series run.

import { PrismaClient, UserSeriesStatus } from '@prisma/client';
import { deriveActiveProgress, OrderedEpisodeForNextLookup } from '../src/modules/series/series-query-helpers';
import { checkLiveWriteEligibility, decideProgressRecompute } from './apply-refresh-writes';
import { EpisodeInsertPlan } from './build-episode-insert-plan';
import { hasProgressChanged } from './progress-reconciliation-logic';
import { createMissingSeasonsAndEpisodes } from './season-episode-writer';

export const PHASE1_APPLY_IMPORT_BATCH_ID = 'episode-release-refresh:phase1-apply';

export interface ApplyProgressChange {
  userStatusFrom: UserSeriesStatus;
  userStatusTo: UserSeriesStatus;
  nextEpisodeIdFrom: string | null;
  nextEpisodeIdTo: string | null;
}

export interface ApplySeriesInsertPlanInput {
  userId: string;
  seriesId: string;
  insertPlan: EpisodeInsertPlan;
}

export interface ApplySeriesInsertResult {
  // Actual DB write results only — never a pre-transaction guess. A
  // season/episode that already existed by the time this transaction ran
  // (a concurrent writer, or a safe re-run after an earlier partial run)
  // is correctly excluded from these counts/lists, not falsely reported.
  seasonsCreated: number[];
  episodesInserted: number;
  duplicatesSkipped: number;
  progressRecomputed: boolean;
  progressChange: ApplyProgressChange | null;
  // Populated when episodes WERE inserted but progress specifically was
  // not recomputed (e.g. zero actually inserted, or a status race).
  progressSkippedReason: string | null;
  // Populated when NOTHING was written at all this call — the live
  // eligibility gate failed before any Season/Episode/Progress write was
  // attempted. Mutually exclusive with every other field being non-empty.
  writeSkippedReason: string | null;
}

// Never call this with an empty insertPlan.episodesToInsert — the caller
// (run-apply-refresh.ts) only invokes this once it already knows there's
// something to write; an empty plan here would just open and commit a
// transaction that touches nothing.
export async function applySeriesInsertPlan(prisma: PrismaClient, input: ApplySeriesInsertPlanInput): Promise<ApplySeriesInsertResult> {
  return prisma.$transaction(async (tx) => {
    // --- Live eligibility gate — guards EVERY write below (season,
    // episode, and progress), not only the progress recompute. This is
    // the first thing the transaction does, before touching Season or
    // Episode at all. ---
    const liveProgress = await tx.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId: input.userId, seriesId: input.seriesId } } });
    const eligibility = checkLiveWriteEligibility(liveProgress);
    if (!eligibility.eligible || !liveProgress) {
      return {
        seasonsCreated: [],
        episodesInserted: 0,
        duplicatesSkipped: 0,
        progressRecomputed: false,
        progressChange: null,
        progressSkippedReason: null,
        writeSkippedReason: eligibility.reason ?? 'no UserSeriesProgress row found for this user/series at write time — skipped without writing anything',
      };
    }
    const liveUserStatus = liveProgress.userStatus;

    // Shared with library-health's catalog-reconciliation pipeline — see
    // season-episode-writer.ts. Only ever creates rows, never updates or
    // deletes; never touches EpisodeWatch/UserSeriesProgress.
    const { seasonsCreated, episodesInserted, duplicatesSkipped } = await createMissingSeasonsAndEpisodes(tx, {
      seriesId: input.seriesId,
      insertPlan: input.insertPlan,
      importBatchId: PHASE1_APPLY_IMPORT_BATCH_ID,
    });

    const recomputeDecision = decideProgressRecompute(episodesInserted, liveUserStatus);
    if (!recomputeDecision.shouldRecompute) {
      return {
        seasonsCreated,
        episodesInserted,
        duplicatesSkipped,
        progressRecomputed: false,
        progressChange: null,
        progressSkippedReason: recomputeDecision.reason,
        writeSkippedReason: null,
      };
    }

    const allEpisodes = await tx.episode.findMany({
      where: { season: { seriesId: input.seriesId } },
      select: { id: true, episodeNumber: true, airDate: true, season: { select: { seasonNumber: true } } },
    });
    allEpisodes.sort((a, b) => a.season.seasonNumber - b.season.seasonNumber || a.episodeNumber - b.episodeNumber);

    const watches = await tx.episodeWatch.findMany({
      where: { userId: input.userId, episode: { season: { seriesId: input.seriesId } } },
      select: { episodeId: true },
    });
    const watchedEpisodeIds = new Set(watches.map((w) => w.episodeId));

    const orderedForLookup: OrderedEpisodeForNextLookup[] = allEpisodes.map((e) => ({ id: e.id, airDate: e.airDate, seasonNumber: e.season.seasonNumber }));

    // Same contract deriveActiveProgress's releaseStatus input always has
    // (markWatched, watch-all, progress-reconciliation-logic.ts): local
    // Series.releaseStatus, never a live-fetched provider value. Phase 1
    // never writes Series.releaseStatus, so this is exactly the value
    // already on file.
    const liveSeries = await tx.series.findUnique({ where: { id: input.seriesId }, select: { releaseStatus: true } });
    if (!liveSeries) {
      // Defensive only: Series -> UserSeriesProgress cascades on delete
      // (see schema.prisma), and liveProgress was already confirmed
      // non-null above in this same transaction, so this should not be
      // reachable today. Skip cleanly rather than throw if it ever is.
      return {
        seasonsCreated,
        episodesInserted,
        duplicatesSkipped,
        progressRecomputed: false,
        progressChange: null,
        progressSkippedReason: 'series row not found at recompute time — progress left untouched',
        writeSkippedReason: null,
      };
    }

    const computed = deriveActiveProgress({ orderedEpisodes: orderedForLookup, watchedEpisodeIds, releaseStatus: liveSeries.releaseStatus });
    const from = { userStatus: liveUserStatus, nextEpisodeId: liveProgress.nextEpisodeId };

    // Episodes WERE inserted (that's how we got here), but the recomputed
    // progress can still land on exactly what was already stored — e.g.
    // every newly-inserted episode is still in the future, so
    // nextEpisodeId stays null and userStatus stays CAUGHT_UP either way.
    // Skip the write in that case rather than issuing a no-op update() that
    // would only bump updatedAt for no real change (docs/progress-reconciliation-architecture-todo.md
    // Phase 5) — reuses the exact same comparison
    // apply-progress-reconciliation.ts uses for its own write, via the
    // shared hasProgressChanged helper.
    if (!hasProgressChanged(from, computed)) {
      return {
        seasonsCreated,
        episodesInserted,
        duplicatesSkipped,
        progressRecomputed: false,
        progressChange: null,
        progressSkippedReason: 'episodes were inserted, but recomputed progress already matches what was stored — no write needed',
        writeSkippedReason: null,
      };
    }

    await tx.userSeriesProgress.update({
      where: { userId_seriesId: { userId: input.userId, seriesId: input.seriesId } },
      data: { userStatus: computed.userStatus, nextEpisodeId: computed.nextEpisodeId },
    });

    const progressChange: ApplyProgressChange = {
      userStatusFrom: from.userStatus,
      userStatusTo: computed.userStatus,
      nextEpisodeIdFrom: from.nextEpisodeId,
      nextEpisodeIdTo: computed.nextEpisodeId,
    };

    return { seasonsCreated, episodesInserted, duplicatesSkipped, progressRecomputed: true, progressChange, progressSkippedReason: null, writeSkippedReason: null };
  });
}
