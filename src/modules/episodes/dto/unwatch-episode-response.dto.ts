import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserSeriesStatus } from '@prisma/client';

// Response for DELETE /episode-watches/:watchId. "previous"/"new" pairs let
// the client update a series-detail episode list and any "watch next" card
// in place without a follow-up GET, mirroring the "before"/"after" shape
// watch-all already uses (WatchAllResponseDto).
export class UnwatchEpisodeResponseDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-222222222222' })
  episodeId: string;

  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  seriesId: string;

  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-555555555555', description: 'The EpisodeWatch id that was removed.' })
  removedWatchId: string;

  @ApiProperty({ enum: UserSeriesStatus, example: UserSeriesStatus.CAUGHT_UP })
  previousUserStatus: UserSeriesStatus;

  @ApiProperty({
    enum: UserSeriesStatus,
    example: UserSeriesStatus.WATCHING,
    description:
      'Recomputed from the remaining watch state — UNLESS previousUserStatus was DROPPED or PAUSED, in which ' +
      'case it is left unchanged (see warning).',
  })
  newUserStatus: UserSeriesStatus;

  @ApiPropertyOptional({ nullable: true, example: null })
  previousNextEpisodeId: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '3f6b1e2a-8c1d-4b2a-9e2e-222222222222',
    description: 'Usually the just-unwatched episode itself, if it is now the earliest released unwatched episode.',
  })
  newNextEpisodeId: string | null;

  @ApiProperty({
    example: true,
    description:
      'True if a released, unwatched episode exists for this series after the unwatch, regardless of whether ' +
      'newUserStatus/newNextEpisodeId actually reflect it (see warning).',
  })
  hasRemainingReleasedUnwatched: boolean;

  @ApiPropertyOptional({
    example: 'userStatus is PAUSED (user-controlled) — preserved rather than recomputed; nextEpisodeId left unchanged too',
    description:
      'Present only when previousUserStatus was DROPPED or PAUSED: explains that userStatus/nextEpisodeId were ' +
      'deliberately left untouched rather than recomputed.',
  })
  warning?: string;
}
