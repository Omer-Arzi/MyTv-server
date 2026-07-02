import { Controller, Param, Post } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types';
import { EpisodeWatchService } from './episode-watch.service';
import { MarkWatchedResponseDto } from './dto/mark-watched-response.dto';

@ApiTags('episodes')
@Controller('episodes')
export class EpisodesController {
  constructor(private readonly episodeWatchService: EpisodeWatchService) {}

  @Post(':episodeId/watch')
  @ApiOperation({
    summary: 'Mark an episode as watched',
    description:
      'Idempotent: calling this again for the same episode just refreshes watchedAt. ' +
      'Always returns the next episode in the series so a client can deterministically ' +
      'replace a swiped card; if there is no next episode, the series is marked completed.',
  })
  @ApiParam({ name: 'episodeId', description: 'Episode id', example: '3f6b1e2a-8c1d-4b2a-9e2e-222222222222' })
  @ApiOkResponse({
    type: MarkWatchedResponseDto,
    description: 'Watch recorded; next episode (if any) included for the client to render next',
    example: {
      watch: {
        id: '3f6b1e2a-8c1d-4b2a-9e2e-555555555555',
        watchedAt: '2026-07-02T09:30:00.000Z',
        note: null,
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
      seriesCompleted: false,
      userStatus: 'WATCHING',
    },
  })
  @ApiNotFoundResponse({ description: 'Episode not found' })
  markWatched(
    @CurrentUser() user: RequestUser,
    @Param('episodeId') episodeId: string,
  ): Promise<MarkWatchedResponseDto> {
    return this.episodeWatchService.markWatched(user.id, episodeId);
  }
}
