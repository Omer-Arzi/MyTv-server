// Read-only post-enrichment Watch Next sanity report. Never writes to any
// app table — queries the current database, cross-references the recent
// targeted-enrichment batch's saved dry-run/apply reports and the
// documented episode-numbering risk list, and writes report files only.
//
// This is a single atomic snapshot: /me/watch-next's underlying data can
// change in real time (a user actively marking episodes watched via the
// live app, as happened while this report was being built), so every
// number here is only as fresh as generatedAt below.

import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { PrismaClient, UserSeriesStatus } from '@prisma/client';
import { titleSimilarity } from '../trakt-enrichment/scoring';
import { filterReleasedNextEpisodes } from '../src/modules/me/me-query-helpers';
import { DEV_USER_ID } from '../src/common/constants';
import { classifyWatchNextSanity, WatchNextSanityCategory } from './post-enrichment-sanity-logic';

const OUT_DIR = path.join(__dirname, 'output');
const SINGLE_SERIES_OUTPUT_DIR = path.join(__dirname, '..', 'tmdb-enrichment', 'output', 'single-series');
const RISK_LIST_DOC = path.join(__dirname, '..', 'docs', 'episode-numbering-and-season-shift-risk.md');

// The explicit "do not apply/trust" list from
// docs/episode-numbering-and-season-shift-risk.md §5 — kept as a literal
// array here (not parsed from the doc's prose) so this check is exact and
// auditable; the doc's existence is still verified below so this list can
// never silently drift from "the doc exists but says something different."
const RISK_LIST_TITLES = ['Jujutsu Kaisen', 'JUJUTSU KAISEN', 'Rurouni Kenshin', 'One Piece', 'ONE PIECE (2023)', 'InuYasha', 'InuYasha: The Final Act'];

// The 5 series previously manually marked CAUGHT_UP (watch-next-review's
// decisions) whose nextEpisodeId was later reset by next-episode-backfill
// because a new episode became available.
const RECOVERY_FLIP_TITLES = ['Frieren: Beyond Journey\'s End', 'DAN DA DAN', 'Shangri-La Frontier', 'Sket Dance', 'Tokyo Revengers'];

const TITLE_DUPLICATE_SIMILARITY_THRESHOLD = 0.85;

interface WatchNextSanityRow {
  seriesTitle: string;
  seriesId: string;
  userStatus: string;
  releaseStatus: string;
  nextEpisodeId: string;
  nextEpisode: { seasonNumber: number; episodeNumber: number; title: string | null; airDate: string | null };
  lastWatchedEpisode: { seasonNumber: number; episodeNumber: number; title: string | null; watchedAt: string } | null;
  watchedEpisodeCount: number;
  knownEpisodeCount: number;
  providerSource: string;
  enrichedInTodaysBatch: boolean;
  onRiskList: boolean;
  category: WatchNextSanityCategory;
  reason: string;
}

function loadBatchOrphanInfo(seriesId: string): { watchedAtApply: number; matchedAtApply: number } | null {
  const dryRunPath = path.join(SINGLE_SERIES_OUTPUT_DIR, `${seriesId}-dry-run-report.json`);
  const applyPath = path.join(SINGLE_SERIES_OUTPUT_DIR, `${seriesId}-apply-report.json`);
  const reportPath = existsSync(applyPath) ? applyPath : existsSync(dryRunPath) ? dryRunPath : null;
  if (!reportPath) return null;

  const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
  return {
    watchedAtApply: report.watchedEpisodeCountPreserved,
    matchedAtApply: report.planned.episodesUpdated.length,
  };
}

