import { Module } from '@nestjs/common';
import { WatchlistController } from './watchlist.controller';
import { WatchlistService } from './watchlist.service';

@Module({
  controllers: [WatchlistController],
  providers: [WatchlistService],
  // SeriesModule (POST/DELETE /series/:id/watchlist) needs WatchlistService.
  exports: [WatchlistService],
})
export class WatchlistModule {}
