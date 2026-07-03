import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EpisodeSummaryDto } from '../../../common/dto/episode-summary.dto';

// EpisodeSummaryDto plus this user's personal watch state — used only in
// the series-detail response, where every episode needs "have I watched
// this, when, did I leave a note, and what's the EpisodeWatch id" alongside
// its metadata.
export class EpisodeDetailDto extends EpisodeSummaryDto {
  @ApiProperty({ example: true, description: 'Whether the current user has watched this episode.' })
  watched: boolean;

  @ApiPropertyOptional({
    example: '2026-06-30T21:14:00.000Z',
    nullable: true,
    description: 'When the current user watched this episode. Null if unwatched.',
  })
  watchedAt: Date | null;

  @ApiPropertyOptional({
    example: 'Great cliffhanger! Did not see that coming.',
    nullable: true,
    description: 'The current user\'s note on their watch of this episode, if any. Null if unwatched or no note was left.',
  })
  note: string | null;

  @ApiPropertyOptional({
    example: '3f6b1e2a-8c1d-4b2a-9e2e-555555555555',
    nullable: true,
    description:
      'The EpisodeWatch id backing this watch, if watched — pass this to PATCH /episode-watches/:watchId/note to ' +
      'add or edit a note directly from the series-detail screen. Null if unwatched.',
  })
  episodeWatchId: string | null;
}
