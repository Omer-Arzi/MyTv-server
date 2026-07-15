// Local release activation — Part 2B of the episode-and-series-update flow.
// NEVER calls a provider (TMDb/TVmaze/any). Handles episodes that already
// exist locally and whose stored airDate has now arrived: recomputes
// UserSeriesProgress (userStatus/nextEpisodeId) purely from already-local
// data, so a series doesn't have to wait for its next scheduled PROVIDER
// refresh (which can be hours away — see smart-scheduling-policy.ts) just
// for time to pass and an already-known future episode to become watchable.
//
// This is not new comparison/derivation logic — loadReconciliationCandidates
// and buildReconciliationEntry are extracted, unchanged, from
// run-progress-reconciliation.ts (which now imports them from here instead
// of defining them locally — see that file), and the actual decision/write
// primitives (reconcileSeriesProgress, checkAutoApplySafety,
// applyProgressReconciliation) are the SAME ones that file has used since
// before this task. This module adds only the orchestration
// (runLocalReleaseActivation) that both the CLI script and the new hourly
// scheduled job / manual-refresh paths can share, instead of each hand-
// rolling their own "load, classify, apply-safe-ones" loop.
//
// Idempotent and safe to run repeatedly: reconcileSeriesProgress diffs
// against the currently-stored value before proposing a change
// (hasProgressChanged), and applyProgressReconciliation re-verifies live
// state inside its own transaction before writing — running this twice in
// a row (or concurrently — see SeriesRefreshOrchestratorService's locking)
// produces at most one real write, never a duplicate.

import { PrismaClient, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { OrderedEpisodeForNextLookup } from '../src/modules/series/series-query-helpers';
import { checkAutoApplySafety, PROTECTED_RECONCILIATION_STATUSES, reconcileSeriesProgress } from './progress-reconciliation-logic';
import { applyProgressReconciliation } from './apply-progress-reconciliation';
import { TRACKED_USER_STATUSES } from './refresh-logic';
import { AuditMismatchCategory, ProgressAuditEntry } from './progress-reconciliation-reports';

// Every status this pass ever produces a row for. WATCHLIST/UNKNOWN are
// deliberately excluded entirely — matching TRACKED_USER_STATUSES's
// existing "no next-episode concept applies" rule; a series in either of
// those statuses has nothing for this pass to activate.
export const REPORTABLE_RECONCILIATION_STATUSES: UserSeriesStatus[] = [...TRACKED_USER_STATUSES, ...PROTECTED_RECONCILIATION_STATUSES];

export interface ReconciliationCandidateRow {
  seriesId: string;
  seriesTitle: string;
  releaseStatus: ReleaseStatus;
  tmdbId: string | null;
  userStatus: UserSeriesStatus;
  nextEpisodeId: string | null;
  orderedEpisodes: OrderedEpisodeForNextLookup[];
  watchedEpisodeIds: Set<string>;
}

// Extracted from run-progress-reconciliation.ts's loadCandidates, unchanged
// in behavior — see that file for why WATCHLIST/UNKNOWN are excluded at the
// query level rather than filtered after the fact.
export async function loadReconciliationCandidates(prisma: PrismaClient, userId: string, onlySeriesId?: string): Promise<ReconciliationCandidateRow[]> {
  const progress = await prisma.userSeriesProgress.findMany({
    where: {
      userId,
      userStatus: { in: REPORTABLE_RECONCILIATION_STATUSES },
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
      orderedEpisodes: episodes.map((e) => ({ id: e.id, airDate: e.airDate, seasonNumber: e.seasonNumber })),
      watchedEpisodeIds: watchedEpisodeIdsBySeriesId.get(p.seriesId) ?? new Set<string>(),
    };
  });
}

// Extracted from run-progress-reconciliation.ts's buildAuditEntry,
// unchanged in behavior.
export function buildReconciliationEntry(row: ReconciliationCandidateRow): ProgressAuditEntry {
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
  // "no unwatched episode found" would not be a safe signal.
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

export interface LocalReleaseActivationSummary {
  candidatesInspected: number;
  activatedCount: number; // safe mismatches actually applied this run.
  unchangedCount: number; // no-mismatch — already correct.
  manualReviewCount: number; // unsafe mismatch (risk-listed title) — never auto-applied.
  skippedCount: number; // protected status or no confirmed provider match.
  errorCount: number;
  activatedSeriesIds: string[];
  errors: { seriesId: string; seriesTitle: string; message: string }[];
}

export interface RunLocalReleaseActivationOptions {
  seriesId?: string; // scope to one series (manual single-series refresh) — omit for the whole library.
}

// The one shared entry point — called by the hourly scheduled job
// (episode-sync-scheduler.service.ts), and by the manual single-series /
// full-library refresh paths (Parts 6/7), per the task's explicit "also
// run the local release-activation process" requirement for both. Never
// calls a provider. Only ever writes UserSeriesProgress (via
// applyProgressReconciliation) — never Season/Episode.
export async function runLocalReleaseActivation(prisma: PrismaClient, userId: string, options: RunLocalReleaseActivationOptions = {}): Promise<LocalReleaseActivationSummary> {
  const candidates = await loadReconciliationCandidates(prisma, userId, options.seriesId);
  const entries = candidates.map(buildReconciliationEntry);

  const summary: LocalReleaseActivationSummary = {
    candidatesInspected: candidates.length,
    activatedCount: 0,
    unchangedCount: 0,
    manualReviewCount: 0,
    skippedCount: 0,
    errorCount: 0,
    activatedSeriesIds: [],
    errors: [],
  };

  for (const entry of entries) {
    if (entry.category === 'no-mismatch') {
      summary.unchangedCount++;
      continue;
    }
    if (entry.category === 'protected-manual-status-skipped' || entry.category === 'no-tmdb-id-skipped') {
      summary.skippedCount++;
      continue;
    }
    if (!entry.safeToApply) {
      summary.manualReviewCount++;
      continue;
    }

    try {
      const result = await applyProgressReconciliation(prisma, { userId, seriesId: entry.seriesId });
      if (result.progressRecomputed) {
        summary.activatedCount++;
        summary.activatedSeriesIds.push(entry.seriesId);
      } else {
        // Live-eligibility raced since the dry-run classification (e.g.
        // status changed between load and apply) — not an error, just
        // nothing left to do.
        summary.unchangedCount++;
      }
    } catch (err) {
      summary.errorCount++;
      summary.errors.push({ seriesId: entry.seriesId, seriesTitle: entry.seriesTitle, message: (err as Error).message });
    }
  }

  return summary;
}
