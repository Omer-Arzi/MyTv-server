import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

// A confirmed boundary/range for docs/episode-numbering-and-season-shift-risk.md's
// numbering-supervision mechanism (SeriesNumberingMapping) — one row per
// known boundary, not one per episode. providerEpisodeEnd omitted/null
// means open-ended: this and every future episode in that provider season
// resolve through this same mapping automatically, so confirming a
// boundary once is enough. localEpisodeNumber = providerEpisodeNumber -
// localEpisodeOffset.
export class CreateNumberingMappingDto {
  @ApiProperty({ example: 1, description: "The provider's (TMDb) season_number this mapping applies to." })
  @IsInt()
  @Min(0)
  providerSeasonNumber: number;

  @ApiProperty({ example: 79, description: 'First provider episode_number this mapping covers (inclusive).' })
  @IsInt()
  @Min(1)
  providerEpisodeStart: number;

  @ApiProperty({ example: null, required: false, nullable: true, description: 'Last provider episode_number this mapping covers (inclusive). Omit/null for open-ended — covers this and every future episode automatically.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  providerEpisodeEnd?: number | null;

  @ApiProperty({ example: 5, description: 'The local season number episodes in this range should display as.' })
  @IsInt()
  @Min(1)
  localSeasonNumber: number;

  @ApiProperty({ example: 78, description: 'localEpisodeNumber = providerEpisodeNumber - localEpisodeOffset.' })
  @IsInt()
  localEpisodeOffset: number;
}
