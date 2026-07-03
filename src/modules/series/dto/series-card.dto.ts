import { ApiProperty } from '@nestjs/swagger';
import { UserSeriesStatus } from '@prisma/client';
import { SeriesSummaryDto } from '../../../common/dto/series-summary.dto';

// SeriesSummaryDto plus this user's personal status — enough for a library
// screen card (poster/backdrop, title, release status, and a status badge)
// without the full season/episode detail GET /series/:id carries.
export class SeriesCardDto extends SeriesSummaryDto {
  @ApiProperty({
    enum: UserSeriesStatus,
    example: UserSeriesStatus.WATCHING,
    description: 'My personal viewing status for this series.',
  })
  userStatus: UserSeriesStatus;
}
