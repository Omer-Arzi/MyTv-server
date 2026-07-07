import { Injectable } from '@nestjs/common';
import { DEFAULT_STALE_AFTER_DAYS } from '../../common/stale-series-trust';
import { MeService } from '../me/me.service';
import { HomeResponseDto } from './dto/home-response.dto';

const HOME_RECENTLY_WATCHED_LIMIT = 10;
// Kept in sync with StaleSeriesQueryDto's own default (and with
// MeService.getWatchNext's stale-exclusion cutoff) — /home should not
// silently use a different staleness threshold than the dedicated endpoint.
const HOME_STALE_AFTER_DAYS = DEFAULT_STALE_AFTER_DAYS;

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
