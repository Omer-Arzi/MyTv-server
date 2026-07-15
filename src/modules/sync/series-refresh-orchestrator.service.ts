// The one shared per-series refresh entry point (Part 5/16 — "do not
// bypass the existing refreshOneSeries pipeline, do not duplicate catalog
// comparison logic"). Every caller that needs to refresh ONE series —
// the scheduled tick (episode-sync-scheduler.service.ts), manual
// single-series refresh, manual full-library refresh (per series), and
// series-page stale-on-open — goes through this exact service, never
// refreshOneSeries directly. This is what makes locking, cooldown, and
// sync-status bookkeeping consistent across all four callers instead of
// each reimplementing it.
//
// Never touches catalog comparison itself — refreshOneSeries (unchanged)
// still owns that entirely. This service only adds: eligibility/ownership
// checks, atomic duplicate-run locking, the optional "only if stale" gate,
// and writing the richer SeriesSyncStatus fields this task adds (Part 9).

import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient, ReleaseStatus, SeriesSyncStatus, SyncTrigger, UserSeriesStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TmdbClient } from '../../../tmdb-enrichment/tmdb-client';
import { checkSeriesEligibility, SeriesSkipReason } from '../../../episode-release-refresh/refresh-logic';
import { refreshOneSeries, SeriesRow } from '../../../episode-release-refresh/refresh-one-series';
import { classifyRefreshOperatingOutcome } from '../../../episode-release-refresh/refresh-operating-outcome';
import { computeSyncStatusUpdate, SyncAttemptOutcome } from '../../../episode-release-refresh/sync-status-update-logic';
import { isRefreshDue } from '../../../episode-release-refresh/sync-frequency-policy';
import { loadNextKnownUpcomingAirDate } from '../../../episode-release-refresh/next-known-upcoming-episode';
import { runLocalReleaseActivation } from '../../../episode-release-refresh/local-release-activation';

// A lock older than this is treated as abandoned (server restart mid-refresh,
// an unhandled crash, etc.) and reclaimable — restart-safety (Part 5.9).
// Generous relative to a real refresh's expected duration (one TMDb show
// fetch + a handful of season fetches, typically well under a minute) so a
// merely-slow-but-alive refresh is never preempted.
const STALE_LOCK_TIMEOUT_MS = 15 * 60 * 1000;

export interface SeriesSyncStatusSnapshot {
  lastEpisodeRefreshAt: Date | null;
  lastEpisodeRefreshStatus: string | null;
  lastSuccessfulRefreshAt: Date | null;
  nextEligibleRefreshAt: Date | null;
  refreshInProgress: boolean;
  lastRefreshTrigger: SyncTrigger | null;
  lastChangeAt: Date | null;
  lastEpisodesAdded: number | null;
  lastSeasonsAdded: number | null;
  lastRequiresManualReview: boolean;
  lastLocalActivationAt: Date | null;
}

function toSnapshot(row: SeriesSyncStatus | null): SeriesSyncStatusSnapshot {
  if (!row) {
    return {
      lastEpisodeRefreshAt: null,
      lastEpisodeRefreshStatus: null,
      lastSuccessfulRefreshAt: null,
      nextEligibleRefreshAt: null,
      refreshInProgress: false,
      lastRefreshTrigger: null,
      lastChangeAt: null,
      lastEpisodesAdded: null,
      lastSeasonsAdded: null,
      lastRequiresManualReview: false,
      lastLocalActivationAt: null,
    };
  }
  return {
    lastEpisodeRefreshAt: row.lastEpisodeRefreshAt,
    lastEpisodeRefreshStatus: row.lastEpisodeRefreshStatus,
    lastSuccessfulRefreshAt: row.lastSuccessfulRefreshAt,
    nextEligibleRefreshAt: row.nextEligibleRefreshAt,
    refreshInProgress: row.refreshInProgress,
    lastRefreshTrigger: row.lastRefreshTrigger,
    lastChangeAt: row.lastChangeAt,
    lastEpisodesAdded: row.lastEpisodesAdded,
    lastSeasonsAdded: row.lastSeasonsAdded,
    lastRequiresManualReview: row.lastRequiresManualReview,
    lastLocalActivationAt: row.lastLocalActivationAt,
  };
}

export type SeriesRefreshOutcome =
  | { kind: 'not-tracked' }
  | { kind: 'ineligible'; reason: SeriesSkipReason }
  | { kind: 'already-in-progress'; syncStatus: SeriesSyncStatusSnapshot }
  | { kind: 'not-stale'; syncStatus: SeriesSyncStatusSnapshot }
  | { kind: 'refreshed'; syncStatus: SeriesSyncStatusSnapshot; episodesAdded: number; seasonsAdded: number; requiresManualReview: boolean; providerError: boolean }
  | { kind: 'error'; message: string };

