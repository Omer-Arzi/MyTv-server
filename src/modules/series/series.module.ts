import { Module } from '@nestjs/common';
import { WatchlistModule } from '../watchlist/watchlist.module';
import { EpisodesModule } from '../episodes/episodes.module';
import { SeriesController } from './series.controller';
import { SeriesService } from './series.service';

@Module({
  imports: [WatchlistModule, EpisodesModule],
  controllers: [SeriesController],
  providers: [SeriesService],
})
export class SeriesModule {}
