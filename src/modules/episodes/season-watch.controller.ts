import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBody, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types';
import { EpisodeWatchService } from './episode-watch.service';
import { WatchAllRequestDto } from './dto/watch-all-request.dto';
import { WatchAllResponseDto } from './dto/watch-all-response.dto';

@ApiTags('seasons')
@Controller('seasons')
export class SeasonWatchController {
  constructor(private readonly episodeWatchService: EpisodeWatchService) {}

  @Post(':seasonId/watch-all')
  @ApiOperation({
    summary: 'Mark every released episode in this season as watched',
    description:
      'Manual escape hatch for provider-numbering/duplicate-episode issues (see ' +
      'docs/episode-numbering-and-season-shift-risk.md) — lets a user who knows they\'ve already watched ' +
      'everything actually released skip per-episode cleanup. Only creates EpisodeWatch rows for episodes whose ' +
      'airDate is today or earlier; existing watches are never touched. Recomputes this series\' overall ' +
      'nextEpisodeId/userStatus afterward (against the whole series, not just this season). Pass dryRun: true to ' +
      'preview without writing.',
  })
  @ApiParam({ name: 'seasonId', description: 'Season id', example: '3f6b1e2a-8c1d-4b2a-9e2e-333333333333' })
  @ApiBody({ type: WatchAllRequestDto })
  @ApiOkResponse({ type: WatchAllResponseDto })
  @ApiNotFoundResponse({ description: 'Season not found' })
  @ApiBadRequestResponse({ description: 'userStatus is DROPPED or PAUSED and force was not set to true' })
  watchAll(
    @CurrentUser() user: RequestUser,
    @Param('seasonId') seasonId: string,
    @Body() body: WatchAllRequestDto,
  ): Promise<WatchAllResponseDto> {
    return this.episodeWatchService.markSeasonWatched(user.id, seasonId, body);
  }
}
