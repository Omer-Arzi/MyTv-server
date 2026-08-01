import { ApiProperty } from '@nestjs/swagger';

export class DeleteSeriesResponseDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  seriesId: string;

  @ApiProperty({ example: 'Bleach' })
  title: string;

  @ApiProperty({ example: 17, description: 'Season rows that would be (or were) deleted.' })
  seasonCount: number;

  @ApiProperty({ example: 771, description: 'Episode rows that would be (or were) deleted.' })
  episodeCount: number;

  @ApiProperty({ example: 214, description: 'Of those episodes, how many this user had an EpisodeWatch row for — the watch history this delete would destroy.' })
  watchedEpisodeCount: number;

  @ApiProperty({ example: false, description: 'True only when confirm was true and the delete actually happened. False means this was a preview — nothing was written.' })
  deleted: boolean;
}
