import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EpisodeDetailDto } from './episode-detail.dto';

export class SeasonDetailDto {
  @ApiProperty({ example: 1, description: 'Season number, 1-indexed' })
  seasonNumber: number;

  @ApiPropertyOptional({ example: 'Season 1', nullable: true })
  title: string | null;

  @ApiProperty({ type: [EpisodeDetailDto] })
  episodes: EpisodeDetailDto[];
}
