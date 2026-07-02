import { Body, Controller, Param, Patch } from '@nestjs/common';
import { ApiBody, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types';
import { EpisodeWatchService } from './episode-watch.service';
import { AddNoteDto } from './dto/add-note.dto';
import { EpisodeWatchDto } from './dto/episode-watch.dto';

@ApiTags('episode-watches')
@Controller('episode-watches')
export class EpisodeWatchesController {
  constructor(private readonly episodeWatchService: EpisodeWatchService) {}

  @Patch(':watchId/note')
  @ApiOperation({
    summary: 'Add or replace the note on a watched episode',
    description: 'Upserts the note text attached to a specific EpisodeWatch belonging to the current user.',
  })
  @ApiParam({ name: 'watchId', description: 'EpisodeWatch id', example: '3f6b1e2a-8c1d-4b2a-9e2e-555555555555' })
  @ApiBody({ type: AddNoteDto })
  @ApiOkResponse({
    type: EpisodeWatchDto,
    description: 'Updated watch record with the new note',
    example: {
      id: '3f6b1e2a-8c1d-4b2a-9e2e-555555555555',
      watchedAt: '2026-07-02T09:30:00.000Z',
      note: 'Great cliffhanger! Did not expect the twist with the captain.',
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
  })
  @ApiNotFoundResponse({ description: 'Episode watch not found' })
  addNote(
    @CurrentUser() user: RequestUser,
    @Param('watchId') watchId: string,
    @Body() body: AddNoteDto,
  ): Promise<EpisodeWatchDto> {
    return this.episodeWatchService.addNote(user.id, watchId, body.text);
  }
}
