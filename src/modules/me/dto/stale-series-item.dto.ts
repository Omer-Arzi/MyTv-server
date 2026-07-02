import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EpisodeSummaryDto } from '../../../common/dto/episode-summary.dto';
import { SeriesSummaryDto } from '../../../common/dto/series-summary.dto';

export class StaleSeriesItemDto {
  @ApiProperty({ type: SeriesSummaryDto })
  series: SeriesSummaryDto;

  @ApiPropertyOptional({ example: '2026-05-01T18:00:00.000Z', nullable: true })
  lastWatchedAt?: Date | null;

  @ApiPropertyOptional({ type: EpisodeSummaryDto, nullable: true })
  nextEpisode?: EpisodeSummaryDto | null;
}
