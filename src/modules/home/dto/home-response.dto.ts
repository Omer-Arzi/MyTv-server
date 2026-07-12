import { ApiProperty } from '@nestjs/swagger';
import { RecentlyWatchedItemDto } from '../../me/dto/recently-watched-item.dto';
import { WatchNextItemDto } from '../../me/dto/watch-next-item.dto';
import { StaleSeriesItemDto } from '../../me/dto/stale-series-item.dto';
import { HavenStartedYetItemDto } from '../../me/dto/haven-started-yet-item.dto';

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

  @ApiProperty({ type: [HavenStartedYetItemDto], description: 'Watchlisted series with real, released content ready to start — see GET /me/havent-started-yet.' })
  haventStartedYet: HavenStartedYetItemDto[];
}
