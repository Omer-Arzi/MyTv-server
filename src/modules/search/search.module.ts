import { Module } from '@nestjs/common';
import { WatchlistModule } from '../watchlist/watchlist.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [WatchlistModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