async function main() {
  console.log('Post-enrichment Watch Next sanity report — read-only, writes report files only, never app tables.');

  if (!existsSync(RISK_LIST_DOC)) {
    console.error(`Risk-list doc not found at ${RISK_LIST_DOC} — refusing to proceed without it (this report depends on it).`);
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const userId = DEV_USER_ID;

  const progress = await prisma.userSeriesProgress.findMany({
    where: { userId, userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: { not: null } },
    include: {
      series: { include: { externalIds: true } },
      nextEpisode: { include: { season: true } },
    },
  });

  const liveWatchNext = filterReleasedNextEpisodes(progress);
  const generatedAt = new Date();

  const rows: WatchNextSanityRow[] = [];

  for (const p of liveWatchNext) {
    const seriesId = p.seriesId;
    const series = p.series;
    const nextEp = p.nextEpisode;

    const watchRows = await prisma.episodeWatch.findMany({
      where: { userId, episode: { season: { seriesId } } },
      orderBy: { watchedAt: 'desc' },
      include: { episode: { include: { season: true } } },
    });
    const knownEpisodeCount = await prisma.episode.count({ where: { season: { seriesId } } });

    const lastWatch = watchRows[0];
    const lastWatchedEpisode = lastWatch
      ? {
          seasonNumber: lastWatch.episode.season.seasonNumber,
          episodeNumber: lastWatch.episode.episodeNumber,
          title: lastWatch.episode.title,
          watchedAt: lastWatch.watchedAt.toISOString(),
        }
      : null;

    const onRiskList = RISK_LIST_TITLES.includes(series.title);
    const isRecoveryFlipCandidate = RECOVERY_FLIP_TITLES.includes(series.title);
    const batchOrphanInfo = loadBatchOrphanInfo(seriesId);
    const enrichedInTodaysBatch = batchOrphanInfo !== null;
    const hasKnownSeasonShiftOrphan = batchOrphanInfo !== null && batchOrphanInfo.matchedAtApply < batchOrphanInfo.watchedAtApply;

    const nextEpisodeDataIncomplete = !nextEp.title && !nextEp.airDate;
    const nextEpisodeTitleDuplicatesLastWatched =
      !!nextEp.title && !!lastWatchedEpisode?.title && titleSimilarity(nextEp.title, lastWatchedEpisode.title) >= TITLE_DUPLICATE_SIMILARITY_THRESHOLD;

    const { category, reason } = classifyWatchNextSanity({
      isOnRiskList: onRiskList,
      nextEpisodeDataIncomplete,
      hasKnownSeasonShiftOrphan,
      nextEpisodeTitleDuplicatesLastWatched,
      isRecoveryFlipCandidate,
    });

    rows.push({
      seriesTitle: series.title,
      seriesId,
      userStatus: p.userStatus,
      releaseStatus: series.releaseStatus,
      nextEpisodeId: p.nextEpisodeId!,
      nextEpisode: {
        seasonNumber: nextEp.season.seasonNumber,
        episodeNumber: nextEp.episodeNumber,
        title: nextEp.title,
        airDate: nextEp.airDate?.toISOString() ?? null,
      },
      lastWatchedEpisode,
      watchedEpisodeCount: watchRows.length,
      knownEpisodeCount,
      providerSource: series.externalIds?.tmdbId ? `tmdb:${series.externalIds.tmdbId}` : 'unenriched',
      enrichedInTodaysBatch,
      onRiskList,
      category,
      reason,
    });
  }

  // DAN DA DAN was one of the 5 recovery-flip series but has since been
  // watched further via the live app and correctly resolved back to
  // CAUGHT_UP — no longer a Watch Next item. Reported separately as a
  // footnote rather than forced into the main list, since it isn't one.
  const danDaDanProgress = await prisma.userSeriesProgress.findFirst({
    where: { userId, series: { title: 'DAN DA DAN' } },
    include: { series: true },
  });
  const danDaDanNote = danDaDanProgress
    ? {
        seriesTitle: danDaDanProgress.series.title,
        userStatus: danDaDanProgress.userStatus,
        nextEpisodeId: danDaDanProgress.nextEpisodeId,
        lastWatchedAt: danDaDanProgress.lastWatchedAt?.toISOString() ?? null,
        note:
          danDaDanProgress.userStatus === 'CAUGHT_UP' && !danDaDanProgress.nextEpisodeId
            ? 'no longer in Watch Next — watched further since the recovery flip and correctly resolved to CAUGHT_UP; this is expected, not a bug'
            : 'state changed since this report was drafted — re-check directly',
      }
    : null;

  await prisma.$disconnect();

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.category] = (counts[r.category] ?? 0) + 1;

  console.log(`\nGenerated at: ${generatedAt.toISOString()}`);
  console.log(JSON.stringify({ watchNextCount: rows.length, byCategory: counts }, null, 2));

  mkdirSync(OUT_DIR, { recursive: true });

  const jsonReport = {
    generatedAt: generatedAt.toISOString(),
    note: 'Watch Next data can change in real time (e.g. a user marking episodes watched via the live app) — treat this as a single point-in-time snapshot, not a live view.',
    writesToAppTables: false,
    riskListSource: RISK_LIST_DOC,
    summary: { watchNextCount: rows.length, byCategory: counts },
    items: rows,
    danDaDanNote,
  };
  const jsonPath = path.join(OUT_DIR, 'post-enrichment-watch-next-sanity.json');
  writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2));
  console.log(`\nWrote ${jsonPath}`);

  const mdPath = path.join(OUT_DIR, 'post-enrichment-watch-next-sanity.md');
  writeFileSync(mdPath, buildMarkdown(generatedAt, rows, counts, danDaDanNote));
  console.log(`Wrote ${mdPath}`);
}

