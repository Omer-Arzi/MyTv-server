import { ApiProperty } from '@nestjs/swagger';

export class NumberingMappingResultDto {
  @ApiProperty()
  seriesId: string;

  @ApiProperty()
  mappingId: string;

  @ApiProperty({ description: 'How many PendingProviderEpisode rows this new mapping resolved and promoted into real Episode rows.' })
  episodesPromoted: number;

  @ApiProperty({ type: [String] })
  episodeIds: string[];
}

export class PendingEpisodeDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  seriesId: string;

  @ApiProperty()
  seriesTitle: string;

  @ApiProperty()
  tmdbEpisodeId: number;

  @ApiProperty()
  providerSeasonNumber: number;

  @ApiProperty()
  providerEpisodeNumber: number;

  @ApiProperty({ nullable: true })
  title: string | null;

  @ApiProperty({ nullable: true })
  airDate: string | null;

  @ApiProperty()
  discoveredAt: string;
}
