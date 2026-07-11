import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProviderCandidateDto {
  @ApiProperty({ example: 'tmdb' })
  provider: string;

  @ApiProperty({ example: '604' })
  providerId: string;

  @ApiProperty({ example: 'Teen Titans' })
  title: string;

  @ApiPropertyOptional({ example: 2003, nullable: true })
  year: number | null;

  @ApiPropertyOptional({ example: 'https://image.tmdb.org/t/p/original/poster.jpg', nullable: true })
  posterUrl: string | null;

  @ApiPropertyOptional({ example: 65, nullable: true })
  episodeCount: number | null;

  @ApiPropertyOptional({ example: 5, nullable: true })
  seasonCount: number | null;

  @ApiProperty({ example: 0.92, description: 'Combined title/year confidence score, 0..1.' })
  confidenceScore: number;

  @ApiProperty({ enum: ['exact', 'substring', 'fuzzy'], example: 'exact' })
  titleMatchType: string;

  @ApiProperty({ enum: ['exact', 'close', 'unknown', 'mismatch'], example: 'exact' })
  yearMatchType: string;

  @ApiProperty({ example: 'exact title match; year match: exact; this candidate\'s episode count already covers everything watched' })
  explanation: string;

  @ApiProperty({ type: [String], example: [], description: 'Major mismatch warnings (e.g. watched count exceeds candidate total, season-collapse pattern, anime absolute-numbering risk).' })
  warnings: string[];
}

export class ProviderCandidateSearchResultDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  seriesId: string;

  @ApiProperty({ example: 'Teen Titans' })
  localTitle: string;

  @ApiProperty({ type: [ProviderCandidateDto] })
  candidates: ProviderCandidateDto[];

  @ApiProperty({
    enum: ['SAFE_CANDIDATE_HIGH_CONFIDENCE', 'NEEDS_MANUAL_CONFIRMATION', 'NEEDS_ABSOLUTE_NUMBERING_PROVIDER', 'PROVIDER_STRUCTURE_RISK', 'NO_GOOD_MATCH', 'SKIP_LOW_CONFIDENCE'],
    example: 'NEEDS_MANUAL_CONFIRMATION',
  })
  classification: string;

  @ApiProperty({ example: 'top candidate is a clean, high-confidence match — safe for a human to confirm directly.' })
  reason: string;

  @ApiPropertyOptional({ example: '604', nullable: true, description: 'The candidate this classification recommends, if any — still requires an explicit user selection, never auto-applied.' })
  recommendedProviderId: string | null;
}
