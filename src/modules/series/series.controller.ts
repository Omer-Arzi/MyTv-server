import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types';
import { WatchlistService } from '../watchlist/watchlist.service';
import { WatchlistItemDto } from '../watchlist/dto/watchlist-item.dto';
import { SeriesService } from './series.service';
import { SeriesDetailDto } from './dto/series-detail.dto';
import { SeriesListPageDto } from './dto/series-list-page.dto';
import { SeriesListQueryDto } from './dto/series-list-query.dto';

@ApiTags('series')
@Controller('series')
export class SeriesController {
  constructor(
    private readonly seriesService: SeriesService,
    private readonly watchlistService: WatchlistService,
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
}
