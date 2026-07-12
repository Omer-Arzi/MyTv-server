// Episode release refresh — Phase 1 apply mode. Dry-run by default (no
// writes at all — same preview as run-refresh.ts, just scoped to what this
// script would insert); pass --apply-episode-insert to actually write.
//
// Phase 1 scope, deliberately narrow (see docs/episode-release-refresh-strategy.md
// and the Phase 1 investigation report):
//   - creates missing Season rows only as a prerequisite for a new episode
//   - inserts genuinely new, already-released Episode rows only
//   - recomputes UserSeriesProgress.nextEpisodeId/userStatus whenever the
//     locally-known catalog says it's stale — either because episodes were
//     just inserted this run (applySeriesInsertPlan), OR because nothing
//     needed inserting but an already-local, previously-future episode has
//     since become released (applyProgressReconciliation). See
//     docs/progress-reconciliation-architecture-todo.md for why these are
//     two independent concerns, not one gated by the other — a series can
//     need a progress recompute with ZERO catalog inserts.
// Phase 1 never:
//   - updates or deletes an existing Episode row
//   - touches EpisodeWatch/EpisodeNote/EpisodeRating/EpisodeEmotion
//   - applies any of compareSeriesCatalog's fieldChanges (title/overview/
//     airDate/imageUrl/runtimeMinutes corrections on existing episodes)
//   - writes Series.releaseStatus
//
// One Prisma transaction per series; a per-series failure is caught and
// reported without blocking any other series (same isolation convention as
// library-health/run-provider-confirmation-pipeline.ts). Duplicate-episode
// collisions are handled via episode.createMany({ skipDuplicates: true })
// rather than per-row create+catch — a single INSERT ... ON CONFLICT DO
// NOTHING statement can't leave the surrounding transaction in Postgres's
// "aborted, commands ignored until rollback" state the way a caught
// per-row create() error would.

import 'dotenv/config';
import path from 'path';
import { PrismaClient, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { MAX_APPEND_TO_RESPONSE_ITEMS, TmdbClient, TmdbRequestError } from '../tmdb-enrichment/tmdb-client';
import { getAppendedSeason, TmdbSeason } from '../tmdb-enrichment/tmdb-types';
import { mapTmdbStatusToReleaseStatus } from '../tmdb-enrichment/release-status-mapping';
import { DEV_USER_ID } from '../src/common/constants';
import { checkSeriesEligibility, chunkArray, compareSeriesCatalog, LocalEpisodeInput, ProviderEpisodeInput } from './refresh-logic';
import { buildEpisodeInsertPlan, previewEpisodeInsertCounts } from './build-episode-insert-plan';
import { applySeriesInsertPlan } from './apply-refresh-transaction';
import { applyProgressReconciliation } from './apply-progress-reconciliation';
import { reconcileSeriesProgress } from './progress-reconciliation-logic';
import { OrderedEpisodeForNextLookup } from '../src/modules/series/series-query-helpers';
import { filterToOnlySeries } from './only-series-filter';
import {
  ApplyProcessedSeriesEntry,
  ApplySkippedSeriesEntry,
  buildApplyRefreshMarkdownReport,
  buildApplyRefreshReport,
  OnlySeriesReport,
  writeApplyRefreshReports,
} from './apply-refresh-reports';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');
const APPLY_FLAG = '--apply-episode-insert';

interface CliOptions {
  userId: string;
  limit?: number;
  outDir: string;
  apply: boolean;
  only?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { userId: DEV_USER_ID, outDir: DEFAULT_OUT_DIR, apply: argv.includes(APPLY_FLAG) };
  for (const arg of argv) {
    if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice('--limit='.length));
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
    else if (arg.startsWith('--only=')) options.only = arg.slice('--only='.length);
  }
  return options;
}

