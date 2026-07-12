// The automatic background sync scheduler (Part 1 of the scheduler-architecture
// task). Orchestrates the EXISTING episode-release-refresh pipeline —
// refreshOneSeries (episode-release-refresh/refresh-one-series.ts) — on a
// timer; it never re-implements or duplicates any comparison/write logic.
// This service only ever decides WHEN a series is due (sync-frequency-policy.ts)
// and records WHAT happened (sync-status-update-logic.ts) — both pure, unit-tested
// separately.
//
// Provider-agnostic by construction (Part 10): this file never imports
// TmdbClient's concrete type for anything passed into the pipeline —
// refreshOneSeries's `tmdb` parameter is typed as ProviderRefreshClient
// (episode-release-refresh/provider-refresh-client.ts), which TmdbClient
// just happens to satisfy today. The only TMDb-specific line in this whole
// module is the `new TmdbClient(...)` construction below — swapping in a
// second provider later means constructing a different concrete class here
// (or, for multiple providers at once, branching on Series/ExternalIds'
// `provider` field), not touching any of the scheduling/decision logic.
//
// Per-series isolation (Part 7): refreshOneSeries already never throws (it
// catches internally and returns a { kind: 'error' } outcome instead) — the
// try/catch below exists for the SeriesSyncStatus bookkeeping write itself,
// so a bookkeeping failure for one series can never abort the tick or
// block any other series.

import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { UserSeriesStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DEV_USER_ID } from '../../common/constants';
import { TmdbClient } from '../../../tmdb-enrichment/tmdb-client';
import { checkSeriesEligibility } from '../../../episode-release-refresh/refresh-logic';
import { isRefreshDue } from '../../../episode-release-refresh/sync-frequency-policy';
import { refreshOneSeries, SeriesRow } from '../../../episode-release-refresh/refresh-one-series';
import { classifyRefreshOperatingOutcome } from '../../../episode-release-refresh/refresh-operating-outcome';
import { computeSyncStatusUpdate, SyncAttemptOutcome } from '../../../episode-release-refresh/sync-status-update-logic';

// The tick itself just checks what's due — it is NOT the refresh interval.
// WATCHING's minimum ~8h cadence (sync-frequency-policy.ts) is still
// enforced by isRefreshDue regardless of how often this fires; an hourly
// tick is fine-grained enough that no status's interval is ever meaningfully
// delayed, without re-querying the whole library too often. Configurable so
// this can be tightened in tests or deployment without a code change.
const DEFAULT_TICK_INTERVAL_MS = 60 * 60 * 1000;

export interface SyncTickResult {
  checked: number;
  refreshed: number;
  blockedManualReview: number;
  errored: number;
}

interface DueCandidate {
  row: SeriesRow;
  previousNumberOfFailures: number;
  previousLastSuccessfulRefreshAt: Date | null;
}

