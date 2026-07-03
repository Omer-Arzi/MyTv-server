import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { EpisodeSummaryDto } from '../../../common/dto/episode-summary.dto';
import { SeasonDetailDto } from './season-detail.dto';
import { SeriesExternalIdsDto } from './series-external-ids.dto';

export class SeriesDetailDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  id: string;

  @ApiProperty({ example: 'Frieren: Beyond Journey\'s End' })
  title: string;

  @ApiPropertyOptional({ example: 'After the party defeats the Demon King, they part ways.', nullable: true })
  overview: string | null;

  @ApiPropertyOptional({ example: 'https://image.tmdb.org/t/p/original/frieren-poster.jpg', nullable: true })
  posterUrl: string | null;

  @ApiPropertyOptional({ example: 'https://image.tmdb.org/t/p/original/frieren-backdrop.jpg', nullable: true })
  backdropUrl: string | null;

  @ApiProperty({
    enum: ReleaseStatus,
    example: ReleaseStatus.RETURNING,
    description: 'The show\'s own public broadcast status — provider-derived, not user-editable.',
  })
  releaseStatus: ReleaseStatus;

  @ApiProperty({
    enum: UserSeriesStatus,
    example: UserSeriesStatus.WATCHING,
    description: 'My personal viewing status for this series. UNKNOWN if there is no relationship at all yet.',
  })
  userStatus: UserSeriesStatus;

  @ApiPropertyOptional({
    type: EpisodeSummaryDto,
    nullable: true,
    description: 'The next episode to watch, if known. Null when caught up, completed, or the episode catalog/watch state does not resolve one.',
  })
  nextEpisode: EpisodeSummaryDto | null;

  @ApiProperty({ type: [SeasonDetailDto], description: 'Every known season, in order, each with its full episode list and this user\'s watch state per episode.' })
  seasons: SeasonDetailDto[];

  @ApiPropertyOptional({
    type: SeriesExternalIdsDto,
    nullable: true,
    description: 'Provider ids for this series. Null if no enrichment match has been applied yet.',
  })
  externalIds: SeriesExternalIdsDto | null;
}
