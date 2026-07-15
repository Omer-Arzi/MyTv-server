// The automatic background sync scheduler. Orchestrates the shared
// per-series refresh pipeline (SeriesRefreshOrchestratorService, which
// itself wraps the EXISTING episode-release-refresh pipeline —
// refreshOneSeries) on a timer; never re-implements or duplicates any
// comparison/write/locking logic.
//
// As of the episode-and-series-update flow task, this service delegates
// EVERY per-series attempt to SeriesRefreshOrchestratorService instead of
// hand-rolling its own refresh+write logic — the same shared locking that
// protects manual single-series/full-library/stale-on-open refreshes from
// colliding with EACH OTHER now also protects them from colliding with the
// scheduler (Part 5.7: "does not overlap with a manual refresh of the same
// series"). This file's own job shrinks to exactly two things: deciding
// WHICH series are due right now (loadDueSeriesIds, using
// sync-frequency-policy.ts's isRefreshDue — itself unchanged) and running
// the hourly, provider-free local release activation pass (Part 2B).
//
// Per-series isolation (Part 5.10): the orchestrator's refreshSeriesForUser
// never throws for a single series' provider/write failure (returns a
// typed 'error' outcome instead) — the try/catch below exists only for a
// genuinely unexpected failure in the scheduler's OWN loop bookkeeping, so
// that can never abort the tick or block any other series either.

import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaClient, SyncTrigger, UserSeriesStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DEV_USER_ID } from '../../common/constants';
import { checkSeriesEligibility } from '../../../episode-release-refresh/refresh-logic';
import { isRefreshDue } from '../../../episode-release-refresh/sync-frequency-policy';
import { runLocalReleaseActivation, LocalReleaseActivationSummary } from '../../../episode-release-refresh/local-release-activation';
import { SeriesRefreshOrchestratorService } from '../sync/series-refresh-orchestrator.service';

// The tick itself just checks what's due — it is NOT the refresh interval.
// The smart per-series interval (smart-scheduling-policy.ts) is still
// enforced by isRefreshDue regardless of how often this fires; an hourly
// tick is fine-grained enough that no series' interval (the shortest being
// ~1h for an overdue known episode) is ever meaningfully delayed, without
// re-querying the whole library too often. Configurable so this can be
// tightened in tests or deployment without a code change.
const DEFAULT_TICK_INTERVAL_MS = 60 * 60 * 1000;
// Local release activation (Part 2B: "run this process frequently,
// approximately once per hour") — a separate interval from the provider
// tick above on purpose, even though they happen to share the same
// default period today: they are conceptually different jobs (one calls a
// provider, one never does), and giving them independent
// @Interval-configurable env vars keeps that separation real rather than
// coincidental.
const DEFAULT_LOCAL_ACTIVATION_INTERVAL_MS = 60 * 60 * 1000;

export interface SyncTickResult {
  checked: number;
  refreshed: number;
  blockedManualReview: number;
  errored: number;
  alreadyInProgress: number;
}

@Injectable()
export class EpisodeSyncSchedulerService {
  private readonly logger = new Logger(EpisodeSyncSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: SeriesRefreshOrchestratorService,
  ) {}

  @Interval(Number(process.env.SYNC_SCHEDULER_TICK_INTERVAL_MS) || DEFAULT_TICK_INTERVAL_MS)
  async handleTick(): Promise<void> {
    await this.runTick();
  }

  @Interval(Number(process.env.LOCAL_RELEASE_ACTIVATION_INTERVAL_MS) || DEFAULT_LOCAL_ACTIVATION_INTERVAL_MS)
  async handleLocalActivationTick(): Promise<void> {
    await this.runLocalActivationTick();
  }

