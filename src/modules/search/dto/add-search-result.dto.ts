import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';

// Deliberately minimal — only the provider identity is ever trusted from
// the client, same posture as ConfirmIdentityDto. Title/poster/overview/
// releaseStatus are always re-fetched fresh from the provider server-side
// (see SearchService.addSearchResult) rather than trusted from whatever a
// possibly-stale cached search response showed.
export class AddSearchResultDto {
  @ApiProperty({ enum: ['tmdb', 'tvmaze'], example: 'tmdb' })
  @IsIn(['tmdb', 'tvmaze'])
  provider: 'tmdb' | 'tvmaze';

  @ApiProperty({ example: '95396' })
  @IsString()
  providerId: string;
}
