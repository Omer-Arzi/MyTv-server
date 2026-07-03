import { ApiPropertyOptional } from '@nestjs/swagger';

// Only included when at least one id is known (see SeriesDetailDto) — not
// meant for deep-linking today, but useful for a future "view on TMDb"
// affordance or client-side debugging without another round trip.
export class SeriesExternalIdsDto {
  @ApiPropertyOptional({ example: '94605', nullable: true, description: 'Populated by the TMDb enrichment apply once a series is matched.' })
  tmdbId: string | null;

  @ApiPropertyOptional({ example: null, nullable: true, description: 'Not populated yet — Trakt enrichment apply does not exist.' })
  traktId: string | null;

  @ApiPropertyOptional({
    example: null,
    nullable: true,
    description: 'Not populated yet — TMDb\'s response includes this, but the current enrichment apply does not write it to this column.',
  })
  imdbId: string | null;
}
