import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types';
import { HomeService } from './home.service';
import { HomeResponseDto } from './dto/home-response.dto';

@ApiTags('home')
@Controller('home')
export class HomeController {
  constructor(private readonly homeService: HomeService) {}

  @Get()
  @ApiOperation({
    summary: 'Home screen data',
    description:
      'Everything the home screen needs in one call: recently watched episodes (max 10), series being watched with their next episode, and series that have gone stale (no activity for 30+ days).',
  })
  @ApiOkResponse({
    type: HomeResponseDto,
    description: 'Home screen sections',
    example: {
      recentlyWatched: [
        {
          watchId: '3f6b1e2a-8c1d-4b2a-9e2e-555555555555',
          watchedAt: '2026-06-30T21:14:00.000Z',
          note: 'Great cliffhanger!',
          series: {
            id: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111',
            title: 'The Great Voyage',
            overview: 'A crew explores the outer rim of known space.',
            posterUrl: 'https://images.example.com/great-voyage/poster.jpg',
            releaseStatus: 'RETURNING',
          },
          episode: {
            id: '3f6b1e2a-8c1d-4b2a-9e2e-222222222222',
            seasonId: '3f6b1e2a-8c1d-4b2a-9e2e-333333333333',
            seasonNumber: 1,
            episodeNumber: 5,
            title: 'Into the Dark',
            overview: 'The crew loses contact with mission control.',
            airDate: '2024-03-10T00:00:00.000Z',
            runtimeMinutes: 42,
          },
        },
      ],
      watchNext: [
        {
          series: {
            id: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111',
            title: 'The Great Voyage',
            overview: 'A crew explores the outer rim of known space.',
            posterUrl: 'https://images.example.com/great-voyage/poster.jpg',
            releaseStatus: 'RETURNING',
          },
          nextEpisode: {
            id: '3f6b1e2a-8c1d-4b2a-9e2e-444444444444',
            seasonId: '3f6b1e2a-8c1d-4b2a-9e2e-333333333333',
            seasonNumber: 1,
            episodeNumber: 6,
            title: 'Signal Lost',
            overview: 'Repairs must be made before the next jump.',
            airDate: '2024-03-17T00:00:00.000Z',
            runtimeMinutes: 44,
          },
          lastWatchedAt: '2026-06-30T21:14:00.000Z',
          userStatus: 'WATCHING',
        },
      ],
      staleSeries: [
        {
          series: {
            id: '3f6b1e2a-8c1d-4b2a-9e2e-666666666666',
            title: 'Old Town Mysteries',
            overview: 'A detective duo solves cases in a sleepy coastal town.',
            posterUrl: 'https://images.example.com/old-town/poster.jpg',
            releaseStatus: 'ENDED',
          },
          lastWatchedAt: '2026-04-15T12:00:00.000Z',
          nextEpisode: {
            id: '3f6b1e2a-8c1d-4b2a-9e2e-777777777777',
            seasonId: '3f6b1e2a-8c1d-4b2a-9e2e-888888888888',
            seasonNumber: 2,
            episodeNumber: 1,
            title: 'The Lighthouse',
            overview: null,
            airDate: '2023-09-01T00:00:00.000Z',
            runtimeMinutes: 40,
          },
          userStatus: 'WATCHING',
        },
      ],
    },
  })
  getHome(@CurrentUser() user: RequestUser): Promise<HomeResponseDto> {
    return this.homeService.getHome(user.id);
  }
}
