import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class EpisodeSummaryDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-222222222222' })
  id: string;

  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-333333333333' })
  seasonId: string;

  @ApiProperty({ example: 1, description: 'Season number, 1-indexed' })
  seasonNumber: number;

  @ApiProperty({ example: 5, description: 'Episode number within the season, 1-indexed' })
  episodeNumber: number;

  @ApiPropertyOptional({
    example: 'Into the Dark',
    nullable: true,
    description: 'Null for episodes without known metadata yet (e.g. imported without a title source).',
  })
  title?: string | null;

  @ApiPropertyOptional({ example: 'The crew loses contact with mission control.', nullable: true })
  overview?: string | null;

  @ApiPropertyOptional({ example: '2024-03-10T00:00:00.000Z', nullable: true })
  airDate?: Date | null;

  @ApiPropertyOptional({ example: 42, nullable: true })
  runtimeMinutes?: number | null;

  @ApiPropertyOptional({
    example: 'https://image.tmdb.org/t/p/original/into-the-dark-still.jpg',
    nullable: true,
    description: 'Episode still/thumbnail image. Null until enrichment provides one — render a placeholder.',
  })
  imageUrl?: string | null;
}
