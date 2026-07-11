import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MigrationHistoryProviderRefDto } from './migration-history-item.dto';

export class MigrationHistoryDetailDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  id: string;

  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-222222222222' })
  seriesId: string;

  @ApiProperty({ example: 'Teen Titans' })
  seriesTitle: string;

  @ApiProperty({ example: '2026-07-11T14:21:59.347Z' })
  appliedAt: string;

  @ApiProperty({ example: 'AUTO_MIGRATE' })
  classification: string;

  @ApiProperty({ example: 'READY_AUTOMATIC' })
  sourceCategory: string;

  @ApiPropertyOptional({ type: MigrationHistoryProviderRefDto, nullable: true })
  providerBefore: MigrationHistoryProviderRefDto | null;

  @ApiProperty({ type: MigrationHistoryProviderRefDto })
  providerAfter: MigrationHistoryProviderRefDto;

  @ApiPropertyOptional({ example: 'UNKNOWN', nullable: true })
  releaseStatusBefore: string | null;

  @ApiPropertyOptional({ example: 'ENDED', nullable: true })
  releaseStatusAfter: string | null;

  @ApiProperty({ example: 'CAUGHT_UP' })
  userStatusBefore: string;

  @ApiProperty({ example: 'COMPLETED' })
  userStatusAfter: string;

  @ApiPropertyOptional({ nullable: true })
  nextEpisodeIdBefore: string | null;

  @ApiPropertyOptional({ nullable: true })
  nextEpisodeIdAfter: string | null;

  @ApiProperty({ example: 2 })
  episodesInsertedCount: number;

  @ApiProperty({ example: 0 })
  episodesUpdatedCount: number;

  @ApiProperty({ example: 0 })
  preservedOrphanEpisodeCount: number;

  @ApiProperty({ example: 65, description: 'How many locally-watched episodes this migration\'s catalog mapping covered.' })
  watchedMappingCount: number;

  @ApiProperty({ example: true })
  verificationPassed: boolean;

  @ApiProperty({ type: [String], example: [] })
  verificationDetail: string[];

  @ApiPropertyOptional({ example: null, nullable: true })
  rolledBackAt: string | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  rollbackReason: string | null;
}