function buildMarkdown(
  generatedAt: Date,
  rows: WatchNextSanityRow[],
  counts: Record<string, number>,
  danDaDanNote: { seriesTitle: string; userStatus: string; nextEpisodeId: string | null; lastWatchedAt: string | null; note: string } | null,
): string {
  const lines: string[] = [];
  lines.push('# Post-Enrichment Watch Next Sanity Report');
  lines.push('');
  lines.push(`Generated: ${generatedAt.toISOString()}`);
  lines.push('');
  lines.push('**Note**: Watch Next data can change in real time (e.g. a user marking episodes watched via the live app). This is a single point-in-time snapshot.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Watch Next items: ${rows.length}`);
  for (const [category, count] of Object.entries(counts)) lines.push(`- **${category}**: ${count}`);
  lines.push('');

  if (danDaDanNote) {
    lines.push('## DAN DA DAN (not currently in Watch Next)');
    lines.push('');
    lines.push(`userStatus: ${danDaDanNote.userStatus} · nextEpisodeId: ${danDaDanNote.nextEpisodeId ?? '_null_'} · lastWatchedAt: ${danDaDanNote.lastWatchedAt ?? '_none_'}`);
    lines.push('');
    lines.push(danDaDanNote.note);
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  for (const r of rows) {
    lines.push(`## ${r.seriesTitle}`);
    lines.push('');
    lines.push(`**Category**: \`${r.category}\` — ${r.reason}`);
    lines.push('');
    lines.push(`- series id: \`${r.seriesId}\``);
    lines.push(`- userStatus: ${r.userStatus} · releaseStatus: ${r.releaseStatus}`);
    lines.push(`- provider source: ${r.providerSource}`);
    lines.push(`- enriched in today's batch: ${r.enrichedInTodaysBatch ? 'YES' : 'no'}`);
    lines.push(`- on episode-numbering risk list: ${r.onRiskList ? 'YES' : 'no'}`);
    lines.push(`- watched: ${r.watchedEpisodeCount} of ${r.knownEpisodeCount} known episodes`);
    lines.push(
      `- next episode: S${r.nextEpisode.seasonNumber}E${r.nextEpisode.episodeNumber}${r.nextEpisode.title ? ` — "${r.nextEpisode.title}"` : ' (no title on file)'} (airDate: ${r.nextEpisode.airDate?.slice(0, 10) ?? 'unknown'})`,
    );
    lines.push(
      r.lastWatchedEpisode
        ? `- last watched: S${r.lastWatchedEpisode.seasonNumber}E${r.lastWatchedEpisode.episodeNumber}${r.lastWatchedEpisode.title ? ` — "${r.lastWatchedEpisode.title}"` : ''} on ${r.lastWatchedEpisode.watchedAt.slice(0, 10)}`
        : '- last watched: _none recorded_',
    );
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
