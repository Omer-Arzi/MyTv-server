import { Module } from '@nestjs/common';
import { WatchlistModule } from '../watchlist/watchlist.module';
import { SeriesController } from './series.controller';
import { SeriesService } from './series.service';

@Module({
  imports: [WatchlistModule],
  controllers: [SeriesController],
  providers: [SeriesService],
})
export class SeriesModule {}
