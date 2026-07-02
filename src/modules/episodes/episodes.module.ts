import { Module } from '@nestjs/common';
import { EpisodesController } from './episodes.controller';
import { EpisodeWatchesController } from './episode-watches.controller';
import { EpisodeWatchService } from './episode-watch.service';

@Module({
  controllers: [EpisodesController, EpisodeWatchesController],
  providers: [EpisodeWatchService],
})
export class EpisodesModule {}
