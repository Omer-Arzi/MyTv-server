import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MigrationHistoryProviderRefDto {
  @ApiPropertyOptional({ example: 'tmdb', nullable: true })
  provider: string | null;

  @ApiPropertyOptional({ example: '604', nullable: true })
  providerId: string | null;

  @ApiPropertyOptional({ example: '604', nullable: true })
  tmdbId: string | null;
}

export class MigrationHistoryItemDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  id: string;

  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-222222222222' })
  seriesId: string;

  @ApiProperty({ example: 'Teen Titans' })
  seriesTitle: string;

  @ApiProperty({ example: '2026-07-11T14:21:59.347Z' })
  appliedAt: string;

  @ApiPropertyOptional({ type: MigrationHistoryProviderRefDto, nullable: true })
  providerBefore: MigrationHistoryProviderRefDto | null;

  @ApiProperty({ type: MigrationHistoryProviderRefDto })
  providerAfter: MigrationHistoryProviderRefDto;

  @ApiProperty({ example: 'CAUGHT_UP' })
  userStatusBefore: string;

  @ApiProperty({ example: 'COMPLETED' })
  userStatusAfter: string;

  @ApiProperty({ example: 2 })
  episodesInsertedCount: number;

  @ApiProperty({ example: 0 })
  episodesUpdatedCount: number;

  @ApiProperty({ example: true })
  verificationPassed: boolean;

  @ApiProperty({ example: false })
  rolledBack: boolean;

  @ApiProperty({ example: true, description: 'Whether this migration is currently eligible for rollback (a quick, non-authoritative check — always re-verified by the preview/rollback endpoints).' })
  rollbackAvailable: boolean;
}
