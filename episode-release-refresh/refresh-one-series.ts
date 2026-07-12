// The single, reusable "run the whole episode-release-refresh pipeline for
// ONE series" function — extracted from run-apply-refresh.ts's per-series
// loop body so the CLI, the automatic sync scheduler
// (src/modules/sync-scheduler/), and any future admin UI all share the
// exact same code path, never a second refresh implementation. Behavior-preserving
// extraction, same convention as library-health/run-provider-confirmation-for-decision.ts's
// own extraction from its pipeline's loop: every classification/plan-building
// call and the apply transaction itself are unchanged from the original
// loop body — only the control flow (continue -> return) and the
// per-iteration local variables (loop-scoped -> function-scoped) changed.
//
// Performs real I/O: one live TMDb fetch, then (only when apply
// authorizes it for this series' resulting classification) one real Prisma
// transaction. Never touches compareSeriesCatalog's algorithm — that stays
// exactly as-is, imported unchanged.

import { PrismaClient, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { MAX_APPEND_TO_RESPONSE_ITEMS, TmdbRequestError } from '../tmdb-enrichment/tmdb-client';
import { getAppendedSeason, TmdbSeason } from '../tmdb-enrichment/tmdb-types';
import { mapTmdbStatusToReleaseStatus } from '../tmdb-enrichment/release-status-mapping';
import { checkSeriesEligibility, chunkArray, compareSeriesCatalog, LocalEpisodeInput, ProviderEpisodeInput } from './refresh-logic';
import { buildEpisodeInsertPlan, previewEpisodeInsertCounts } from './build-episode-insert-plan';
import { applySeriesInsertPlan } from './apply-refresh-transaction';
import { applyProgressReconciliation } from './apply-progress-reconciliation';
import { reconcileSeriesProgress } from './progress-reconciliation-logic';
import { OrderedEpisodeForNextLookup } from '../src/modules/series/series-query-helpers';
import { ApplyProcessedSeriesEntry } from './apply-refresh-reports';
import { ProviderRefreshClient } from './provider-refresh-client';

export interface SeriesRow {
  id: string;
  title: string;
  releaseStatus: ReleaseStatus;
  tmdbId: string | null;
  userStatus: UserSeriesStatus;
  nextEpisodeId: string | null;
  episodes: LocalEpisodeInput[];
}

export interface RefreshOneSeriesInput {
  prisma: PrismaClient;
  tmdb: ProviderRefreshClient;
  userId: string;
  series: SeriesRow;
  apply: boolean;
  now?: Date;
}

export type RefreshOneSeriesOutcome =
  | {
      kind: 'processed';
      entry: ApplyProcessedSeriesEntry;
      // True exactly when apply mode is on AND this call determined
      // something needed writing (a non-empty insert plan, or a real
      // progress mismatch) — regardless of whether the write itself then
      // got skipped at transaction time (e.g. a live-eligibility race).
      // Callers that need "was a write meaningfully attempted for this
      // series" (e.g. the CLI's --only diagnostic report) should use this
      // rather than re-deriving it from entry's fields.
      writeAttempted: boolean;
    }
  | { kind: 'error'; entry: { seriesId: string; seriesTitle: string; message: string } };

function tmdbStillUrl(stillPath: string | null | undefined): string | null {
  return stillPath ? `https://image.tmdb.org/t/p/original${stillPath}` : null;
}

// Identical to run-refresh.ts's fetchProviderEpisodes — see that file for
// the season-batching rationale. Duplicated there rather than imported
// (project convention: small I/O helpers are duplicated per pipeline, not
// cross-imported, so each stays independently readable/runnable) — this
// copy belongs to the apply pipeline specifically (run-apply-refresh.ts and
// the sync scheduler both go through refreshOneSeries, so they share this
// one rather than each having their own).
async function fetchProviderEpisodes(tmdb: ProviderRefreshClient, tmdbId: string, localSeasonNumbers: number[]): Promise<{ episodes: ProviderEpisodeInput[]; releaseStatus: ReleaseStatus }> {
  const details = await tmdb.getShowDetails(tmdbId);
  const releaseStatus = mapTmdbStatusToReleaseStatus(details.status);

  const providerSeasonNumbers = Array.from({ length: details.number_of_seasons ?? 0 }, (_, i) => i + 1);
  const seasonNumbers = [...new Set([...localSeasonNumbers, ...providerSeasonNumbers])].sort((a, b) => a - b);

  const episodes: ProviderEpisodeInput[] = [];
  for (const batch of chunkArray(seasonNumbers, MAX_APPEND_TO_RESPONSE_ITEMS)) {
    const response = await tmdb.getSeasonsBatch(tmdbId, batch);
    for (const seasonNumber of batch) {
      const season: TmdbSeason | undefined = getAppendedSeason(response, seasonNumber);
      if (!season?.episodes) continue;
      for (const ep of season.episodes) {
        episodes.push({
          seasonNumber: ep.season_number,
          episodeNumber: ep.episode_number,
          title: ep.name ?? null,
          overview: ep.overview ?? null,
          airDate: ep.air_date ? new Date(ep.air_date) : null,
          imageUrl: tmdbStillUrl(ep.still_path),
          runtimeMinutes: ep.runtime ?? null,
        });
      }
    }
  }

  return { episodes, releaseStatus };
}

// Caller's responsibility to have already confirmed checkSeriesEligibility
// for this series before calling — this function does not re-check it
// (mirrors run-apply-refresh.ts's original loop, which only ever iterated
// `eligibleSeries`). tmdbId is asserted non-null on that same basis.
export async function refreshOneSeries(input: RefreshOneSeriesInput): Promise<RefreshOneSeriesOutcome> {
  const { prisma, tmdb, userId, series, apply, now } = input;

  try {
    const localSeasonNumbers = [...new Set(series.episodes.map((e) => e.seasonNumber))];
    const { episodes: providerEpisodes, releaseStatus: providerReleaseStatus } = await fetchProviderEpisodes(tmdb, series.tmdbId!, localSeasonNumbers);

    const comparison = compareSeriesCatalog({
      localEpisodes: series.episodes,
      providerEpisodes,
      currentReleaseStatus: series.releaseStatus,
      providerReleaseStatus,
      currentUserStatus: series.userStatus,
      currentNextEpisodeId: series.nextEpisodeId,
      now,
    });

    const insertPlan = buildEpisodeInsertPlan({
      classification: comparison.classification,
      newEpisodes: comparison.newEpisodes,
      providerEpisodes,
      localSeasonNumbers,
    });

    // Always the true "would insert" counts, independent of classification
    // — see build-episode-insert-plan.ts's previewEpisodeInsertCounts doc
    // comment for why this is never used for the actual write decision.
    const preview = previewEpisodeInsertCounts({ newEpisodes: comparison.newEpisodes, providerEpisodes, localSeasonNumbers });

    const baseEntry = {
      seriesId: series.id,
      seriesTitle: series.title,
      tmdbId: series.tmdbId!,
      userStatus: series.userStatus,
      classification: comparison.classification,
      localEpisodeCount: series.episodes.length,
      providerEpisodeCount: providerEpisodes.length,
      seasonsPlanned: preview.seasonNumbers,
      bulkInsertReason: comparison.bulkInsertReason,
      seasonZeroReason: comparison.seasonZeroReason,
      warnings: comparison.warnings,
    };

    if (insertPlan.episodesToInsert.length === 0) {
      // No catalog change — but progress can still be stale (the X-Men '97
      // bug pattern). Computed here from the SAME already-loaded local
      // episode/watch data compareSeriesCatalog just used — no extra DB
      // read needed for this preview, dry-run or not.
      const orderedEpisodes: OrderedEpisodeForNextLookup[] = [...series.episodes]
        .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber)
        .map((e) => ({ id: e.id, airDate: e.airDate, seasonNumber: e.seasonNumber }));
      const watchedEpisodeIds = new Set(series.episodes.filter((e) => e.watched).map((e) => e.id));

      const reconciliation = reconcileSeriesProgress({
        currentUserStatus: series.userStatus,
        currentNextEpisodeId: series.nextEpisodeId,
        orderedEpisodes,
        watchedEpisodeIds,
        releaseStatus: series.releaseStatus,
        now,
      });

      if (reconciliation.kind !== 'changed') {
        const reason = reconciliation.kind === 'unchanged' ? 'computed progress already matches stored progress — no write needed' : reconciliation.reason;
        return {
          kind: 'processed',
          writeAttempted: false,
          entry: {
            ...baseEntry,
            episodesPlanned: preview.episodeCount,
            seasonsCreated: [],
            episodesInserted: 0,
            duplicatesSkipped: 0,
            progressRecomputed: false,
            progressChange: null,
            progressReconciliationSource: 'not-attempted',
            progressSkippedReason: reason,
            writeSkippedReason: null,
          },
        };
      }

      // A real progress mismatch exists despite zero catalog changes.
      // Report it either way; only actually write in apply mode, via
      // applyProgressReconciliation (never touches Season/Episode, re-reads
      // and re-checks everything live inside its own transaction rather
      // than trusting this preview).
      const previewChange = {
        userStatusFrom: reconciliation.from.userStatus,
        userStatusTo: reconciliation.to.userStatus,
        nextEpisodeIdFrom: reconciliation.from.nextEpisodeId,
        nextEpisodeIdTo: reconciliation.to.nextEpisodeId,
      };

      if (!apply) {
        return {
          kind: 'processed',
          writeAttempted: false,
          entry: {
            ...baseEntry,
            episodesPlanned: preview.episodeCount,
            seasonsCreated: [],
            episodesInserted: 0,
            duplicatesSkipped: 0,
            progressRecomputed: false,
            progressChange: previewChange,
            progressReconciliationSource: 'progress-only',
            progressSkippedReason: `dry run — no writes made (${reconciliation.mismatchType})`,
            writeSkippedReason: null,
          },
        };
      }

      const reconcileResult = await applyProgressReconciliation(prisma, { userId, seriesId: series.id });
      return {
        kind: 'processed',
        writeAttempted: true,
        entry: {
          ...baseEntry,
          episodesPlanned: preview.episodeCount,
          seasonsCreated: [],
          episodesInserted: 0,
          duplicatesSkipped: 0,
          progressRecomputed: reconcileResult.progressRecomputed,
          progressChange: reconcileResult.progressChange,
          progressReconciliationSource: 'progress-only',
          progressSkippedReason: reconcileResult.progressSkippedReason,
          writeSkippedReason: reconcileResult.writeSkippedReason,
        },
      };
    }

    if (!apply) {
      return {
        kind: 'processed',
        writeAttempted: false,
        entry: {
          ...baseEntry,
          episodesPlanned: insertPlan.episodesToInsert.length,
          seasonsCreated: [],
          episodesInserted: 0,
          duplicatesSkipped: 0,
          progressRecomputed: false,
          progressChange: null,
          progressReconciliationSource: 'catalog-insert',
          progressSkippedReason: 'dry run — no writes made',
          writeSkippedReason: null,
        },
      };
    }

    const result = await applySeriesInsertPlan(prisma, { userId, seriesId: series.id, insertPlan });

    return {
      kind: 'processed',
      writeAttempted: true,
      entry: {
        ...baseEntry,
        episodesPlanned: insertPlan.episodesToInsert.length,
        seasonsCreated: result.seasonsCreated,
        episodesInserted: result.episodesInserted,
        duplicatesSkipped: result.duplicatesSkipped,
        progressRecomputed: result.progressRecomputed,
        progressChange: result.progressChange,
        progressReconciliationSource: 'catalog-insert',
        progressSkippedReason: result.progressSkippedReason,
        writeSkippedReason: result.writeSkippedReason,
      },
    };
  } catch (err) {
    const message = err instanceof TmdbRequestError ? err.message : (err as Error).message;
    return { kind: 'error', entry: { seriesId: series.id, seriesTitle: series.title, message } };
  }
}

// Re-exported so callers (run-apply-refresh.ts, the sync scheduler) can
// build their own candidate-loading query without re-importing
// checkSeriesEligibility from two different places.
export { checkSeriesEligibility };
