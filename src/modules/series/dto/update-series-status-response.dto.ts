import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserSeriesStatus } from '@prisma/client';
import { EpisodeSummaryDto } from '../../../common/dto/episode-summary.dto';

export class UpdateSeriesStatusResponseDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  seriesId: string;

  @ApiProperty({
    enum: UserSeriesStatus,
    example: UserSeriesStatus.WATCHING,
    description: 'The userStatus after this update — always exactly what was requested.',
  })
  userStatus: UserSeriesStatus;

  @ApiPropertyOptional({
    type: EpisodeSummaryDto,
    nullable: true,
    description:
      'When userStatus is WATCHING, the first unwatched episode found in this user\'s currently-known episode ' +
      'catalog for this series (best-effort — may be incomplete/stale for series that have not been enriched). ' +
      'Always null for PAUSED/DROPPED/WATCHLIST, since those clear nextEpisodeId.',
  })
  nextEpisode: EpisodeSummaryDto | null;
}
