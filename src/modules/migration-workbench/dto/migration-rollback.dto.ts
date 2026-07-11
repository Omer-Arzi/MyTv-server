import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MigrationHistoryProviderRefDto } from './migration-history-item.dto';

export class MigrationRollbackPreviewDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  migrationId: string;

  @ApiProperty({ example: true })
  eligible: boolean;

  @ApiProperty({ type: [String], example: [] })
  refusalReasons: string[];

  @ApiProperty({ type: [String], example: [], description: 'Human-readable explanation per refusal reason — safe to show directly in the UI.' })
  explanations: string[];

  @ApiPropertyOptional({ type: MigrationHistoryProviderRefDto, nullable: true })
  wouldRestoreProvider: MigrationHistoryProviderRefDto | null;

  @ApiPropertyOptional({ example: 'CAUGHT_UP', nullable: true })
  wouldRestoreUserStatus: string | null;

  @ApiPropertyOptional({ nullable: true })
  wouldRestoreNextEpisodeId: string | null;

  @ApiProperty({ example: 2 })
  wouldRemoveEpisodeCount: number;

  @ApiProperty({ example: true })
  watchHistoryPreserved: boolean;
}

export class MigrationRollbackResultDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  migrationId: string;

  @ApiProperty({ example: true })
  rolledBack: boolean;

  @ApiProperty({ example: 2 })
  episodesDeleted: number;

  @ApiProperty({ example: true })
  providerRestored: boolean;

  @ApiProperty({ example: true })
  progressRestored: boolean;

  @ApiProperty({ example: 'Migration rolled back.' })
  message: string;
}
