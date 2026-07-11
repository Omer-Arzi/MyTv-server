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
    summary: 'List the current user\'s active library',
    description:
      'The Watchlist tab\'s data: series the user is currently watching, actively following (caught up, waiting on ' +
      'new episodes), or planning to start — i.e. userStatus WATCHING, CAUGHT_UP, or WATCHLIST only. PAUSED/DROPPED/' +
      'COMPLETED/UNKNOWN series are intentionally excluded (available via GET /series, the Library tab, instead). ' +
      'Sorted alphabetically by title. Clients group into Watching/Caught Up/Watchlist sections using each item\'s ' +
      'userStatus; the array itself is flat and already correctly ordered within whatever grouping is applied.',
  })
  @ApiOkResponse({ type: WatchlistItemDto, isArray: true })
  list(@CurrentUser() user: RequestUser): Promise<WatchlistItemDto[]> {
    return this.watchlistService.list(user.id);
  }
}