export interface RefreshSeriesForUserOptions {
  // When true, does nothing (returns 'not-stale') unless the series is
  // actually due per the smart scheduling policy — the series-page
  // stale-on-open path (Part 8). Manual triggers (single-series,
  // full-library) always pass false — a user explicitly asking for a
  // check should never be silently skipped for being "not due yet".
  onlyIfStale?: boolean;
}

@Injectable()
export class SeriesRefreshOrchestratorService {
  private readonly logger = new Logger(SeriesRefreshOrchestratorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async refreshSeriesForUser(userId: string, seriesId: string, trigger: SyncTrigger, options: RefreshSeriesForUserOptions = {}): Promise<SeriesRefreshOutcome> {
    const now = new Date();

    const progress = await this.prisma.userSeriesProgress.findUnique({
      where: { userId_seriesId: { userId, seriesId } },
      include: {
        series: { include: { externalIds: true, syncStatus: true, seasons: { include: { episodes: { include: { watches: { where: { userId } } } } } } } },
      },
    });
    // Ownership: a series this user has no UserSeriesProgress relationship
    // with is never refreshable by them, regardless of whether some OTHER
    // user tracks the same underlying series row (Part 13 edge case:
    // multiple users tracking the same series — each user's refresh
    // request is scoped by their OWN progress row, never a bare seriesId
    // trusted from the client alone).
    if (!progress) return { kind: 'not-tracked' };

    const { series } = progress;
    const tmdbId = series.externalIds?.tmdbId ?? null;
    const eligibility = checkSeriesEligibility({ userStatus: progress.userStatus, tmdbId, title: series.title });
    if (!eligibility.eligible) return { kind: 'ineligible', reason: eligibility.reason! };

    const existingSyncStatus = series.syncStatus;

    if (options.onlyIfStale) {
      const due = isRefreshDue({ status: progress.userStatus, nextEligibleRefreshAt: existingSyncStatus?.nextEligibleRefreshAt ?? null, now });
      const currentlyLocked = existingSyncStatus?.refreshInProgress && !this.isLockStale(existingSyncStatus.refreshStartedAt, now);
      if (!due || currentlyLocked) return { kind: 'not-stale', syncStatus: toSnapshot(existingSyncStatus) };
    }

    const claimed = await this.claimLock(seriesId, now);
    if (!claimed) {
      const current = await this.prisma.seriesSyncStatus.findUnique({ where: { seriesId } });
      this.logger.log(`[sync] ${series.title} — refresh already in progress (trigger=${trigger}), returning existing status`);
      return { kind: 'already-in-progress', syncStatus: toSnapshot(current) };
    }

    const accessToken = process.env.TMDB_ACCESS_TOKEN;
    if (!accessToken) {
      await this.releaseLockWithFailure(seriesId, progress.userStatus, existingSyncStatus, 'Server is missing TMDB_ACCESS_TOKEN', now);
      return { kind: 'error', message: 'Server is missing TMDB_ACCESS_TOKEN — cannot refresh.' };
    }

    const start = Date.now();
    const row: SeriesRow = {
      id: series.id,
      title: series.title,
      releaseStatus: series.releaseStatus,
      tmdbId,
      userStatus: progress.userStatus,
      nextEpisodeId: progress.nextEpisodeId,
      episodes: series.seasons.flatMap((season) =>
        season.episodes.map((ep) => ({
          id: ep.id,
          seasonNumber: season.seasonNumber,
          episodeNumber: ep.episodeNumber,
          title: ep.title,
          overview: ep.overview,
          airDate: ep.airDate,
          imageUrl: ep.imageUrl,
          runtimeMinutes: ep.runtimeMinutes,
          watched: ep.watches.length > 0,
        })),
      ),
    };

    try {
      const outcome = await refreshOneSeries({ prisma: this.prisma as unknown as PrismaClient, tmdb: new TmdbClient({ accessToken }), userId, series: row, apply: true, now });
      const durationMs = Date.now() - start;

      let syncOutcome: SyncAttemptOutcome;
      let episodesAdded = 0;
      let seasonsAdded = 0;
      let requiresManualReview = false;
      let providerError = false;

      if (outcome.kind === 'error') {
        syncOutcome = { kind: 'failure', errorMessage: outcome.entry.message };
        providerError = true;
        this.logger.warn(`[sync] ${series.title} — refresh failed (trigger=${trigger}): ${outcome.entry.message}`);
      } else {
        episodesAdded = outcome.entry.episodesInserted;
        seasonsAdded = outcome.entry.seasonsCreated.length;
        requiresManualReview = classifyRefreshOperatingOutcome(outcome.entry.classification).operatingClassification === 'REVIEW_ALIGNMENT';
        syncOutcome = requiresManualReview ? { kind: 'blocked-manual-review' } : { kind: 'success' };
        this.logger.log(
          `[sync] ${series.title} — refresh complete (trigger=${trigger}): classification=${outcome.entry.classification}, episodesAdded=${episodesAdded}, seasonsAdded=${seasonsAdded}, durationMs=${durationMs}`,
        );
      }

      // Also run local release activation for this one series — belt-and-
      // suspenders alongside refreshOneSeries's own internal progress-only
      // fallback (see that file's "insertPlan.episodesToInsert.length === 0"
      // branch, which already does this when there's nothing to insert):
      // explicit here so this orchestrator's contract ("a refresh always
      // includes local activation") holds regardless of which internal
      // path refreshOneSeries took. Idempotent — see local-release-activation.ts.
      const activation = await runLocalReleaseActivation(this.prisma as unknown as PrismaClient, userId, { seriesId });

      const [liveSeries, nextKnownUpcomingAirDate] = await Promise.all([
        this.prisma.series.findUnique({ where: { id: seriesId }, select: { releaseStatus: true } }),
        loadNextKnownUpcomingAirDate(this.prisma as unknown as PrismaClient, seriesId, now),
      ]);

      const update = computeSyncStatusUpdate({
        status: progress.userStatus,
        outcome: syncOutcome,
        previousNumberOfFailures: existingSyncStatus?.numberOfFailures ?? 0,
        previousLastSuccessfulRefreshAt: existingSyncStatus?.lastSuccessfulRefreshAt ?? null,
        durationMs,
        releaseStatus: liveSeries?.releaseStatus ?? series.releaseStatus,
        nextKnownUpcomingAirDate,
        now,
      });

      const hasChange = episodesAdded > 0 || seasonsAdded > 0;
      const saved = await this.prisma.seriesSyncStatus.update({
        where: { seriesId },
        data: {
          ...update,
          refreshInProgress: false,
          refreshStartedAt: null,
          lastRefreshTrigger: trigger,
          lastChangeAt: hasChange ? now : existingSyncStatus?.lastChangeAt ?? null,
          lastEpisodesAdded: episodesAdded,
          lastSeasonsAdded: seasonsAdded,
          lastRequiresManualReview: requiresManualReview,
          lastLocalActivationAt: now,
        },
      });

      if (outcome.kind === 'error') return { kind: 'error', message: outcome.entry.message };
      return { kind: 'refreshed', syncStatus: toSnapshot(saved), episodesAdded, seasonsAdded, requiresManualReview, providerError };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`[sync] ${series.title} — unexpected error during refresh (trigger=${trigger})`, err as Error);
      await this.releaseLockWithFailure(seriesId, progress.userStatus, existingSyncStatus, message, now);
      return { kind: 'error', message };
    }
  }

