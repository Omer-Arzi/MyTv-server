import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types';
import { MeService } from './me.service';
import { RecentlyWatchedQueryDto } from './dto/recently-watched-query.dto';
import { StaleSeriesQueryDto } from './dto/stale-series-query.dto';
import { RecentlyWatchedPageDto } from './dto/recently-watched-item.dto';
import { WatchNextItemDto } from './dto/watch-next-item.dto';
import { StaleSeriesItemDto } from './dto/stale-series-item.dto';

@ApiTags('me')
@Controller('me')
export class MeController {
  constructor(private readonly meService: MeService) {}

  @Get('recently-watched')
  @ApiOperation({
    summary: 'Recently watched episodes',
    description:
      'Latest watched episodes for the current user, newest first. Supports cursor pagination via "before" to load older pages.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({ name: 'before', required: false, type: String, description: 'Cursor from a previous nextCursor' })
  @ApiOkResponse({ type: RecentlyWatchedPageDto })
  getRecentlyWatched(
    @CurrentUser() user: RequestUser,
    @Query() query: RecentlyWatchedQueryDto,
  ): Promise<RecentlyWatchedPageDto> {
    return this.meService.getRecentlyWatched(user.id, query.limit, query.before);
  }

  @Get('watch-next')
  @ApiOperation({
    summary: 'Series currently being watched, with their next episode',
    description:
      'One entry per in-progress series, each with the cached next episode to watch. Excludes anything that has ' +
      'gone stale (lastWatchedAt older than 90 days) — that\'s /me/stale-series\' job instead; the two sections are ' +
      'mutually exclusive.',
  })
  @ApiOkResponse({ type: WatchNextItemDto, isArray: true })
  getWatchNext(@CurrentUser() user: RequestUser): Promise<WatchNextItemDto[]> {
    return this.meService.getWatchNext(user.id);
  }

  @Get('stale-series')
  @ApiOperation({
    summary: 'Watched series that have gone stale',
    description:
      'Series actively being watched (userStatus WATCHING, with a real released next episode — same trust gate as ' +
      '/me/watch-next, plus known episode-numbering/season-shift risk exclusions) whose lastWatchedAt is older than ' +
      '"afterDays" days.',
  })
  @ApiQuery({ name: 'afterDays', required: false, type: Number, example: 90 })
  @ApiOkResponse({ type: StaleSeriesItemDto, isArray: true })
  getStaleSeries(
    @CurrentUser() user: RequestUser,
    @Query() query: StaleSeriesQueryDto,
  ): Promise<StaleSeriesItemDto[]> {
    return this.meService.getStaleSeries(user.id, query.afterDays);
  }
}
