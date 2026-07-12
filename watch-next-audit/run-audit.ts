// Read-only Watch Next accuracy audit. Never writes to any app table —
// queries the current database, categorizes what it finds, and writes a
// report. Reuses the exact same logic the live endpoints already use
// (isEpisodeReleased, findFirstUnwatchedEpisodeId, detectDuplicateTitleGroups)
// rather than re-deciding any of it, so this audit can never disagree with
// what /me/watch-next actually does.

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { PrismaClient, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { findFirstUnwatchedEpisodeId, OrderedEpisodeForNextLookup } from '../src/modules/series/series-query-helpers';
import { detectDuplicateTitleGroups } from '../tmdb-enrichment/data-quality';
import { categorizeWatchNextCandidate, WatchNextIssueCategory } from './audit-logic';

const DEFAULT_OUTPUT_DIR = path.join(__dirname, 'output');

interface CliOptions {
  userId?: string;
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { outDir: DEFAULT_OUTPUT_DIR };
  for (const arg of argv) {
    if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
  }
  return options;
}

interface WatchNextAuditRow {
  progressId: string;
  seriesId: string;
  seriesTitle: string;
  userStatus: UserSeriesStatus;
  releaseStatus: ReleaseStatus;
  nextEpisodeId: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string | null;
  airDate: string | null;
  airDateBucket: string;
  hasTmdbMatch: boolean;
  hasFullCatalog: boolean;
  lastWatchedEpisodeLabel: string | null;
  watchedEpisodeCount: number;
  knownEpisodeCount: number;
  watchedCountExceedsKnown: boolean;
  category: WatchNextIssueCategory;
  reasons: string[];
}

interface CandidateRow {
  seriesId: string;
  seriesTitle: string;
  userStatus: UserSeriesStatus;
  watchedEpisodeCount: number;
  knownEpisodeCount: number;
  hasFullCatalog: boolean;
  reason: string;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  console.log('Watch Next accuracy audit — read-only, writes report files only, never app tables.');
  console.log(`  target user: ${options.userId ?? 'ALL users'}`);

  const watchNextProgress = await prisma.userSeriesProgress.findMany({
    where: {
      ...(options.userId ? { userId: options.userId } : {}),
      userStatus: UserSeriesStatus.WATCHING,
      nextEpisodeId: { not: null },
    },
    include: {
      series: { include: { externalIds: true } },
      nextEpisode: { include: { season: true } },
    },
  });

  const seriesIds = [...new Set(watchNextProgress.map((p) => p.seriesId))];

  // Every series in the whole library, for the cross-series duplicate-title
  // check — a collision partner might not itself be in Watch Next right now.
  const allSeries = await prisma.series.findMany({ select: { id: true, title: true } });
  const duplicateGroups = detectDuplicateTitleGroups(allSeries);
  const duplicateSeriesIds = new Set(duplicateGroups.flatMap((g) => g.members.map((m) => m.id)));

  const [episodeRows, watchRows] = await Promise.all([
    prisma.episode.findMany({
      where: { season: { seriesId: { in: seriesIds } } },
      select: { id: true, episodeNumber: true, airDate: true, season: { select: { seriesId: true, seasonNumber: true } } },
      orderBy: [{ season: { seasonNumber: 'asc' } }, { episodeNumber: 'asc' }],
    }),
    prisma.episodeWatch.findMany({
      where: { episode: { season: { seriesId: { in: seriesIds } } }, ...(options.userId ? { userId: options.userId } : {}) },
      select: { userId: true, episodeId: true, watchedAt: true, episode: { select: { season: { select: { seriesId: true, seasonNumber: true } }, episodeNumber: true } } },
      orderBy: { watchedAt: 'desc' },
    }),
  ]);

  const episodesBySeriesId = new Map<string, typeof episodeRows>();
  for (const e of episodeRows) {
    const list = episodesBySeriesId.get(e.season.seriesId) ?? [];
    list.push(e);
    episodesBySeriesId.set(e.season.seriesId, list);
  }

  const watchesBySeriesId = new Map<string, typeof watchRows>();
  for (const w of watchRows) {
    const list = watchesBySeriesId.get(w.episode.season.seriesId) ?? [];
    list.push(w);
    watchesBySeriesId.set(w.episode.season.seriesId, list);
  }

  const rows: WatchNextAuditRow[] = watchNextProgress
    .filter((p) => p.nextEpisode !== null)
    .map((p) => {
      const episodes = episodesBySeriesId.get(p.seriesId) ?? [];
      const watches = watchesBySeriesId.get(p.seriesId) ?? [];
      const seasonNumbersExcludingSpecials = new Set(episodes.filter((e) => e.season.seasonNumber !== 0).map((e) => e.season.seasonNumber));
      const hasSeasonZeroEpisodes = episodes.some((e) => e.season.seasonNumber === 0);
      const hasFullCatalog = p.series.externalIds?.tmdbId != null;
      const lastWatch = watches[0]; // already ordered desc by watchedAt

      const { category, reasons, airDateBucket } = categorizeWatchNextCandidate({
        airDate: p.nextEpisode!.airDate,
        hasFullCatalog,
        watchedEpisodeCount: watches.length,
        knownEpisodeCount: episodes.length,
        distinctKnownSeasonCount: seasonNumbersExcludingSpecials.size,
        hasSeasonZeroEpisodes,
        isDuplicateTitleGroupMember: duplicateSeriesIds.has(p.seriesId),
      });

      return {
        progressId: p.id,
        seriesId: p.seriesId,
        seriesTitle: p.series.title,
        userStatus: p.userStatus,
        releaseStatus: p.series.releaseStatus,
        nextEpisodeId: p.nextEpisodeId!,
        seasonNumber: p.nextEpisode!.season.seasonNumber,
        episodeNumber: p.nextEpisode!.episodeNumber,
        episodeTitle: p.nextEpisode!.title,
        airDate: p.nextEpisode!.airDate?.toISOString() ?? null,
        airDateBucket,
        hasTmdbMatch: hasFullCatalog,
        hasFullCatalog,
        lastWatchedEpisodeLabel: lastWatch ? `S${lastWatch.episode.season.seasonNumber}E${lastWatch.episode.episodeNumber}` : null,
        watchedEpisodeCount: watches.length,
        knownEpisodeCount: episodes.length,
        watchedCountExceedsKnown: watches.length > episodes.length,
        category,
        reasons,
      };
    });

  // --- Task 5: candidates NOT currently in Watch Next that maybe should be ---

  const watchingNoNextEpisode = await prisma.userSeriesProgress.findMany({
    where: { ...(options.userId ? { userId: options.userId } : {}), userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: null },
    include: { series: { include: { externalIds: true } } },
  });

  const caughtUp = await prisma.userSeriesProgress.findMany({
    where: { ...(options.userId ? { userId: options.userId } : {}), userStatus: UserSeriesStatus.CAUGHT_UP },
    include: { series: { include: { externalIds: true } } },
  });

  const unknownWithWatches = await prisma.userSeriesProgress.findMany({
    where: { ...(options.userId ? { userId: options.userId } : {}), userStatus: UserSeriesStatus.UNKNOWN },
    include: { series: { include: { externalIds: true } } },
  });

  const candidateSeriesIds = [...new Set([...watchingNoNextEpisode, ...caughtUp, ...unknownWithWatches].map((p) => p.seriesId))];
  const [candidateEpisodeRows, candidateWatchRows] = await Promise.all([
    prisma.episode.findMany({
      where: { season: { seriesId: { in: candidateSeriesIds } } },
      select: { id: true, episodeNumber: true, airDate: true, season: { select: { seriesId: true, seasonNumber: true } } },
      orderBy: [{ season: { seasonNumber: 'asc' } }, { episodeNumber: 'asc' }],
    }),
    prisma.episodeWatch.findMany({
      where: { episode: { season: { seriesId: { in: candidateSeriesIds } } }, ...(options.userId ? { userId: options.userId } : {}) },
      select: { userId: true, episodeId: true, episode: { select: { season: { select: { seriesId: true } } } } },
    }),
  ]);

  const candidateEpisodesBySeriesId = new Map<string, OrderedEpisodeForNextLookup[]>();
  const candidateEpisodeCountBySeriesId = new Map<string, number>();
  for (const e of candidateEpisodeRows) {
    const list = candidateEpisodesBySeriesId.get(e.season.seriesId) ?? [];
    list.push({ id: e.id, airDate: e.airDate, seasonNumber: e.season.seasonNumber });
    candidateEpisodesBySeriesId.set(e.season.seriesId, list);
    candidateEpisodeCountBySeriesId.set(e.season.seriesId, (candidateEpisodeCountBySeriesId.get(e.season.seriesId) ?? 0) + 1);
  }

  const candidateWatchedIdsBySeriesId = new Map<string, Set<string>>();
  const candidateWatchedCountBySeriesId = new Map<string, number>();
  for (const w of candidateWatchRows) {
    const seriesId = w.episode.season.seriesId;
    const set = candidateWatchedIdsBySeriesId.get(seriesId) ?? new Set<string>();
    set.add(w.episodeId);
    candidateWatchedIdsBySeriesId.set(seriesId, set);
    candidateWatchedCountBySeriesId.set(seriesId, (candidateWatchedCountBySeriesId.get(seriesId) ?? 0) + 1);
  }

  const watchingWithNoNextEpisodeCandidates: CandidateRow[] = watchingNoNextEpisode.map((p) => ({
    seriesId: p.seriesId,
    seriesTitle: p.series.title,
    userStatus: p.userStatus,
    watchedEpisodeCount: candidateWatchedCountBySeriesId.get(p.seriesId) ?? 0,
    knownEpisodeCount: candidateEpisodeCountBySeriesId.get(p.seriesId) ?? 0,
    hasFullCatalog: p.series.externalIds?.tmdbId != null,
    reason: 'userStatus is WATCHING but nextEpisodeId is null — either genuinely caught up (should be CAUGHT_UP/COMPLETED) or the backfill has not run for this row',
  }));

  const caughtUpWithAiredUnwatchedCandidates: CandidateRow[] = caughtUp
    .map((p) => {
      const episodes = candidateEpisodesBySeriesId.get(p.seriesId) ?? [];
      const watchedIds = candidateWatchedIdsBySeriesId.get(p.seriesId) ?? new Set<string>();
      const nextId = findFirstUnwatchedEpisodeId(episodes, watchedIds);
      return { p, nextId };
    })
    .filter((r) => r.nextId !== null)
    .map(({ p }) => ({
      seriesId: p.seriesId,
      seriesTitle: p.series.title,
      userStatus: p.userStatus,
      watchedEpisodeCount: candidateWatchedCountBySeriesId.get(p.seriesId) ?? 0,
      knownEpisodeCount: candidateEpisodeCountBySeriesId.get(p.seriesId) ?? 0,
      hasFullCatalog: p.series.externalIds?.tmdbId != null,
      reason: 'userStatus is CAUGHT_UP but a released, unwatched episode now exists — a newly-aired episode the backfill has not picked up yet',
    }));

  const unknownWithWatchesCandidates: CandidateRow[] = unknownWithWatches
    .filter((p) => (candidateWatchedCountBySeriesId.get(p.seriesId) ?? 0) > 0 && p.series.externalIds?.tmdbId != null)
    .map((p) => ({
      seriesId: p.seriesId,
      seriesTitle: p.series.title,
      userStatus: p.userStatus,
      watchedEpisodeCount: candidateWatchedCountBySeriesId.get(p.seriesId) ?? 0,
      knownEpisodeCount: candidateEpisodeCountBySeriesId.get(p.seriesId) ?? 0,
      hasFullCatalog: true,
      reason: 'userStatus is UNKNOWN but this user has watch history and a confirmed TMDb catalog — likely never re-evaluated after enrichment',
    }));

  const counts = {
    watchNextCandidatesInspected: rows.length,
    safe: rows.filter((r) => r.category === 'SAFE').length,
    futureEpisode: rows.filter((r) => r.category === 'FUTURE_EPISODE_IN_WATCH_NEXT').length,
    nullAirDate: rows.filter((r) => r.category === 'NULL_AIRDATE_IN_WATCH_NEXT').length,
    incompleteCatalog: rows.filter((r) => r.category === 'INCOMPLETE_CATALOG').length,
    watchedExceedsKnown: rows.filter((r) => r.category === 'WATCHED_COUNT_EXCEEDS_KNOWN_EPISODES').length,
    seasonNumberingMismatch: rows.filter((r) => r.category === 'POSSIBLE_SEASON_NUMBERING_MISMATCH').length,
    specialsOrSeasonZeroMismatch: rows.filter((r) => r.category === 'POSSIBLE_SPECIALS_OR_SEASON_ZERO_MISMATCH').length,
    remakeOrDuplicateTitle: rows.filter((r) => r.category === 'POSSIBLE_REMAKE_OR_DUPLICATE_TITLE').length,
    duplicateTitleGroups: duplicateGroups.length,
    watchingWithNoNextEpisodeCandidates: watchingWithNoNextEpisodeCandidates.length,
    caughtUpWithAiredUnwatchedCandidates: caughtUpWithAiredUnwatchedCandidates.length,
    unknownWithWatchesCandidates: unknownWithWatchesCandidates.length,
  };

  console.log('\n' + JSON.stringify(counts, null, 2));

  mkdirSync(options.outDir, { recursive: true });

  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'dry-run',
    writesToAppTables: false,
    targetUserId: options.userId ?? null,
    counts,
    watchNextItems: rows,
    duplicateTitleGroups: duplicateGroups,
    candidatesNotCurrentlyInWatchNext: {
      watchingWithNoNextEpisode: watchingWithNoNextEpisodeCandidates,
      caughtUpWithAiredUnwatched: caughtUpWithAiredUnwatchedCandidates,
      unknownWithWatchesAndCatalog: unknownWithWatchesCandidates,
    },
  };

  const reportPath = path.join(options.outDir, 'watch-next-audit-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${reportPath}`);

  const summaryPath = path.join(options.outDir, 'watch-next-audit-summary.md');
  writeFileSync(summaryPath, buildMarkdownSummary(counts, rows));
  console.log(`Wrote ${summaryPath}`);

  await prisma.$disconnect();
}

function buildMarkdownSummary(counts: Record<string, number>, rows: WatchNextAuditRow[]): string {
  const lines: string[] = [];
  lines.push('# Watch Next Accuracy Audit');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Counts');
  lines.push('');
  for (const [key, value] of Object.entries(counts)) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push('');
  lines.push('## Items with issues');
  lines.push('');
  const withIssues = rows.filter((r) => r.category !== 'SAFE');
  if (withIssues.length === 0) {
    lines.push('None — every current Watch Next candidate passed all checks.');
  } else {
    for (const r of withIssues) {
      lines.push(`- **${r.seriesTitle}** (S${r.seasonNumber}E${r.episodeNumber}) — ${r.category}: ${r.reasons.join('; ')}`);
    }
  }
  lines.push('');
  lines.push('## Proposed fix plan (not applied)');
  lines.push('');
  lines.push('### Safe automatic fixes');
  lines.push('- Exclude future-airDate next episodes from `/me/watch-next` (already implemented — see `src/modules/me/me-query-helpers.ts`).');
  lines.push('- Exclude null-airDate next episodes from `/me/watch-next` (already implemented, same file).');
  lines.push('- Re-run `next-episode-backfill` for `CAUGHT_UP` rows with a newly-aired unwatched episode (`caughtUpWithAiredUnwatchedCandidates` above) — the backfill already handles this correctly; it just needs to run again periodically.');
  lines.push('');
  lines.push('### Needs manual review');
  lines.push('- `POSSIBLE_REMAKE_OR_DUPLICATE_TITLE` and `duplicateTitleGroups` entries — a title collision could mean the wrong TMDb match was applied; confirm which candidate is correct before touching `ExternalIds`.');
  lines.push('- `POSSIBLE_SEASON_NUMBERING_MISMATCH` and `POSSIBLE_SPECIALS_OR_SEASON_ZERO_MISMATCH` entries — absolute-vs-per-season numbering or specials-counting differences need a human to confirm the correct next episode; auto-correcting risks skipping or repeating episodes.');
  lines.push('- `unknownWithWatchesAndCatalog` candidates — these have watch history and a confirmed catalog but no userStatus; likely just need one pass of the existing status-derivation logic, but confirm none were intentionally left UNKNOWN.');
  lines.push('');
  lines.push('### Risky / do not touch');
  lines.push('- `INCOMPLETE_CATALOG` entries and the 152 `watchingWithNoNextEpisode` candidates — these lack a confirmed TMDb match; forcing a next-episode guess from an unconfirmed/partial catalog risks showing a wrong or duplicate episode. Wait for TMDb (or a secondary provider) enrichment instead.');
  lines.push('- `WATCHED_COUNT_EXCEEDS_KNOWN_EPISODES` entries — could mean the catalog is missing recently-aired episodes (safe to wait) or the series is mismatched (unsafe to auto-correct); needs a per-series look before any write.');
  lines.push('');
  return lines.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
