import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EpisodeSummaryDto } from '../../../common/dto/episode-summary.dto';
import { SeriesSummaryDto } from '../../../common/dto/series-summary.dto';

export class RecentlyWatchedItemDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-555555555555', description: 'EpisodeWatch id' })
  watchId: string;

  @ApiProperty({ example: '2026-06-30T21:14:00.000Z' })
  watchedAt: Date;

  @ApiPropertyOptional({ example: 'Great cliffhanger!', nullable: true })
  note?: string | null;

  @ApiProperty({ type: SeriesSummaryDto })
  series: SeriesSummaryDto;

  @ApiProperty({ type: EpisodeSummaryDto })
  episode: EpisodeSummaryDto;
}

export class RecentlyWatchedPageDto {
  @ApiProperty({ type: [RecentlyWatchedItemDto] })
  items: RecentlyWatchedItemDto[];

  @ApiProperty({
    example: 'M2Y2YjFlMmEtOGMxZC00YjJhLTllMmUtNDQ0NDQ0NDQ0NDQ0',
    nullable: true,
    description: 'Pass as ?before= to fetch the next (older) page. Null when there are no more items.',
  })
  nextCursor: string | null;
}
