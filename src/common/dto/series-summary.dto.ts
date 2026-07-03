import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReleaseStatus } from '@prisma/client';

export class SeriesSummaryDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  id: string;

  @ApiProperty({ example: 'The Great Voyage' })
  title: string;

  @ApiPropertyOptional({ example: 'A crew explores the outer rim of known space.', nullable: true })
  overview?: string | null;

  @ApiPropertyOptional({
    example: 'https://image.tmdb.org/t/p/original/great-voyage-poster.jpg',
    nullable: true,
    description: 'Portrait poster art. Null until enrichment provides one — render a placeholder.',
  })
  posterUrl?: string | null;

  @ApiPropertyOptional({
    example: 'https://image.tmdb.org/t/p/original/great-voyage-backdrop.jpg',
    nullable: true,
    description:
      'Wide "fanart"-style backdrop image, distinct from posterUrl — suited to a detail-screen hero header. ' +
      'Null until enrichment provides one.',
  })
  backdropUrl?: string | null;

  @ApiProperty({
    enum: ReleaseStatus,
    example: ReleaseStatus.RETURNING,
    description:
      'The show\'s own public broadcast status — provider-derived (TMDb/Trakt), not user-editable. ' +
      '"UNKNOWN" until an enrichment pass has confirmed it.',
  })
  releaseStatus: ReleaseStatus;
}
