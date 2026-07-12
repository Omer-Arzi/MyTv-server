import { ApiProperty } from '@nestjs/swagger';
import { EpisodeSummaryDto } from '../../../common/dto/episode-summary.dto';
import { SeriesSummaryDto } from '../../../common/dto/series-summary.dto';

export class HavenStartedYetItemDto {
  @ApiProperty({ type: SeriesSummaryDto })
  series: SeriesSummaryDto;

  @ApiProperty({
    type: EpisodeSummaryDto,
    description: 'The most recently released regular (season > 0) episode — Season 0/Specials never drive this section, per the same rule COMPLETED/CAUGHT_UP derivation uses. Used for both sort order and display.',
  })
  latestReleasedRegularEpisode: EpisodeSummaryDto;

  @ApiProperty({ example: 12, description: 'How many regular episodes have been released so far — always >= 1 for any item in this list.' })
  releasedRegularEpisodeCount: number;
}
