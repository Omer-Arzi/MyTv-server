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
import { PrismaClient } from '@prisma/client';
import { TmdbClient } from '../tmdb-enrichment/tmdb-client';
import { DEV_USER_ID } from '../src/common/constants';
import { checkSeriesEligibility } from './refresh-logic';
import { filterToOnlySeries } from './only-series-filter';
import { refreshOneSeries, SeriesRow } from './refresh-one-series';
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
    const outcome = await refreshOneSeries({ prisma, tmdb, userId: options.userId, series, apply: options.apply });

    if (outcome.kind === 'error') {
      errors.push(outcome.entry);
      console.log(`  [ERROR] ${outcome.entry.seriesTitle} — ${outcome.entry.message}`);
      continue;
    }

    const { entry, writeAttempted } = outcome;
    processedSeries.push(entry);
    if (writeAttempted && options.only && series.id === options.only) onlyWritesAttempted = true;

    // Console reporting only — every actual decision already happened
    // inside refreshOneSeries; this just narrates entry's fields the same
    // way the original inline loop did per branch.
    if (entry.progressReconciliationSource === 'not-attempted') {
      console.log(
        entry.episodesPlanned > 0
          ? `  [${entry.classification}] ${entry.seriesTitle} — BLOCKED, ${entry.episodesPlanned} episode(s) would have been proposed`
          : `  [${entry.classification}] ${entry.seriesTitle} — nothing to insert, progress up to date (${entry.progressSkippedReason})`,
      );
    } else if (entry.progressReconciliationSource === 'progress-only') {
      if (!options.apply) {
        const c = entry.progressChange!;
        console.log(
          `  [${entry.classification}] ${entry.seriesTitle} — progress reconciliation would change: ` +
            `${c.userStatusFrom}/${c.nextEpisodeIdFrom ?? 'null'} -> ${c.userStatusTo}/${c.nextEpisodeIdTo ?? 'null'}`,
        );
      } else if (entry.writeSkippedReason) {
        console.log(`  [SKIPPED AT WRITE TIME] ${entry.seriesTitle} — ${entry.writeSkippedReason}`);
      } else if (entry.progressRecomputed) {
        console.log(`  [PROGRESS RECONCILED] ${entry.seriesTitle}`);
      } else {
        console.log(`  [${entry.classification}] ${entry.seriesTitle} — progress already up to date at write time`);
      }
    } else if (!options.apply) {
      console.log(`  [${entry.classification}] ${entry.seriesTitle} — would insert ${entry.episodesPlanned} episode(s) (${entry.seasonsPlanned.length} new season(s))`);
    } else if (entry.writeSkippedReason) {
      console.log(`  [SKIPPED AT WRITE TIME] ${entry.seriesTitle} — ${entry.writeSkippedReason}`);
    } else {
      console.log(
        `  [APPLIED] ${entry.seriesTitle} — inserted ${entry.episodesInserted} episode(s), ${entry.seasonsCreated.length} new season(s)${entry.progressRecomputed ? ', progress recomputed' : ''}`,
      );
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
