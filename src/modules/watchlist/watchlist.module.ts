import { Module } from '@nestjs/common';
import { WatchlistController } from './watchlist.controller';
import { SeriesController } from './series.controller';
import { WatchlistService } from './watchlist.service';

@Module({
  controllers: [WatchlistController, SeriesController],
  providers: [WatchlistService],
})
export class WatchlistModule {}
