import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SeriesSummaryDto } from '../../../common/dto/series-summary.dto';
import { EpisodeSummaryDto } from '../../../common/dto/episode-summary.dto';
import { EpisodeWatchDto } from './episode-watch.dto';

// Response for POST /episodes/:episodeId/watch. Designed to carry everything
// a swipeable card UI needs to deterministically replace itself with the
// next episode's card on success, without a follow-up request.
export class MarkWatchedResponseDto {
  @ApiProperty({ type: EpisodeWatchDto, description: 'The watch record that was just created/updated' })
  watch: EpisodeWatchDto;

  @ApiProperty({ type: SeriesSummaryDto })
  series: SeriesSummaryDto;

  @ApiPropertyOptional({
    type: EpisodeSummaryDto,
    nullable: true,
    description: 'The next episode to watch in this series, or null if there is none.',
  })
  nextEpisode: EpisodeSummaryDto | null;

  @ApiProperty({
    example: false,
    description: 'True when there was no next episode and the series was marked completed.',
  })
  seriesCompleted: boolean;
}
