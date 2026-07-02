import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReleaseStatus } from '@prisma/client';

export class SeriesSummaryDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  id: string;

  @ApiProperty({ example: 'The Great Voyage' })
  title: string;

  @ApiPropertyOptional({ example: 'A crew explores the outer rim of known space.' })
  overview?: string | null;

  @ApiPropertyOptional({ example: 'https://images.example.com/great-voyage/poster.jpg' })
  posterUrl?: string | null;

  @ApiProperty({
    enum: ReleaseStatus,
    example: ReleaseStatus.RETURNING,
    description:
      'The show\'s own public broadcast status — provider-derived (TMDb/Trakt), not user-editable. ' +
      '"UNKNOWN" until an enrichment pass has confirmed it.',
  })
  releaseStatus: ReleaseStatus;
}