// Only called when --only was given and filterToOnlySeries came back empty
// — distinguishes "id doesn't exist at all" from "exists but isn't tracked
// by this user" from "tracked by a different user", so the report/console
// message is specific rather than a generic "not found".
async function diagnoseMissingOnlySeries(prisma: PrismaClient, seriesId: string, userId: string): Promise<string> {
  const series = await prisma.series.findUnique({ where: { id: seriesId }, select: { id: true, title: true } });
  if (!series) {
    return `--only=${seriesId}: no Series row with this id exists`;
  }
  const anyProgress = await prisma.userSeriesProgress.findFirst({ where: { seriesId }, select: { userId: true } });
  if (!anyProgress) {
    return `--only=${seriesId}: series "${series.title}" exists but has no UserSeriesProgress row for any user — not tracked at all`;
  }
  if (anyProgress.userId !== userId) {
    return `--only=${seriesId}: series "${series.title}" exists but is tracked by a different user, not ${userId}`;
  }
  return `--only=${seriesId}: series "${series.title}" is tracked by ${userId} but was unexpectedly not found among candidate series`;
}

interface SeriesRow {
  id: string;
  title: string;
  releaseStatus: ReleaseStatus;
  tmdbId: string | null;
  userStatus: UserSeriesStatus;
  nextEpisodeId: string | null;
  episodes: LocalEpisodeInput[];
}

// Same query shape as run-refresh.ts's loadCandidateSeries, duplicated
// rather than imported (project convention — see other run-*.ts scripts:
// small I/O helpers are duplicated per script, not cross-imported, so each
// pipeline stays independently readable/runnable). Deliberately does NOT
// carry season ids — applySeriesInsertPlan re-reads season state live,
// inside its own transaction, rather than trusting this snapshot (which
// can be stale by the time a given series' turn comes up in a long run).
async function loadCandidateSeries(prisma: PrismaClient, userId: string): Promise<SeriesRow[]> {
  const progresses = await prisma.userSeriesProgress.findMany({
    where: { userId },
    select: {
      userStatus: true,
      nextEpisodeId: true,
      series: {
        select: {
          id: true,
          title: true,
          releaseStatus: true,
          externalIds: { select: { tmdbId: true } },
          seasons: {
            select: {
              seasonNumber: true,
              episodes: { select: { id: true, episodeNumber: true, title: true, overview: true, airDate: true, imageUrl: true, runtimeMinutes: true } },
            },
          },
        },
      },
    },
  });

  const seriesIds = progresses.map((p) => p.series.id);
  const watches = await prisma.episodeWatch.findMany({
    where: { userId, episode: { season: { seriesId: { in: seriesIds } } } },
    select: { episodeId: true },
  });
  const watchedEpisodeIds = new Set(watches.map((w) => w.episodeId));

  return progresses.map((p) => ({
    id: p.series.id,
    title: p.series.title,
    releaseStatus: p.series.releaseStatus,
    tmdbId: p.series.externalIds?.tmdbId ?? null,
    userStatus: p.userStatus,
    nextEpisodeId: p.nextEpisodeId,
    episodes: p.series.seasons.flatMap((season) =>
      season.episodes.map((ep) => ({
        id: ep.id,
        seasonNumber: season.seasonNumber,
        episodeNumber: ep.episodeNumber,
        title: ep.title,
        overview: ep.overview,
        airDate: ep.airDate,
        imageUrl: ep.imageUrl,
        runtimeMinutes: ep.runtimeMinutes,
        watched: watchedEpisodeIds.has(ep.id),
      })),
    ),
  }));
}

function tmdbStillUrl(stillPath: string | null | undefined): string | null {
  return stillPath ? `https://image.tmdb.org/t/p/original${stillPath}` : null;
}

