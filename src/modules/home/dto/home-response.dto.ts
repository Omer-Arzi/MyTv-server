import { ApiProperty } from '@nestjs/swagger';
import { RecentlyWatchedItemDto } from '../../me/dto/recently-watched-item.dto';
import { WatchNextItemDto } from '../../me/dto/watch-next-item.dto';
import { StaleSeriesItemDto } from '../../me/dto/stale-series-item.dto';

export class HomeResponseDto {
  @ApiProperty({
    type: [RecentlyWatchedItemDto],
    description: 'Latest watched episodes, capped at 10. Use GET /me/recently-watched to paginate further.',
  })
  recentlyWatched: RecentlyWatchedItemDto[];

  @ApiProperty({ type: [WatchNextItemDto] })
  watchNext: WatchNextItemDto[];

  @ApiProperty({ type: [StaleSeriesItemDto] })
  staleSeries: StaleSeriesItemDto[];
}
