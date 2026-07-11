import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserSeriesStatus } from '@prisma/client';
import { EpisodeSummaryDto } from '../../../common/dto/episode-summary.dto';

export class UpdateSeriesStatusResponseDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  seriesId: string;

  @ApiProperty({
    enum: UserSeriesStatus,
    example: UserSeriesStatus.WATCHING,
    description:
      'The userStatus after this update. Exactly what was requested for PAUSED/DROPPED/WATCHLIST. For a requested ' +
      'WATCHING (e.g. "resume watching" from PAUSED/DROPPED), this is the ACTUALLY correct derived status — ' +
      'WATCHING if an unwatched released episode exists, else CAUGHT_UP (series still airing) or COMPLETED ' +
      '(series ended/cancelled) — never blindly WATCHING regardless of catalog state.',
  })
  userStatus: UserSeriesStatus;

  @ApiPropertyOptional({
    type: EpisodeSummaryDto,
    nullable: true,
    description:
      'The first unwatched episode found in this user\'s currently-known episode catalog for this series ' +
      '(best-effort — may be incomplete/stale for series that have not been enriched), when the resulting ' +
      'userStatus is WATCHING. For PAUSED/DROPPED, this is the series\' next episode as it stood before this ' +
      'update — preserved, not recomputed, so resuming later is immediate and correct. Null for WATCHLIST.',
  })
  nextEpisode: EpisodeSummaryDto | null;
}
