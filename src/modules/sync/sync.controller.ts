import { Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SyncTrigger } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types';
import { PrismaService } from '../../prisma/prisma.service';
import { SeriesRefreshOrchestratorService, SeriesRefreshOutcome, SeriesSyncStatusSnapshot } from './series-refresh-orchestrator.service';
import { LibraryRefreshJobService } from './library-refresh-job.service';
import { LibraryRefreshJobDto, LibraryRefreshStatusDto } from './dto/library-refresh-job.dto';
import { SeriesRefreshResultDto, SeriesSyncStatusDto } from './dto/series-sync-status.dto';

function toSyncStatusDto(snapshot: SeriesSyncStatusSnapshot): SeriesSyncStatusDto {
  return {
    lastCheckedAt: snapshot.lastEpisodeRefreshAt?.toISOString() ?? null,
    lastSuccessfulCheckAt: snapshot.lastSuccessfulRefreshAt?.toISOString() ?? null,
    nextEligibleCheckAt: snapshot.nextEligibleRefreshAt?.toISOString() ?? null,
    refreshInProgress: snapshot.refreshInProgress,
    lastChangeAt: snapshot.lastChangeAt?.toISOString() ?? null,
    lastEpisodesAdded: snapshot.lastEpisodesAdded,
    lastSeasonsAdded: snapshot.lastSeasonsAdded,
    requiresManualReview: snapshot.lastRequiresManualReview,
    lastLocalActivationAt: snapshot.lastLocalActivationAt?.toISOString() ?? null,
  };
}

const EMPTY_SYNC_STATUS: SeriesSyncStatusDto = {
  lastCheckedAt: null,
  lastSuccessfulCheckAt: null,
  nextEligibleCheckAt: null,
  refreshInProgress: false,
  lastChangeAt: null,
  lastEpisodesAdded: null,
  lastSeasonsAdded: null,
  requiresManualReview: false,
  lastLocalActivationAt: null,
};

// User-safe messages only (Part 11) — never a raw provider/SQL error.
function toRefreshResultDto(outcome: SeriesRefreshOutcome): SeriesRefreshResultDto {
  switch (outcome.kind) {
    case 'not-tracked':
      return { outcome: 'not-tracked', message: 'This series is not in your library.', syncStatus: EMPTY_SYNC_STATUS };
    case 'ineligible':
      return { outcome: 'ineligible', message: 'This series cannot be checked for updates yet.', syncStatus: EMPTY_SYNC_STATUS };
    case 'already-in-progress':
      return { outcome: 'already-in-progress', message: 'Already checking for updates.', syncStatus: toSyncStatusDto(outcome.syncStatus) };
    case 'not-stale':
      return { outcome: 'not-stale', message: 'Up to date.', syncStatus: toSyncStatusDto(outcome.syncStatus) };
    case 'error':
      return { outcome: 'error', message: 'Could not check for updates. Please try again later.', syncStatus: EMPTY_SYNC_STATUS };
    case 'refreshed': {
      const message =
        outcome.episodesAdded > 0 || outcome.seasonsAdded > 0
          ? `Updated — ${outcome.episodesAdded} new episode${outcome.episodesAdded === 1 ? '' : 's'}${outcome.seasonsAdded > 0 ? `, ${outcome.seasonsAdded} new season${outcome.seasonsAdded === 1 ? '' : 's'}` : ''}.`
          : outcome.requiresManualReview
            ? 'Some changes need review before they can be applied.'
            : 'No updates found.';
      return { outcome: 'refreshed', message, syncStatus: toSyncStatusDto(outcome.syncStatus) };
    }
  }
}

function toLibraryJobDto(job: { id: string; status: string; startedAt: Date; finishedAt: Date | null; totalSeries: number; checkedSeries: number; seriesWithNewEpisodes: number; seriesWithNewSeasons: number; seriesFailed: number; seriesManualReview: number; seriesActivatedLocally: number; lastError: string | null }): LibraryRefreshJobDto {
  return {
    id: job.id,
    status: job.status as LibraryRefreshJobDto['status'],
    startedAt: job.startedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    totalSeries: job.totalSeries,
    checkedSeries: job.checkedSeries,
    seriesWithNewEpisodes: job.seriesWithNewEpisodes,
    seriesWithNewSeasons: job.seriesWithNewSeasons,
    seriesFailed: job.seriesFailed,
    seriesManualReview: job.seriesManualReview,
    seriesActivatedLocally: job.seriesActivatedLocally,
    // User-safe only — never the raw provider/SQL message this field may
    // carry internally (Part 11).
    lastError: job.lastError ? 'Some series could not be checked.' : null,
  };
}

