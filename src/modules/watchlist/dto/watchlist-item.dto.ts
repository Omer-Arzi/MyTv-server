import { ApiProperty } from '@nestjs/swagger';
import { SeriesSummaryDto } from '../../../common/dto/series-summary.dto';

export class WatchlistItemDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-999999999999', description: 'WatchlistItem id' })
  id: string;

  @ApiProperty({ example: '2026-06-01T10:00:00.000Z' })
  addedAt: Date;

  @ApiProperty({ type: SeriesSummaryDto })
  series: SeriesSummaryDto;
}
