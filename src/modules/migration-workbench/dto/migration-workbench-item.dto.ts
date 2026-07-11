import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserSeriesStatus } from '@prisma/client';

export class MigrationWorkbenchProposalSummaryDto {
  @ApiProperty({ enum: UserSeriesStatus, example: UserSeriesStatus.WATCHING })
  currentUserStatus: UserSeriesStatus;

  @ApiProperty({
    enum: UserSeriesStatus,
    example: UserSeriesStatus.COMPLETED,
    description: 'Automatically derived — never a manually-set value. PAUSED/DROPPED are always preserved, regardless of what the migration would otherwise compute.',
  })
  proposedUserStatus: UserSeriesStatus;

  @ApiProperty({ example: 24 })
  matchedWatchedEpisodeCount: number;

  @ApiProperty({ example: 24 })
  matchedTotalEpisodeCount: number;

  @ApiProperty({ example: 2, description: 'New episodes the migration would create.' })
  episodesToCreate: number;

  @ApiProperty({ type: [Number], example: [3] })
  seasonsToCreate: number[];

  @ApiProperty({ example: 0, description: 'Watched episodes with no matching slot in the provider catalog — always guaranteed preserved untouched, never deleted.' })
  unmatchedWatchedOrphanCount: number;

  @ApiProperty({ enum: ['HIGH', 'BORDERLINE'], example: 'HIGH' })
  confidence: 'HIGH' | 'BORDERLINE';
}

export class MigrationWorkbenchItemDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  seriesId: string;

  @ApiProperty({ example: 'Naruto Shippuden' })
  title: string;

  @ApiPropertyOptional({ example: 'https://image.tmdb.org/t/p/original/poster.jpg', nullable: true })
  posterUrl: string | null;

  @ApiProperty({
    enum: ['READY_AUTOMATIC', 'READY_FOR_CONFIRMATION', 'NEEDS_EPISODE_REVIEW', 'NO_RELIABLE_PROVIDER'],
    example: 'READY_FOR_CONFIRMATION',
  })
  category: 'READY_AUTOMATIC' | 'READY_FOR_CONFIRMATION' | 'NEEDS_EPISODE_REVIEW' | 'NO_RELIABLE_PROVIDER';

  @ApiProperty({ example: 'identity confirmed with high confidence and catalog structure is safe — eligible for automatic migration' })
  reason: string;

  @ApiPropertyOptional({
    type: MigrationWorkbenchProposalSummaryDto,
    nullable: true,
    description: 'Set only for READY_AUTOMATIC/READY_FOR_CONFIRMATION — computed from the latest library-health batch manifest (a periodic offline pipeline run, not live at request time).',
  })
  proposal: MigrationWorkbenchProposalSummaryDto | null;
}
