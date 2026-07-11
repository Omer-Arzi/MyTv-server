import { ApiProperty } from '@nestjs/swagger';
import { UserSeriesStatus } from '@prisma/client';

export class MigrationConfirmResultDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  seriesId: string;

  @ApiProperty({ example: 'Naruto Shippuden' })
  title: string;

  @ApiProperty({ example: true, description: 'False only when the series was already fully migrated (a true no-op) — nothing new was written.' })
  applied: boolean;

  @ApiProperty({ enum: UserSeriesStatus, example: UserSeriesStatus.COMPLETED })
  finalUserStatus: UserSeriesStatus;

  @ApiProperty({ example: 2 })
  episodesCreated: number;

  @ApiProperty({ type: [Number], example: [3] })
  seasonsCreated: number[];

  @ApiProperty({ example: true, description: 'Whether the post-write verification snapshot matched its own expectation.' })
  verificationPassed: boolean;

  @ApiProperty({ example: 'Migration applied.' })
  message: string;
}
