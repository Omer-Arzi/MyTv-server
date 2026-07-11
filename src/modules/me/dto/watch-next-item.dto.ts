import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserSeriesStatus } from '@prisma/client';
import { EpisodeSummaryDto } from '../../../common/dto/episode-summary.dto';
import { SeriesSummaryDto } from '../../../common/dto/series-summary.dto';

export class WatchNextItemDto {
  @ApiProperty({ type: SeriesSummaryDto })
  series: SeriesSummaryDto;

  @ApiProperty({ type: EpisodeSummaryDto })
  nextEpisode: EpisodeSummaryDto;

  @ApiPropertyOptional({ example: '2026-06-30T21:14:00.000Z', nullable: true })
  lastWatchedAt?: Date | null;

  @ApiProperty({
    enum: UserSeriesStatus,
    example: UserSeriesStatus.WATCHING,
    description: 'My personal viewing status for this series — always WATCHING for this section.',
  })
  userStatus: UserSeriesStatus;

  @ApiProperty({
    example: 87,
    nullable: true,
    description:
      'How many known catalog episodes come after nextEpisode, in (seasonNumber, episodeNumber) order — nextEpisode itself is not counted. ' +
      'Null when this could not be reliably determined (should not normally happen); clients should render nothing rather than assume 0.',
  })
  remainingEpisodesAfterNext: number | null;
}
