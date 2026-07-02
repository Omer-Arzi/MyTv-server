import { Controller, Delete, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiNotFoundResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types';
import { WatchlistService } from './watchlist.service';
import { WatchlistItemDto } from './dto/watchlist-item.dto';

@ApiTags('series')
@Controller('series')
export class SeriesController {
  constructor(private readonly watchlistService: WatchlistService) {}

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
