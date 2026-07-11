// Read-only audit: for every real Watch Next candidate
// (docs/watch-next-released-episode-semantics-todo.md Phase 8), compute the
// correct main episode / released-unwatched counts from current local data
// and compare against what's stored. Never writes anything — there is
// nothing to "apply" here: the +N count is computed fresh on every /home
// call (never stored), so once the code fix ships every read is
// automatically correct. This script exists to prove that across the real
// library, not to backfill data.
//
// Usage:
//   npx ts-node watch-next-audit/run-released-episode-audit.ts
//   npx ts-node watch-next-audit/run-released-episode-audit.ts --series=<id>

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { PrismaClient, UserSeriesStatus } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { auditWatchNextSeries, WatchNextReleaseAuditGroup, WatchNextReleaseAuditResult } from './released-episode-audit-logic';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');

interface CliOptions {
  userId: string;
  outDir: string;
  series?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { userId: DEV_USER_ID, outDir: DEFAULT_OUT_DIR };
  for (const arg of argv) {
    if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
    else if (arg.startsWith('--series=')) options.series = arg.slice('--series='.length);
  }
  return options;
}

const ALL_GROUPS: WatchNextReleaseAuditGroup[] = [
  'correct',
  'future-main-episode-exposed',
  'future-episodes-in-queue',
  'additional-count-includes-future',
  'stale-progress-requiring-reconciliation',
  'ambiguous-manual-review',
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  const generatedAt = new Date();

  console.log('Watch Next released-episode audit — READ ONLY, no writes of any kind');
  console.log(`  target user: ${options.userId}`);
  if (options.series) console.log(`  scoped to series: ${options.series}`);

  // Same candidate definition GET /me/watch-next uses: userStatus =
  // WATCHING AND nextEpisodeId IS NOT NULL — this audit is specifically
  // about series that are (or should be) actually surfaced in Watch Next.
  const progress = await prisma.userSeriesProgress.findMany({
    where: {
      userId: options.userId,
      userStatus: UserSeriesStatus.WATCHING,
      nextEpisodeId: { not: null },
      ...(options.series ? { seriesId: options.series } : {}),
    },
    include: { series: { select: { id: true, title: true } } },
  });
  console.log(`  candidates inspected: ${progress.length}`);

  const seriesIds = progress.map((p) => p.seriesId);
  const [episodes, watches] = await Promise.all([
    prisma.episode.findMany({
      where: { season: { seriesId: { in: seriesIds } } },
      orderBy: [{ season: { seasonNumber: 'asc' } }, { episodeNumber: 'asc' }],
      select: { id: true, airDate: true, season: { select: { seriesId: true } } },
    }),
    prisma.episodeWatch.findMany({
      where: { userId: options.userId, episode: { season: { seriesId: { in: seriesIds } } } },
      select: { episodeId: true, episode: { select: { season: { select: { seriesId: true } } } } },
    }),
  ]);

  const watchedEpisodeIds = new Set(watches.map((w) => w.episodeId));
  const episodesBySeriesId = new Map<string, { id: string; airDate: Date | null }[]>();
  for (const e of episodes) {
    const list = episodesBySeriesId.get(e.season.seriesId) ?? [];
    list.push({ id: e.id, airDate: e.airDate });
    episodesBySeriesId.set(e.season.seriesId, list);
  }

  const results: WatchNextReleaseAuditResult[] = progress.map((p) => {
    const orderedEpisodes = (episodesBySeriesId.get(p.seriesId) ?? []).map((e) => ({
      id: e.id,
      airDate: e.airDate,
      watched: watchedEpisodeIds.has(e.id),
    }));
    return auditWatchNextSeries({
      seriesId: p.seriesId,
      seriesTitle: p.series.title,
      storedNextEpisodeId: p.nextEpisodeId,
      orderedEpisodes,
      now: generatedAt,
    });
  });

  const countsByGroup = Object.fromEntries(ALL_GROUPS.map((g) => [g, results.filter((r) => r.group === g).length])) as Record<
    WatchNextReleaseAuditGroup,
    number
  >;

  for (const r of results) {
    if (r.group !== 'correct') {
      console.log(`  [${r.group}] ${r.seriesTitle} — ${r.reason}`);
    }
  }

  const report = {
    generatedAt: generatedAt.toISOString(),
    mode: 'audit-read-only',
    writesToAppTables: false,
    targetUserId: options.userId,
    onlySeriesId: options.series ?? null,
    totalCandidatesInspected: results.length,
    countsByGroup,
    entries: results,
  };

  mkdirSync(options.outDir, { recursive: true });
  const runsDir = path.join(options.outDir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  const json = JSON.stringify(report, null, 2);
  const timestamp = report.generatedAt.replace(/[:.]/g, '-');
  const latestPath = path.join(options.outDir, 'latest-released-episode-audit.json');
  const archivedPath = path.join(runsDir, `${timestamp}-released-episode-audit.json`);
  writeFileSync(latestPath, json);
  writeFileSync(archivedPath, json);

  console.log('');
  console.log('Counts by group:');
  for (const group of ALL_GROUPS) {
    console.log(`  ${group}: ${countsByGroup[group]}`);
  }
  console.log('');
  console.log(`Done (read-only, nothing written to the database). Report:`);
  console.log(`  ${latestPath}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