@Injectable()
export class EpisodeSyncSchedulerService {
  private readonly logger = new Logger(EpisodeSyncSchedulerService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Interval(Number(process.env.SYNC_SCHEDULER_TICK_INTERVAL_MS) || DEFAULT_TICK_INTERVAL_MS)
  async handleTick(): Promise<void> {
    await this.runTick();
  }

  // Exposed separately from the @Interval-decorated handler so tests (and
  // a future admin UI's "run now" action) can invoke exactly the same tick
  // logic without waiting for the interval to fire — same "one implementation,
  // multiple entry points" posture as refreshOneSeries itself. userId
  // defaults to DEV_USER_ID (this app's single tracked user today, same
  // convention every other run-*.ts CLI script already uses) but is a real
  // parameter rather than a hardcoded internal — schema already models
  // multiple User rows, and a test needs to point this at a disposable
  // fixture user without ever touching real tracked-series data.
  async runTick(userId: string = DEV_USER_ID, now: Date = new Date()): Promise<SyncTickResult> {
    const accessToken = process.env.TMDB_ACCESS_TOKEN;
    if (!accessToken) {
      this.logger.warn('Skipping sync tick — TMDB_ACCESS_TOKEN is not configured.');
      return { checked: 0, refreshed: 0, blockedManualReview: 0, errored: 0 };
    }
    const tmdb = new TmdbClient({ accessToken });

    const candidates = await this.loadDueCandidates(userId, now);
    const result: SyncTickResult = { checked: candidates.length, refreshed: 0, blockedManualReview: 0, errored: 0 };

    // Sequential, not parallel — matches run-apply-refresh.ts's existing
    // one-transaction-per-series, one-at-a-time convention (Part 8: no
    // premature optimization, and sequential keeps TMDb request volume
    // predictable rather than bursty).
    for (const candidate of candidates) {
      await this.processOneCandidate(candidate, tmdb, userId, now, result);
    }

    return result;
  }

  private async processOneCandidate(candidate: DueCandidate, tmdb: TmdbClient, userId: string, now: Date, result: SyncTickResult): Promise<void> {
    const { row, previousNumberOfFailures, previousLastSuccessfulRefreshAt } = candidate;
    const start = Date.now();

    try {
      const outcome = await refreshOneSeries({ prisma: this.prisma, tmdb, userId, series: row, apply: true, now });
      const durationMs = Date.now() - start;

      let syncOutcome: SyncAttemptOutcome;
      if (outcome.kind === 'error') {
        syncOutcome = { kind: 'failure', errorMessage: outcome.entry.message };
        result.errored++;
        this.logger.warn(`[sync-scheduler] ${row.title} — ${outcome.entry.message}`);
      } else if (classifyRefreshOperatingOutcome(outcome.entry.classification).operatingClassification === 'REVIEW_ALIGNMENT') {
        // Nothing was (or ever could be) auto-applied for this series this
        // attempt — buildEpisodeInsertPlan already returns an empty plan
        // for every classification other than NEW_RELEASE_AVAILABLE, so
        // this branch is purely a bookkeeping label (Part 5), never a
        // decision that changes what got written.
        syncOutcome = { kind: 'blocked-manual-review' };
        result.blockedManualReview++;
      } else {
        syncOutcome = { kind: 'success' };
        result.refreshed++;
      }

      const update = computeSyncStatusUpdate({ status: row.userStatus, outcome: syncOutcome, previousNumberOfFailures, previousLastSuccessfulRefreshAt, durationMs, now });
      await this.prisma.seriesSyncStatus.upsert({ where: { seriesId: row.id }, create: { seriesId: row.id, ...update }, update });
    } catch (err) {
      result.errored++;
      this.logger.error(`[sync-scheduler] unexpected error processing ${row.title}`, err as Error);
    }
  }

  // Same query shape as run-apply-refresh.ts's loadCandidateSeries,
  // duplicated per this codebase's convention (small I/O helpers live per
  // module, not cross-imported so each pipeline entry point stays
  // independently readable) — plus the SeriesSyncStatus join and due-check
  // this scheduler specifically needs.
  private async loadDueCandidates(userId: string, now: Date): Promise<DueCandidate[]> {
    const progresses = await this.prisma.userSeriesProgress.findMany({
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
            syncStatus: { select: { nextEligibleRefreshAt: true, numberOfFailures: true, lastSuccessfulRefreshAt: true } },
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
    const watches = await this.prisma.episodeWatch.findMany({
      where: { userId, episode: { season: { seriesId: { in: seriesIds } } } },
      select: { episodeId: true },
    });
    const watchedEpisodeIds = new Set(watches.map((w) => w.episodeId));

    const dueCandidates: DueCandidate[] = [];
    for (const p of progresses) {
      const tmdbId = p.series.externalIds?.tmdbId ?? null;
      const eligibility = checkSeriesEligibility({ userStatus: p.userStatus, tmdbId, title: p.series.title });
      if (!eligibility.eligible) continue;

      const status: UserSeriesStatus = p.userStatus;
      if (!isRefreshDue({ status, nextEligibleRefreshAt: p.series.syncStatus?.nextEligibleRefreshAt ?? null, now })) continue;

      const row: SeriesRow = {
        id: p.series.id,
        title: p.series.title,
        releaseStatus: p.series.releaseStatus,
        tmdbId,
        userStatus: status,
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
      };

      dueCandidates.push({
        row,
        previousNumberOfFailures: p.series.syncStatus?.numberOfFailures ?? 0,
        previousLastSuccessfulRefreshAt: p.series.syncStatus?.lastSuccessfulRefreshAt ?? null,
      });
    }
    return dueCandidates;
  }
}
