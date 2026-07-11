import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserSeriesStatus } from '@prisma/client';
import { MigrationWorkbenchProposalSummaryDto } from './migration-workbench-item.dto';

export class MigrationCurrentStateDto {
  @ApiProperty({ example: 22 })
  episodeCount: number;

  @ApiProperty({ example: 22 })
  watchedCount: number;

  @ApiProperty({ enum: UserSeriesStatus, example: UserSeriesStatus.WATCHING })
  userStatus: UserSeriesStatus;
}

export class MigrationProposalDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  seriesId: string;

  @ApiProperty({ example: 'Naruto Shippuden' })
  title: string;

  @ApiProperty({ example: true, description: 'False when there is no confirmed provider decision on file yet — no live fetch was attempted.' })
  eligible: boolean;

  @ApiProperty({ enum: ['READY_AUTOMATIC', 'READY_FOR_CONFIRMATION', 'NEEDS_EPISODE_REVIEW', 'NO_RELIABLE_PROVIDER'], example: 'READY_FOR_CONFIRMATION' })
  category: 'READY_AUTOMATIC' | 'READY_FOR_CONFIRMATION' | 'NEEDS_EPISODE_REVIEW' | 'NO_RELIABLE_PROVIDER';

  @ApiProperty({ example: 'identity confirmed with high confidence and catalog structure is safe — eligible for automatic migration' })
  reason: string;

  @ApiPropertyOptional({ type: MigrationCurrentStateDto, nullable: true })
  current: MigrationCurrentStateDto | null;

  @ApiPropertyOptional({ type: MigrationWorkbenchProposalSummaryDto, nullable: true })
  proposal: MigrationWorkbenchProposalSummaryDto | null;
}
