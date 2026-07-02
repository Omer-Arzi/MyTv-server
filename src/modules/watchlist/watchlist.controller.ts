import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types';
import { WatchlistService } from './watchlist.service';
import { WatchlistItemDto } from './dto/watchlist-item.dto';

@ApiTags('watchlist')
@Controller('watchlist')
export class WatchlistController {
  constructor(private readonly watchlistService: WatchlistService) {}

  @Get()
  @ApiOperation({
    summary: 'List the current user\'s watchlist',
    description: 'Series the user wants to watch, most recently added first.',
  })
  @ApiOkResponse({ type: WatchlistItemDto, isArray: true })
  list(@CurrentUser() user: RequestUser): Promise<WatchlistItemDto[]> {
    return this.watchlistService.list(user.id);
  }
}
