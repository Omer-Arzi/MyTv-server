import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserSeriesStatus } from '@prisma/client';
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
    description:
      'True whenever there was no next episode found (covers both CAUGHT_UP and COMPLETED userStatus) — kept for ' +
      'backward compatibility. Prefer userStatus for the precise distinction.',
  })
  seriesCompleted: boolean;

  @ApiProperty({
    enum: UserSeriesStatus,
    example: UserSeriesStatus.WATCHING,
    description:
      'My personal viewing status for this series after this watch — always WATCHING if a next episode was found, ' +
      'otherwise CAUGHT_UP (show still ongoing) or COMPLETED (show has ended/been cancelled).',
  })
  userStatus: UserSeriesStatus;

  @ApiPropertyOptional({
    nullable: true,
    example: 3,
    description:
      'How many known catalog episodes come after nextEpisode (nextEpisode itself not counted) — the same field ' +
      'Watch Next items carry (GET /home, GET /me/watch-next). Null when nextEpisode is null, or when the server ' +
      "couldn't reliably determine catalog position. Included so a Watch Next card can update its \"+N\" indicator " +
      'in place from this response alone, with no follow-up request.',
  })
  remainingEpisodesAfterNext: number | null;
}
