import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBody, ApiCreatedResponse, ApiNoContentResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types';
import { WatchlistService } from '../watchlist/watchlist.service';
import { WatchlistItemDto } from '../watchlist/dto/watchlist-item.dto';
import { EpisodeWatchService } from '../episodes/episode-watch.service';
import { WatchAllRequestDto } from '../episodes/dto/watch-all-request.dto';
import { WatchAllResponseDto } from '../episodes/dto/watch-all-response.dto';
import { SeriesService } from './series.service';
import { SeriesDetailDto } from './dto/series-detail.dto';
import { SeriesListPageDto } from './dto/series-list-page.dto';
import { SeriesListQueryDto } from './dto/series-list-query.dto';
import { UpdateSeriesStatusDto } from './dto/update-series-status.dto';
import { UpdateSeriesStatusResponseDto } from './dto/update-series-status-response.dto';

@ApiTags('series')
@Controller('series')
export class SeriesController {
  constructor(
    private readonly seriesService: SeriesService,
    private readonly watchlistService: WatchlistService,
    private readonly episodeWatchService: EpisodeWatchService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Browse the current user\'s series library',
    description:
      'Every series the current user has any relationship with (watchlisted, watching, paused, dropped, caught up, ' +
      'or completed), optionally filtered by personal status, public release status, or a title search. Cursor-paginated.',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['WATCHLIST', 'WATCHING', 'PAUSED', 'DROPPED', 'CAUGHT_UP', 'COMPLETED', 'UNKNOWN'] })
  @ApiQuery({ name: 'releaseStatus', required: false, enum: ['UNKNOWN', 'RETURNING', 'ENDED', 'CANCELLED', 'IN_PRODUCTION'] })
  @ApiQuery({ name: 'q', required: false, type: String, description: 'Case-insensitive title search' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiOkResponse({ type: SeriesListPageDto })
  list(@CurrentUser() user: RequestUser, @Query() query: SeriesListQueryDto): Promise<SeriesListPageDto> {
    return this.seriesService.list(user.id, { status: query.status, releaseStatus: query.releaseStatus, q: query.q }, query.limit, query.cursor);
  }

  @Get(':seriesId')
  @ApiOperation({
    summary: 'Get full series detail',
    description:
      'Everything a series-detail screen needs in one call: metadata, this user\'s status and next episode, every ' +
      'season/episode with per-episode watch state, and provider ids if a match has been applied.',
  })
  @ApiParam({ name: 'seriesId', description: 'Series id', example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  @ApiOkResponse({ type: SeriesDetailDto })
  @ApiNotFoundResponse({ description: 'Series not found' })
  getDetail(@CurrentUser() user: RequestUser, @Param('seriesId') seriesId: string): Promise<SeriesDetailDto> {
    return this.seriesService.getDetail(user.id, seriesId);
  }

  @Patch(':seriesId/status')
  @ApiOperation({
    summary: 'Manually set my personal status for a series',
    description:
      'Only WATCHING, PAUSED, DROPPED, and WATCHLIST can be set directly — COMPLETED and CAUGHT_UP are always ' +
      'auto-derived (400 if requested). PAUSED/DROPPED preserve nextEpisodeId as-is (not recomputed while paused/ ' +
      'dropped, but kept accurate for an immediate, correct resume) and never touch watch history. Requesting ' +
      'WATCHING (also how "resume watching" from PAUSED/DROPPED works) re-derives the true resulting status from ' +
      'this user\'s currently-known episode catalog — WATCHING if an unwatched released episode exists, else ' +
      'CAUGHT_UP (series still airing) or COMPLETED (series ended/cancelled); the response userStatus reflects ' +
      'that derived value, not necessarily WATCHING. WATCHLIST clears nextEpisodeId and ensures a WatchlistItem ' +
      'exists, so GET /watchlist stays consistent.',
  })
  @ApiParam({ name: 'seriesId', description: 'Series id', example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  @ApiBody({ type: UpdateSeriesStatusDto })
  @ApiOkResponse({ type: UpdateSeriesStatusResponseDto })
  @ApiNotFoundResponse({ description: 'Series not found' })
  updateStatus(
    @CurrentUser() user: RequestUser,
    @Param('seriesId') seriesId: string,
    @Body() body: UpdateSeriesStatusDto,
  ): Promise<UpdateSeriesStatusResponseDto> {
    return this.seriesService.updateStatus(user.id, seriesId, body.userStatus);
  }

  @Post(':seriesId/watchlist')
  @ApiOperation({
    summary: 'Add a series to the watchlist',
    description: 'Idempotent: adding a series that is already on the watchlist returns the existing entry.',
  })
  @ApiParam({ name: 'seriesId', description: 'Series id', example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  @ApiCreatedResponse({ type: WatchlistItemDto, description: 'Series added to the watchlist' })
  @ApiNotFoundResponse({ description: 'Series not found' })
  addToWatchlist(
    @CurrentUser() user: RequestUser,
    @Param('seriesId') seriesId: string,
  ): Promise<WatchlistItemDto> {
    return this.watchlistService.add(user.id, seriesId);
  }

  @Delete(':seriesId/watchlist')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a series from the watchlist' })
  @ApiParam({ name: 'seriesId', description: 'Series id', example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  @ApiNoContentResponse({ description: 'Series removed from the watchlist' })
  @ApiNotFoundResponse({ description: 'Series is not in the watchlist' })
  removeFromWatchlist(
    @CurrentUser() user: RequestUser,
    @Param('seriesId') seriesId: string,
  ): Promise<void> {
    return this.watchlistService.remove(user.id, seriesId);
  }

  @Post(':seriesId/watch-all-released')
  @ApiOperation({
    summary: 'Mark every released episode in this series as watched',
    description:
      'Manual escape hatch for provider-numbering/duplicate-episode issues (see ' +
      'docs/episode-numbering-and-season-shift-risk.md) — lets a user who knows they\'ve already watched ' +
      'everything actually released skip per-episode cleanup, across every season at once. Only creates ' +
      'EpisodeWatch rows for episodes whose airDate is today or earlier; existing watches are never touched. ' +
      'Pass dryRun: true to preview without writing.',
  })
  @ApiParam({ name: 'seriesId', description: 'Series id', example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  @ApiBody({ type: WatchAllRequestDto })
  @ApiOkResponse({ type: WatchAllResponseDto })
  @ApiNotFoundResponse({ description: 'Series not found' })
  @ApiBadRequestResponse({ description: 'userStatus is DROPPED or PAUSED and force was not set to true' })
  watchAllReleased(
    @CurrentUser() user: RequestUser,
    @Param('seriesId') seriesId: string,
    @Body() body: WatchAllRequestDto,
  ): Promise<WatchAllResponseDto> {
    return this.episodeWatchService.markSeriesReleasedWatched(user.id, seriesId, body);
  }
}
