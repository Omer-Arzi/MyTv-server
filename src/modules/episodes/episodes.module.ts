import { Module } from '@nestjs/common';
import { EpisodesController } from './episodes.controller';
import { EpisodeWatchesController } from './episode-watches.controller';
import { SeasonWatchController } from './season-watch.controller';
import { EpisodeWatchService } from './episode-watch.service';

@Module({
  controllers: [EpisodesController, EpisodeWatchesController, SeasonWatchController],
  providers: [EpisodeWatchService],
  // SeriesModule (POST /series/:seriesId/watch-all-released) needs EpisodeWatchService.
  exports: [EpisodeWatchService],
})
export class EpisodesModule {}