// Identical to run-refresh.ts's fetchProviderEpisodes — see that file for
// the season-batching rationale.
async function fetchProviderEpisodes(tmdb: TmdbClient, tmdbId: string, localSeasonNumbers: number[]): Promise<{ episodes: ProviderEpisodeInput[]; releaseStatus: ReleaseStatus }> {
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

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const accessToken = process.env.TMDB_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('Missing TMDB_ACCESS_TOKEN — set it in .env (see .env.example). No request is made without it.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const tmdb = new TmdbClient({ accessToken });
  const generatedAt = new Date();

  console.log(`Episode release refresh — Phase 1 apply — mode: ${options.apply ? 'APPLY (writes will happen)' : 'DRY RUN (no writes)'}`);
  console.log(`  target user: ${options.userId}`);
  console.log(`  series limit: ${options.limit ?? 'unlimited'}`);
  if (options.only) console.log(`  --only: ${options.only}`);

  const allSeries = await loadCandidateSeries(prisma, options.userId);

  // Applied before any eligibility check, TMDb fetch, or plan-building for
  // anyone else — candidateSeries is either exactly the one requested
  // series or, if it wasn't found among this user's candidates at all, an
  // empty list. Never the full allSeries as a fallback (see
  // only-series-filter.ts's own tests for this guarantee in isolation).
  const { candidateSeries, found: onlySeriesFound } = filterToOnlySeries(allSeries, options.only);
  let onlyNotFoundMessage: string | null = null;
  if (options.only && !onlySeriesFound) {
    onlyNotFoundMessage = await diagnoseMissingOnlySeries(prisma, options.only, options.userId);
    console.error(`  [ONLY] ${onlyNotFoundMessage}`);
  }

  const skippedSeries: ApplySkippedSeriesEntry[] = [];
  const eligibleSeries: SeriesRow[] = [];
  for (const series of candidateSeries) {
    const eligibility = checkSeriesEligibility({ userStatus: series.userStatus, tmdbId: series.tmdbId, title: series.title });
    if (!eligibility.eligible) {
      skippedSeries.push({ seriesId: series.id, seriesTitle: series.title, userStatus: series.userStatus, reason: eligibility.reason! });
    } else {
      eligibleSeries.push(series);
    }
  }

  const toInspect = options.limit ? eligibleSeries.slice(0, options.limit) : eligibleSeries;
  console.log(`  eligible series: ${eligibleSeries.length}${options.limit ? ` (inspecting first ${toInspect.length})` : ''}`);
  console.log(`  skipped series: ${skippedSeries.length}`);

  const processedSeries: ApplyProcessedSeriesEntry[] = [];
  const errors: { seriesId: string; seriesTitle: string; message: string }[] = [];
  let onlyWritesAttempted = false;

  for (const series of toInspect) {
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
      });

      const insertPlan = buildEpisodeInsertPlan({
        classification: comparison.classification,
        newEpisodes: comparison.newEpisodes,
        providerEpisodes,
        localSeasonNumbers,
      });

      // Always the true "would insert" counts, independent of
      // classification — unlike insertPlan (which is correctly empty for
      // anything blocked), this is what the report shows so a
      // SUSPICIOUS_BULK_INSERT/RISKY_DO_NOT_APPLY/NEEDS_MANUAL_REVIEW entry
      // doesn't misleadingly show "0 proposed" for a series that actually
      // had, say, 90 released episodes flagged. Never used for the actual
      // write decision below — insertPlan alone gates that.
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
        // No catalog change — but progress can still be stale (the
        // confirmed bug: an already-local, previously-future episode may
        // have become released since the last write, with nothing new to
        // insert either way). Computed here from the SAME already-loaded
        // local episode/watch data compareSeriesCatalog just used — no
        // extra DB read needed for this preview, dry-run or not.
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
        });

        if (reconciliation.kind !== 'changed') {
          const reason = reconciliation.kind === 'unchanged' ? 'computed progress already matches stored progress — no write needed' : reconciliation.reason;
          processedSeries.push({
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
          });
          console.log(
            preview.episodeCount > 0
              ? `  [${comparison.classification}] ${series.title} — BLOCKED, ${preview.episodeCount} episode(s) would have been proposed`
              : `  [${comparison.classification}] ${series.title} — nothing to insert, progress up to date (${reason})`,
          );
          continue;
        }

        // A real progress mismatch exists despite zero catalog changes —
        // this is docs/progress-reconciliation-architecture-todo.md's
        // exact bug case (X-Men '97). Report it either way; only actually
        // write in apply mode, via applyProgressReconciliation (never
        // touches Season/Episode, re-reads and re-checks everything live
        // inside its own transaction rather than trusting this preview).
        const previewChange = {
          userStatusFrom: reconciliation.from.userStatus,
          userStatusTo: reconciliation.to.userStatus,
          nextEpisodeIdFrom: reconciliation.from.nextEpisodeId,
          nextEpisodeIdTo: reconciliation.to.nextEpisodeId,
        };

        if (!options.apply) {
          processedSeries.push({
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
          });
          console.log(
            `  [${comparison.classification}] ${series.title} — progress reconciliation would change: ` +
              `${previewChange.userStatusFrom}/${previewChange.nextEpisodeIdFrom ?? 'null'} -> ${previewChange.userStatusTo}/${previewChange.nextEpisodeIdTo ?? 'null'} (${reconciliation.mismatchType})`,
          );
          continue;
        }

        if (options.only && series.id === options.only) onlyWritesAttempted = true;

        const reconcileResult = await applyProgressReconciliation(prisma, { userId: options.userId, seriesId: series.id });
        processedSeries.push({
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
        });
        if (reconcileResult.writeSkippedReason) {
          console.log(`  [SKIPPED AT WRITE TIME] ${series.title} — ${reconcileResult.writeSkippedReason}`);
        } else if (reconcileResult.progressRecomputed) {
          console.log(`  [PROGRESS RECONCILED] ${series.title} — ${reconciliation.mismatchType}`);
        } else {
          console.log(`  [${comparison.classification}] ${series.title} — progress already up to date at write time`);
        }
        continue;
      }

      if (!options.apply) {
        processedSeries.push({
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
        });
        console.log(`  [${comparison.classification}] ${series.title} — would insert ${insertPlan.episodesToInsert.length} episode(s) (${insertPlan.seasonNumbersToCreate.length} new season(s))`);
        continue;
      }

      if (options.only && series.id === options.only) onlyWritesAttempted = true;

      const result = await applySeriesInsertPlan(prisma, {
        userId: options.userId,
        seriesId: series.id,
        insertPlan,
      });

      processedSeries.push({
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
      });
      if (result.writeSkippedReason) {
        console.log(`  [SKIPPED AT WRITE TIME] ${series.title} — ${result.writeSkippedReason}`);
      } else {
        console.log(
          `  [APPLIED] ${series.title} — inserted ${result.episodesInserted} episode(s), ${result.seasonsCreated.length} new season(s)${result.progressRecomputed ? ', progress recomputed' : ''}`,
        );
      }
    } catch (err) {
      const message = err instanceof TmdbRequestError ? err.message : (err as Error).message;
      errors.push({ seriesId: series.id, seriesTitle: series.title, message });
      console.log(`  [ERROR] ${series.title} — ${message}`);
    }
  }

  let onlySeriesReport: OnlySeriesReport | null = null;
  if (options.only) {
    const skippedEntry = skippedSeries.find((s) => s.seriesId === options.only);
    const processedEntry = processedSeries.find((e) => e.seriesId === options.only);
    onlySeriesReport = {
      requestedOnlySeriesId: options.only,
      found: onlySeriesFound,
      eligible: processedEntry !== undefined,
      finalClassification: processedEntry?.classification ?? null,
      writesAttempted: onlyWritesAttempted,
      message: onlyNotFoundMessage ?? (skippedEntry ? `not eligible: ${skippedEntry.reason}` : null),
    };
  }

  const report = buildApplyRefreshReport({ generatedAt, apply: options.apply, targetUserId: options.userId, onlySeriesReport, skippedSeries, processedSeries, errors });
  const markdown = buildApplyRefreshMarkdownReport(report);
  const written = writeApplyRefreshReports(options.outDir, report, markdown);

  console.log(`\nDone. Reports written:`);
  console.log(`  ${written.latestJsonPath}`);
  console.log(`  ${written.latestMarkdownPath}`);
  console.log(`  ${written.archivedJsonPath}`);
  console.log(`  ${written.archivedMarkdownPath}`);
  console.log('\nSummary:');
  console.log(JSON.stringify(report.summary, null, 2));
  if (report.onlySeriesReport) {
    console.log('\n--only result:');
    console.log(JSON.stringify(report.onlySeriesReport, null, 2));
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