@ApiTags('sync')
@Controller('sync')
export class SyncController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: SeriesRefreshOrchestratorService,
    private readonly libraryRefreshJobService: LibraryRefreshJobService,
  ) {}

  @Post('library/refresh')
  @ApiOperation({
    summary: 'Start a manual full-library "check for updates" run',
    description:
      'Idempotent/cooldown-protected: if a refresh is already running for this user, returns that existing job instead of starting a duplicate. ' +
      'Prioritizes WATCHING/CAUGHT_UP and series with an overdue or soon-due known episode. Uses the same per-series pipeline as the scheduler — never a separate, unsafe write path. ' +
      'Also runs local release activation (no provider calls) across the whole library once the per-series pass completes. Runs in the background — poll GET /sync/library/status for progress.',
  })
  @ApiOkResponse({ type: LibraryRefreshJobDto })
  async startLibraryRefresh(@CurrentUser() user: RequestUser): Promise<LibraryRefreshJobDto> {
    const job = await this.libraryRefreshJobService.startLibraryRefresh(user.id, SyncTrigger.MANUAL_LIBRARY);
    return toLibraryJobDto(job);
  }

  @Get('library/status')
  @ApiOperation({ summary: 'Current/most recent full-library refresh job status, plus library-wide automatic-sync facts' })
  @ApiOkResponse({ type: LibraryRefreshStatusDto })
  async getLibraryStatus(@CurrentUser() user: RequestUser): Promise<LibraryRefreshStatusDto> {
    const [latestJob, aggregates] = await Promise.all([this.libraryRefreshJobService.getLatestJobStatus(user.id), this.loadLibraryAggregates(user.id)]);
    return {
      latestJob: latestJob ? toLibraryJobDto(latestJob) : null,
      automaticUpdatesEnabled: true,
      lastAutomaticCheckAt: aggregates.lastAutomaticCheckAt,
      lastLocalActivationAt: aggregates.lastLocalActivationAt,
    };
  }

  @Post('series/:seriesId/refresh')
  @ApiOperation({
    summary: 'Manually check one series for new episodes/seasons',
    description:
      'Always runs (never gated on staleness) — an explicit user request. Uses the exact same per-series pipeline as every other update path. ' +
      'If the scheduler (or another manual/stale-on-open request) is already refreshing this series, returns that in-progress status rather than starting a duplicate.',
  })
  @ApiOkResponse({ type: SeriesRefreshResultDto })
  async refreshSeries(@CurrentUser() user: RequestUser, @Param('seriesId') seriesId: string): Promise<SeriesRefreshResultDto> {
    await this.assertSeriesExists(seriesId);
    const outcome = await this.orchestrator.refreshSeriesForUser(user.id, seriesId, SyncTrigger.MANUAL_SERIES);
    return toRefreshResultDto(outcome);
  }

  @Post('series/:seriesId/refresh-if-stale')
  @ApiOperation({
    summary: 'Background, non-blocking refresh — only runs if the series is actually stale (Part 8: series-page open)',
    description:
      'Called by the mobile client right after a series page renders from local data. A no-op (outcome: "not-stale") if the series was checked recently enough per the smart scheduling policy. ' +
      'Never blocks the page render — the client calls this fire-and-forget and refetches series detail afterward if it reports a real refresh happened.',
  })
  @ApiOkResponse({ type: SeriesRefreshResultDto })
  async refreshSeriesIfStale(@CurrentUser() user: RequestUser, @Param('seriesId') seriesId: string): Promise<SeriesRefreshResultDto> {
    await this.assertSeriesExists(seriesId);
    const outcome = await this.orchestrator.refreshSeriesForUser(user.id, seriesId, SyncTrigger.SERIES_PAGE_STALE, { onlyIfStale: true });
    return toRefreshResultDto(outcome);
  }

  @Get('series/:seriesId/status')
  @ApiOperation({ summary: 'Current per-series sync status' })
  @ApiOkResponse({ type: SeriesSyncStatusDto })
  async getSeriesStatus(@CurrentUser() user: RequestUser, @Param('seriesId') seriesId: string): Promise<SeriesSyncStatusDto> {
    await this.assertSeriesExists(seriesId);
    // Ownership check — only ever reads this user's own progress row's
    // existence, matching refreshSeriesForUser's own "not-tracked" gate
    // (never trusts a bare seriesId as proof this user may see its status).
    const progress = await this.prisma.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId: user.id, seriesId } } });
    if (!progress) return EMPTY_SYNC_STATUS;

    const status = await this.prisma.seriesSyncStatus.findUnique({ where: { seriesId } });
    if (!status) return EMPTY_SYNC_STATUS;
    return toSyncStatusDto({
      lastEpisodeRefreshAt: status.lastEpisodeRefreshAt,
      lastEpisodeRefreshStatus: status.lastEpisodeRefreshStatus,
      lastSuccessfulRefreshAt: status.lastSuccessfulRefreshAt,
      nextEligibleRefreshAt: status.nextEligibleRefreshAt,
      refreshInProgress: status.refreshInProgress,
      lastRefreshTrigger: status.lastRefreshTrigger,
      lastChangeAt: status.lastChangeAt,
      lastEpisodesAdded: status.lastEpisodesAdded,
      lastSeasonsAdded: status.lastSeasonsAdded,
      lastRequiresManualReview: status.lastRequiresManualReview,
      lastLocalActivationAt: status.lastLocalActivationAt,
    });
  }

  private async assertSeriesExists(seriesId: string): Promise<void> {
    const series = await this.prisma.series.findUnique({ where: { id: seriesId }, select: { id: true } });
    if (!series) throw new NotFoundException(`Series ${seriesId} not found`);
  }

  private async loadLibraryAggregates(userId: string): Promise<{ lastAutomaticCheckAt: string | null; lastLocalActivationAt: string | null }> {
    const rows = await this.prisma.seriesSyncStatus.findMany({
      where: { series: { progress: { some: { userId } } } },
      select: { lastEpisodeRefreshAt: true, lastLocalActivationAt: true },
    });
    const lastAutomaticCheckAt = rows.reduce<Date | null>((max, r) => (r.lastEpisodeRefreshAt && (!max || r.lastEpisodeRefreshAt > max) ? r.lastEpisodeRefreshAt : max), null);
    const lastLocalActivationAt = rows.reduce<Date | null>((max, r) => (r.lastLocalActivationAt && (!max || r.lastLocalActivationAt > max) ? r.lastLocalActivationAt : max), null);
    return { lastAutomaticCheckAt: lastAutomaticCheckAt?.toISOString() ?? null, lastLocalActivationAt: lastLocalActivationAt?.toISOString() ?? null };
  }
}