  // Exposed separately from the @Interval-decorated handler so tests can
  // invoke exactly the same tick logic without waiting for the interval to
  // fire — same "one implementation, multiple entry points" posture as
  // refreshOneSeries/refreshSeriesForUser themselves. userId defaults to
  // DEV_USER_ID (this app's single tracked user today, same convention
  // every other run-*.ts CLI script already uses) but is a real parameter
  // so a test can point this at a disposable fixture user.
  async runTick(userId: string = DEV_USER_ID, now: Date = new Date()): Promise<SyncTickResult> {
    if (!process.env.TMDB_ACCESS_TOKEN) {
      this.logger.warn('Skipping sync tick — TMDB_ACCESS_TOKEN is not configured.');
      return { checked: 0, refreshed: 0, blockedManualReview: 0, errored: 0, alreadyInProgress: 0 };
    }

    const dueSeriesIds = await this.loadDueSeriesIds(userId, now);
    const result: SyncTickResult = { checked: dueSeriesIds.length, refreshed: 0, blockedManualReview: 0, errored: 0, alreadyInProgress: 0 };

    // Sequential, not parallel — matches every other pipeline loop in this
    // codebase: predictable TMDb request volume, and one series' failure
    // can never race/corrupt another's write.
    for (const seriesId of dueSeriesIds) {
      try {
        const outcome = await this.orchestrator.refreshSeriesForUser(userId, seriesId, SyncTrigger.SCHEDULED);
        if (outcome.kind === 'refreshed') {
          if (outcome.requiresManualReview) result.blockedManualReview++;
          else result.refreshed++;
        } else if (outcome.kind === 'error') {
          result.errored++;
        } else if (outcome.kind === 'already-in-progress') {
          // A manual refresh (or a stale-on-open check) is already handling
          // this series right now — the scheduler defers to it rather than
          // racing it (Part 5.7).
          result.alreadyInProgress++;
        }
      } catch (err) {
        result.errored++;
        this.logger.error(`[sync-scheduler] unexpected error processing series ${seriesId}`, err as Error);
      }
    }

    return result;
  }

  // The hourly, provider-free pass (Part 2B) — every user's whole library,
  // not gated on due-ness the way the provider tick is (local activation
  // has no external cost to ration, so it simply runs and is a no-op for
  // anything that doesn't need it — see local-release-activation.ts's
  // idempotency guarantee).
  async runLocalActivationTick(userId: string = DEV_USER_ID): Promise<LocalReleaseActivationSummary> {
    const summary = await runLocalReleaseActivation(this.prisma as unknown as PrismaClient, userId);
    if (summary.activatedCount > 0 || summary.errorCount > 0) {
      this.logger.log(
        `[local-release-activation] inspected=${summary.candidatesInspected}, activated=${summary.activatedCount}, manualReview=${summary.manualReviewCount}, errors=${summary.errorCount}`,
      );
    }
    return summary;
  }

  // Lightweight — only what's needed to decide due-ness (checkSeriesEligibility
  // + isRefreshDue). The orchestrator itself loads everything a real
  // refresh attempt needs, so this no longer preloads episodes/watches the
  // way the pre-refactor version did.
  private async loadDueSeriesIds(userId: string, now: Date): Promise<string[]> {
    const progresses = await this.prisma.userSeriesProgress.findMany({
      where: { userId },
      select: {
        userStatus: true,
        seriesId: true,
        series: {
          select: {
            title: true,
            externalIds: { select: { tmdbId: true } },
            syncStatus: { select: { nextEligibleRefreshAt: true } },
          },
        },
      },
    });

    const due: string[] = [];
    for (const p of progresses) {
      const tmdbId = p.series.externalIds?.tmdbId ?? null;
      const eligibility = checkSeriesEligibility({ userStatus: p.userStatus, tmdbId, title: p.series.title });
      if (!eligibility.eligible) continue;

      const status: UserSeriesStatus = p.userStatus;
      if (!isRefreshDue({ status, nextEligibleRefreshAt: p.series.syncStatus?.nextEligibleRefreshAt ?? null, now })) continue;

      due.push(p.seriesId);
    }
    return due;
  }
}
