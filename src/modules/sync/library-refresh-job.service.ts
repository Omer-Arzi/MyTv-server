// Manual full-library refresh (Part 6). Orchestrates the SAME per-series
// pipeline every other update path uses (SeriesRefreshOrchestratorService)
// across every eligible series in the user's library, tracked via a
// LibraryRefreshJob row the client polls for progress (Part 10 — "do not
// make the client poll excessively": the job row is cheap to read, and the
// mobile client is expected to poll it at a modest interval while a job is
// RUNNING, never on every render).
//
// Cooldown/dedup (Part 6's "Use a reasonable cooldown and return the
// currently running job when applicable instead of creating duplicates"):
// enforced by checking for an existing RUNNING job for this user before
// creating a new one. This is a read-then-create check, not a DB-level
// unique constraint — a real (if narrow) race window exists if two
// requests land within the same tick of each other. Acceptable for this
// app's actual scale (a single real user tapping one button) and
// documented here rather than silently assumed away; a stricter guarantee
// would need a partial unique index (`WHERE status = 'RUNNING'`), which
// Prisma's schema DSL cannot express directly — noted as a known
// limitation in the final report, not implemented speculatively.
import { Injectable, Logger } from '@nestjs/common';
import { LibraryRefreshJob, SyncTrigger, UserSeriesStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PrismaClient } from '@prisma/client';
import { checkSeriesEligibility } from '../../../episode-release-refresh/refresh-logic';
import { computeEpisodeUrgency } from '../../common/release-date-policy';
import { prioritizeSeriesForLibraryRefresh } from '../../../episode-release-refresh/library-refresh-priority';
import { runLocalReleaseActivation } from '../../../episode-release-refresh/local-release-activation';
import { SeriesRefreshOrchestratorService } from './series-refresh-orchestrator.service';

@Injectable()
export class LibraryRefreshJobService {
  private readonly logger = new Logger(LibraryRefreshJobService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: SeriesRefreshOrchestratorService,
  ) {}

  async startLibraryRefresh(userId: string, triggeredBy: SyncTrigger = SyncTrigger.MANUAL_LIBRARY): Promise<LibraryRefreshJob> {
    const existing = await this.prisma.libraryRefreshJob.findFirst({ where: { userId, status: 'RUNNING' }, orderBy: { startedAt: 'desc' } });
    if (existing) {
      this.logger.log(`[sync] library refresh already running for user ${userId} (job ${existing.id}) — returning existing job, not starting a new one`);
      return existing;
    }

    const candidateIds = await this.loadPrioritizedCandidateIds(userId);
    const job = await this.prisma.libraryRefreshJob.create({ data: { userId, triggeredBy, totalSeries: candidateIds.length } });

    // Fire-and-forget — the caller (controller) returns immediately with
    // the job row; progress is polled via getLatestJobStatus, not awaited
    // here. Errors inside processJob are caught per-series and recorded on
    // the job row, never thrown out of this unawaited call.
    void this.processJob(job.id, userId, candidateIds);

    return job;
  }

  async getLatestJobStatus(userId: string): Promise<LibraryRefreshJob | null> {
    return this.prisma.libraryRefreshJob.findFirst({ where: { userId }, orderBy: { startedAt: 'desc' } });
  }

  private async loadPrioritizedCandidateIds(userId: string): Promise<string[]> {
    const now = new Date();
    const progress = await this.prisma.userSeriesProgress.findMany({
      where: { userId, userStatus: { not: UserSeriesStatus.UNKNOWN } },
      include: { series: { include: { externalIds: true, seasons: { include: { episodes: { select: { airDate: true } } } } } } },
    });

    const candidates = progress
      .map((p) => {
        const tmdbId = p.series.externalIds?.tmdbId ?? null;
        const eligibility = checkSeriesEligibility({ userStatus: p.userStatus, tmdbId, title: p.series.title });
        if (!eligibility.eligible) return null;

        const upcoming = p.series.seasons
          .flatMap((s) => s.episodes)
          .map((e) => e.airDate)
          .filter((d): d is Date => d !== null && d.getTime() > now.getTime())
          .sort((a, b) => a.getTime() - b.getTime())[0];

        const urgency = computeEpisodeUrgency({ releaseStatus: p.series.releaseStatus, nextKnownUpcomingAirDate: upcoming ?? null, now });
        return { seriesId: p.seriesId, userStatus: p.userStatus, urgency };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    return prioritizeSeriesForLibraryRefresh(candidates);
  }

  private async processJob(jobId: string, userId: string, seriesIds: string[]): Promise<void> {
    let checkedSeries = 0;
    let seriesWithNewEpisodes = 0;
    let seriesWithNewSeasons = 0;
    let seriesFailed = 0;
    let seriesManualReview = 0;
    let lastError: string | null = null;

    // Sequential, not parallel — matches every other pipeline loop in this
    // codebase (run-apply-refresh.ts, episode-sync-scheduler.service.ts):
    // predictable provider request volume, and one series' failure can
    // never race/corrupt another's write.
    for (const seriesId of seriesIds) {
      try {
        const outcome = await this.orchestrator.refreshSeriesForUser(userId, seriesId, SyncTrigger.MANUAL_LIBRARY);
        if (outcome.kind === 'refreshed') {
          if (outcome.episodesAdded > 0) seriesWithNewEpisodes++;
          if (outcome.seasonsAdded > 0) seriesWithNewSeasons++;
          if (outcome.requiresManualReview) seriesManualReview++;
          if (outcome.providerError) {
            seriesFailed++;
          }
        } else if (outcome.kind === 'error') {
          seriesFailed++;
          lastError = outcome.message;
        }
        // 'already-in-progress' (the scheduler or a stale-on-open refresh
        // is already handling this series right now) is deliberately NOT
        // counted as a failure — it will simply reflect whatever that
        // other run finds; this job doesn't wait for it (Part 5.7: a
        // manual run does not overlap/duplicate an in-flight refresh of
        // the same series).
      } catch (err) {
        seriesFailed++;
        lastError = (err as Error).message;
        this.logger.error(`[sync] library refresh job ${jobId} — unexpected error on series ${seriesId}`, err as Error);
      }

      checkedSeries++;
      await this.prisma.libraryRefreshJob.update({
        where: { id: jobId },
        data: { checkedSeries, seriesWithNewEpisodes, seriesWithNewSeasons, seriesFailed, seriesManualReview, lastError },
      });
    }

    let seriesActivatedLocally = 0;
    try {
      const activation = await runLocalReleaseActivation(this.prisma as unknown as PrismaClient, userId);
      seriesActivatedLocally = activation.activatedCount;
    } catch (err) {
      this.logger.error(`[sync] library refresh job ${jobId} — local release activation pass failed`, err as Error);
    }

    await this.prisma.libraryRefreshJob.update({
      where: { id: jobId },
      data: { status: seriesFailed > 0 ? 'PARTIAL' : 'COMPLETED', finishedAt: new Date(), seriesActivatedLocally },
    });

    this.logger.log(
      `[sync] library refresh job ${jobId} complete — checked=${checkedSeries}/${seriesIds.length}, newEpisodes=${seriesWithNewEpisodes}, newSeasons=${seriesWithNewSeasons}, failed=${seriesFailed}, manualReview=${seriesManualReview}, activatedLocally=${seriesActivatedLocally}`,
    );
  }
}
