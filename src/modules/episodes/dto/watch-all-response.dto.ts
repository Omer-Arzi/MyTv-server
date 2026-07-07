import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserSeriesStatus } from '@prisma/client';

export class WatchAllResponseDto {
  @ApiProperty({ example: 12, description: 'Episodes in scope (the season, or the whole series) that were evaluated.' })
  episodesConsidered: number;

  @ApiProperty({ example: 8, description: 'Of those considered, how many already had an EpisodeWatch row — untouched.' })
  episodesAlreadyWatched: number;

  @ApiProperty({ example: 3, description: 'New EpisodeWatch rows created (or that would be created, in dry-run mode).' })
  watchesCreated: number;

  @ApiProperty({ example: 1, description: 'Episodes excluded because their airDate is in the future.' })
  episodesSkippedFuture: number;

  @ApiProperty({ example: 0, description: 'Episodes excluded because airDate is null and includeUnknownAirDate was not set.' })
  episodesSkippedUnknownAirDate: number;

  @ApiProperty({ enum: UserSeriesStatus, example: 'WATCHING' })
  previousUserStatus: UserSeriesStatus;

  @ApiProperty({ enum: UserSeriesStatus, example: 'CAUGHT_UP' })
  newUserStatus: UserSeriesStatus;

  @ApiPropertyOptional({ nullable: true, example: '3f6b1e2a-8c1d-4b2a-9e2e-444444444444' })
  previousNextEpisodeId: string | null;

  @ApiPropertyOptional({ nullable: true, example: null })
  newNextEpisodeId: string | null;

  @ApiProperty({ example: false, description: 'True if this was a dry run — nothing was written.' })
  dryRun: boolean;
}
