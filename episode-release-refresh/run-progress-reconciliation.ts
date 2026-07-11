// Progress reconciliation — system-wide audit + safe apply
// (docs/progress-reconciliation-architecture-todo.md Phase 6/7).
//
// Entirely local/offline — no TMDb call anywhere in this script, unlike
// run-refresh.ts/run-apply-refresh.ts. That's the point: this is the
// standalone, first-class "is UserSeriesProgress correct given what's
// already in the database" check, decoupled from any catalog-sync concern.
//
// Dry-run by default (no writes of any kind). Pass --apply to actually
// write — only for entries classified safe to auto-apply (a real mismatch,
// on a tracked non-protected series, not on the known risk list — see
// progress-reconciliation-logic.ts::checkAutoApplySafety). Anything
// ambiguous is reported but never written; --apply never touches it.
//
// Usage:
//   npx ts-node episode-release-refresh/run-progress-reconciliation.ts                    # dry run, full library
//   npx ts-node episode-release-refresh/run-progress-reconciliation.ts --series=<id>       # dry run, one series
//   npx ts-node episode-release-refresh/run-progress-reconciliation.ts --apply             # apply, full library
//   npx ts-node episode-release-refresh/run-progress-reconciliation.ts --apply --series=<id>

import 'dotenv/config';
import path from 'path';
import { PrismaClient, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { OrderedEpisodeForNextLookup } from '../src/modules/series/series-query-helpers';
import { checkAutoApplySafety, PROTECTED_RECONCILIATION_STATUSES, reconcileSeriesProgress } from './progress-reconciliation-logic';
import { applyProgressReconciliation } from './apply-progress-reconciliation';
import { TRACKED_USER_STATUSES } from './refresh-logic';
import {
  AuditMismatchCategory,
  buildProgressReconciliationAuditReport,
  buildProgressReconciliationMarkdownReport,
  ProgressAuditEntry,
  writeProgressReconciliationReports,
} from './progress-reconciliation-reports';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');
const APPLY_FLAG = '--apply';

interface CliOptions {
  userId: string;
  outDir: string;
  apply: boolean;
  series?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { userId: DEV_USER_ID, outDir: DEFAULT_OUT_DIR, apply: argv.includes(APPLY_FLAG) };
  for (const arg of argv) {
    if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
    else if (arg.startsWith('--series=')) options.series = arg.slice('--series='.length);
  }
  return options;
}

interface CandidateRow {
  seriesId: string;
  seriesTitle: string;
  releaseStatus: ReleaseStatus;
  tmdbId: string | null;
  userStatus: UserSeriesStatus;
  nextEpisodeId: string | null;
  orderedEpisodes: OrderedEpisodeForNextLookup[];
  watchedEpisodeIds: Set<string>;
}

// Every status this audit ever produces a report row for. WATCHLIST/UNKNOWN
// are deliberately excluded entirely — not even fetched — matching
// TRACKED_USER_STATUSES's existing "no next-episode concept applies" rule
// (docs/progress-reconciliation-architecture-todo.md Phase 3); a series in
// either of those statuses gets no row, not a "no mismatch" row, since the
// question doesn't apply to it at all.
const REPORTABLE_STATUSES: UserSeriesStatus[] = [...TRACKED_USER_STATUSES, ...PROTECTED_RECONCILIATION_STATUSES];

async function loadCandidates(prisma: PrismaClient, userId: string, onlySeriesId?: string): Promise<CandidateRow[]> {
  const progress = await prisma.userSeriesProgress.findMany({
    where: {
      userId,
      userStatus: { in: REPORTABLE_STATUSES },
      ...(onlySeriesId ? { seriesId: onlySeriesId } : {}),
    },
    include: {
      series: {
        include: {
          externalIds: { select: { tmdbId: true } },
          seasons: { include: { episodes: { select: { id: true, episodeNumber: true, airDate: true } } } },
        },
      },
    },
  });

  const seriesIds = progress.map((p) => p.seriesId);
  const watches = seriesIds.length
    ? await prisma.episodeWatch.findMany({
        where: { userId, episode: { season: { seriesId: { in: seriesIds } } } },
        select: { episodeId: true, episode: { select: { season: { select: { seriesId: true } } } } },
      })
    : [];
  const watchedEpisodeIdsBySeriesId = new Map<string, Set<string>>();
  for (const w of watches) {
    const sid = w.episode.season.seriesId;
    const set = watchedEpisodeIdsBySeriesId.get(sid) ?? new Set<string>();
    set.add(w.episodeId);
    watchedEpisodeIdsBySeriesId.set(sid, set);
  }

  return progress.map((p) => {
    const episodes = p.series.seasons.flatMap((season) =>
      season.episodes.map((e) => ({ id: e.id, seasonNumber: season.seasonNumber, episodeNumber: e.episodeNumber, airDate: e.airDate })),
    );
    episodes.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);

    return {
      seriesId: p.seriesId,
      seriesTitle: p.series.title,
      releaseStatus: p.series.releaseStatus,
      tmdbId: p.series.externalIds?.tmdbId ?? null,
      userStatus: p.userStatus,
      nextEpisodeId: p.nextEpisodeId,
      orderedEpisodes: episodes.map((e) => ({ id: e.id, airDate: e.airDate })),
      watchedEpisodeIds: watchedEpisodeIdsBySeriesId.get(p.seriesId) ?? new Set<string>(),
    };
  });
}