  private isLockStale(refreshStartedAt: Date | null, now: Date): boolean {
    if (!refreshStartedAt) return true;
    return now.getTime() - refreshStartedAt.getTime() > STALE_LOCK_TIMEOUT_MS;
  }

  // Atomic claim: creates the row (first-ever refresh for this series) or
  // flips refreshInProgress false->true / reclaims an abandoned lock, all
  // in a single conditional UPDATE so two concurrent callers can never both
  // believe they hold the lock (Part 5.2/5.4, Part 16's explicit,
  // testable duplicate-run protection for a single-instance deployment).
  private async claimLock(seriesId: string, now: Date): Promise<boolean> {
    const staleCutoff = new Date(now.getTime() - STALE_LOCK_TIMEOUT_MS);

    try {
      await this.prisma.seriesSyncStatus.create({ data: { seriesId, refreshInProgress: true, refreshStartedAt: now } });
      return true;
    } catch {
      // Row already exists (the common case, or a race on first-ever
      // refresh — either way, fall through to the atomic conditional claim
      // below rather than assuming which happened).
    }

    const result = await this.prisma.seriesSyncStatus.updateMany({
      where: { seriesId, OR: [{ refreshInProgress: false }, { refreshStartedAt: { lt: staleCutoff } }] },
      data: { refreshInProgress: true, refreshStartedAt: now },
    });
    return result.count === 1;
  }

  private async releaseLockWithFailure(seriesId: string, status: UserSeriesStatus, existing: SeriesSyncStatus | null, message: string, now: Date): Promise<void> {
    const update = computeSyncStatusUpdate({
      status,
      outcome: { kind: 'failure', errorMessage: message },
      previousNumberOfFailures: existing?.numberOfFailures ?? 0,
      previousLastSuccessfulRefreshAt: existing?.lastSuccessfulRefreshAt ?? null,
      durationMs: 0,
      releaseStatus: ReleaseStatus.UNKNOWN,
      nextKnownUpcomingAirDate: null,
      now,
    });
    await this.prisma.seriesSyncStatus.update({ where: { seriesId }, data: { ...update, refreshInProgress: false, refreshStartedAt: null } });
  }
}
