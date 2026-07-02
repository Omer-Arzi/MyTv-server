import { Injectable } from '@nestjs/common';
import { MeService } from '../me/me.service';
import { HomeResponseDto } from './dto/home-response.dto';

const HOME_RECENTLY_WATCHED_LIMIT = 10;
const HOME_STALE_AFTER_DAYS = 30;

@Injectable()
export class HomeService {
  constructor(private readonly meService: MeService) {}

  async getHome(userId: string): Promise<HomeResponseDto> {
    const [recentlyWatchedPage, watchNext, staleSeries] = await Promise.all([
      this.meService.getRecentlyWatched(userId, HOME_RECENTLY_WATCHED_LIMIT),
      this.meService.getWatchNext(userId),
      this.meService.getStaleSeries(userId, HOME_STALE_AFTER_DAYS),
    ]);

    return {
      recentlyWatched: recentlyWatchedPage.items,
      watchNext,
      staleSeries,
    };
  }
}
