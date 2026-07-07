import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserSeriesStatus } from '@prisma/client';
import { EpisodeSummaryDto } from '../../../common/dto/episode-summary.dto';
import { SeriesSummaryDto } from '../../../common/dto/series-summary.dto';

export class StaleSeriesItemDto {
  @ApiProperty({ type: SeriesSummaryDto })
  series: SeriesSummaryDto;

  @ApiPropertyOptional({ example: '2026-05-01T18:00:00.000Z', nullable: true })
  lastWatchedAt?: Date | null;

  @ApiProperty({ type: EpisodeSummaryDto })
  nextEpisode: EpisodeSummaryDto;

  @ApiProperty({
    enum: UserSeriesStatus,
    example: UserSeriesStatus.WATCHING,
    description: 'My personal viewing status for this series — always WATCHING for this section (same trust gate as Watch Next, plus a staleness check).',
  })
  userStatus: UserSeriesStatus;
}
