import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EpisodeSummaryDto } from '../../../common/dto/episode-summary.dto';
import { SeriesSummaryDto } from '../../../common/dto/series-summary.dto';

export class WatchNextItemDto {
  @ApiProperty({ type: SeriesSummaryDto })
  series: SeriesSummaryDto;

  @ApiProperty({ type: EpisodeSummaryDto })
  nextEpisode: EpisodeSummaryDto;

  @ApiPropertyOptional({ example: '2026-06-30T21:14:00.000Z', nullable: true })
  lastWatchedAt?: Date | null;
}
