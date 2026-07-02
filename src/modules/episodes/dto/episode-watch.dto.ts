import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EpisodeSummaryDto } from '../../../common/dto/episode-summary.dto';

export class EpisodeWatchDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-555555555555' })
  id: string;

  @ApiProperty({ example: '2026-06-30T21:14:00.000Z' })
  watchedAt: Date;

  @ApiPropertyOptional({ example: 'Great cliffhanger!', nullable: true })
  note?: string | null;

  @ApiProperty({ type: EpisodeSummaryDto })
  episode: EpisodeSummaryDto;
}
