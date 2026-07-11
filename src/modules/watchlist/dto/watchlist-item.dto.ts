import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserSeriesStatus } from '@prisma/client';
import { SeriesSummaryDto } from '../../../common/dto/series-summary.dto';

export class WatchlistItemDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-999999999999', description: 'A stable id for this list entry' })
  id: string;

  @ApiProperty({ type: SeriesSummaryDto })
  series: SeriesSummaryDto;

  @ApiProperty({
    enum: UserSeriesStatus,
    example: UserSeriesStatus.WATCHLIST,
    description:
      'My personal viewing status for this series. GET /watchlist only ever returns WATCHING, CAUGHT_UP, or WATCHLIST — ' +
      'the tab represents the user\'s active, TRUSTWORTHY tracking list, not their full collection. A WATCHING/CAUGHT_UP ' +
      'series only appears here if it has a confirmed provider match (see needs-attention-logic.ts); unconfirmed series ' +
      'are held back to the Needs Attention inbox instead until resolved. PAUSED/DROPPED/COMPLETED/UNKNOWN series, and ' +
      'unconfirmed WATCHING/CAUGHT_UP series, are still available through GET /series (the Library tab).',
  })
  userStatus: UserSeriesStatus;

  @ApiPropertyOptional({
    example: null,
    nullable: true,
    description:
      'Set (to the same reasonCode GET /needs-attention uses) when this series has a confirmed provider match but is on ' +
      'the known episode-numbering/season-shift risk list — its progress is real and trustworthy enough to show here, but ' +
      'automated catalog/progress updates are held back for it. Null for every other item. Reuses ' +
      'needs-attention-logic.ts::classifySeriesForAttention rather than a second risk classification.',
  })
  attentionReasonCode: string | null;
}
