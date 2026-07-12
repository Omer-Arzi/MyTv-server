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

  @ApiProperty({
    enum: ['NO_CONFIRMED_IDENTITY', 'ALTERNATE_TITLE', 'IDENTITY_CONFLICT', 'PROVIDER_CATALOG_INCOMPLETE', 'SEASON_STRUCTURE_MISMATCH', 'WATCH_HISTORY_UNMAPPED', 'ALREADY_MIGRATED', 'SAFE_TO_APPLY'],
    example: 'SAFE_TO_APPLY',
    description: 'Structured classification of why this series is (or is not) confirmable right now. Render a short, fixed summary per code as the primary UI; `reason` (below) is full diagnostic detail, meant to be collapsible, not the primary text.',
  })
  reasonCode: 'NO_CONFIRMED_IDENTITY' | 'ALTERNATE_TITLE' | 'IDENTITY_CONFLICT' | 'PROVIDER_CATALOG_INCOMPLETE' | 'SEASON_STRUCTURE_MISMATCH' | 'WATCH_HISTORY_UNMAPPED' | 'ALREADY_MIGRATED' | 'SAFE_TO_APPLY';

  @ApiProperty({
    type: [String],
    enum: ['CONFIRM_MIGRATION', 'REVIEW_SEASON_MISMATCH', 'FIND_NEW_PROVIDER'],
    example: ['CONFIRM_MIGRATION'],
    description: 'Exactly which actions the UI should offer right now — replaces inferring actionability from `eligible` alone. CONFIRM_MIGRATION -> POST :seriesId/confirm. REVIEW_SEASON_MISMATCH -> POST :seriesId/review-season-shrink, then re-fetch this proposal. FIND_NEW_PROVIDER -> navigate to the candidate search screen.',
  })
  availableActions: ('CONFIRM_MIGRATION' | 'REVIEW_SEASON_MISMATCH' | 'FIND_NEW_PROVIDER')[];

  @ApiProperty({ example: 'identity confirmed with high confidence and catalog structure is safe — eligible for automatic migration', description: 'Full diagnostic detail — can be long. Render as collapsible/secondary text, never as the primary explanation.' })
  reason: string;

  @ApiPropertyOptional({ type: MigrationCurrentStateDto, nullable: true })
  current: MigrationCurrentStateDto | null;

  @ApiPropertyOptional({ type: MigrationWorkbenchProposalSummaryDto, nullable: true })
  proposal: MigrationWorkbenchProposalSummaryDto | null;
}