function buildAuditEntry(row: CandidateRow): ProgressAuditEntry {
  if (PROTECTED_RECONCILIATION_STATUSES.includes(row.userStatus)) {
    return {
      seriesId: row.seriesId,
      seriesTitle: row.seriesTitle,
      storedUserStatus: row.userStatus,
      computedUserStatus: null,
      storedNextEpisodeId: row.nextEpisodeId,
      computedNextEpisodeId: null,
      category: 'protected-manual-status-skipped',
      safeToApply: false,
      reason: `current userStatus is ${row.userStatus} — explicit user intent, never auto-overridden`,
      applied: null,
    };
  }

  // Tracked (WATCHING/CAUGHT_UP/COMPLETED) but no confirmed provider match
  // — MyTv only knows about episodes this user already watched, so
  // "no unwatched episode found" would not be a safe signal (same rule
  // next-episode-backfill's hasFullCatalog gate already enforces, and the
  // same "no-tmdb-id" reason episode-release-refresh's own
  // checkSeriesEligibility already uses).
  if (!row.tmdbId) {
    return {
      seriesId: row.seriesId,
      seriesTitle: row.seriesTitle,
      storedUserStatus: row.userStatus,
      computedUserStatus: null,
      storedNextEpisodeId: row.nextEpisodeId,
      computedNextEpisodeId: null,
      category: 'no-tmdb-id-skipped',
      safeToApply: false,
      reason: 'no confirmed provider match (ExternalIds.tmdbId not set) — local episode catalog may be incomplete, not a safe signal to reconcile from',
      applied: null,
    };
  }

  const outcome = reconcileSeriesProgress({
    currentUserStatus: row.userStatus,
    currentNextEpisodeId: row.nextEpisodeId,
    orderedEpisodes: row.orderedEpisodes,
    watchedEpisodeIds: row.watchedEpisodeIds,
    releaseStatus: row.releaseStatus,
  });

  if (outcome.kind !== 'changed') {
    // 'unchanged' is the only other reachable kind here — 'protected' and
    // 'not-tracked' are already handled above / excluded from the query.
    return {
      seriesId: row.seriesId,
      seriesTitle: row.seriesTitle,
      storedUserStatus: row.userStatus,
      computedUserStatus: row.userStatus,
      storedNextEpisodeId: row.nextEpisodeId,
      computedNextEpisodeId: row.nextEpisodeId,
      category: 'no-mismatch',
      safeToApply: false,
      reason: 'computed progress already matches stored progress',
      applied: null,
    };
  }

  const safety = checkAutoApplySafety(row.seriesTitle);
  return {
    seriesId: row.seriesId,
    seriesTitle: row.seriesTitle,
    storedUserStatus: outcome.from.userStatus,
    computedUserStatus: outcome.to.userStatus,
    storedNextEpisodeId: outcome.from.nextEpisodeId,
    computedNextEpisodeId: outcome.to.nextEpisodeId,
    category: outcome.mismatchType as AuditMismatchCategory,
    safeToApply: safety.safe,
    reason: safety.safe ? `deterministic recompute from local catalog + watch history (${outcome.mismatchType})` : safety.reason,
    applied: null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  const generatedAt = new Date();

  console.log(`Progress reconciliation — mode: ${options.apply ? 'APPLY (writes will happen for safe mismatches)' : 'DRY RUN (no writes)'}`);
  console.log(`  target user: ${options.userId}`);
  if (options.series) console.log(`  scoped to series: ${options.series}`);

  const candidates = await loadCandidates(prisma, options.userId, options.series);
  console.log(`  rows inspected: ${candidates.length}`);

  const entries = candidates.map(buildAuditEntry);

  const applyErrors: { seriesId: string; seriesTitle: string; message: string }[] = [];
  if (options.apply) {
    for (const entry of entries) {
      if (!entry.safeToApply) continue;
      try {
        const result = await applyProgressReconciliation(prisma, { userId: options.userId, seriesId: entry.seriesId });
        entry.applied = result.progressRecomputed;
        if (result.progressRecomputed) {
          console.log(`  [APPLIED] ${entry.seriesTitle} — ${entry.storedUserStatus}/${entry.storedNextEpisodeId ?? 'null'} -> ${entry.computedUserStatus}/${entry.computedNextEpisodeId ?? 'null'}`);
        } else {
          console.log(`  [NO-OP AT WRITE TIME] ${entry.seriesTitle} — ${result.progressSkippedReason ?? result.writeSkippedReason}`);
        }
      } catch (err) {
        entry.applied = false;
        const message = (err as Error).message;
        applyErrors.push({ seriesId: entry.seriesId, seriesTitle: entry.seriesTitle, message });
        console.log(`  [ERROR] ${entry.seriesTitle} — ${message}`);
      }
    }
  } else {
    const skipCategories: AuditMismatchCategory[] = ['protected-manual-status-skipped', 'no-tmdb-id-skipped'];
    for (const entry of entries) {
      if (entry.category === 'no-mismatch') continue;
      const label = skipCategories.includes(entry.category)
        ? 'SKIPPED'
        : entry.safeToApply
          ? 'SAFE MISMATCH'
          : 'UNSAFE MISMATCH — MANUAL REVIEW';
      console.log(`  [${label}] ${entry.seriesTitle} — ${entry.category}: ${entry.storedUserStatus}/${entry.storedNextEpisodeId ?? 'null'} -> ${entry.computedUserStatus ?? '—'}/${entry.computedNextEpisodeId ?? '—'}`);
    }
  }

  const report = buildProgressReconciliationAuditReport({
    generatedAt,
    apply: options.apply,
    targetUserId: options.userId,
    onlySeriesId: options.series ?? null,
    entries,
    applyErrors,
  });
  const markdown = buildProgressReconciliationMarkdownReport(report);
  const paths = writeProgressReconciliationReports(options.outDir, report, markdown);

  console.log('');
  console.log(`Done. Safe mismatches: ${report.safeMismatchCount}, unsafe/manual-review: ${report.unsafeMismatchCount}${options.apply ? `, applied: ${report.appliedCount}` : ''}`);
  console.log(`  ${paths.latestJsonPath}`);
  console.log(`  ${paths.latestMarkdownPath}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
