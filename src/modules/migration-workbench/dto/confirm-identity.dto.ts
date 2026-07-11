import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNumber, IsString, Max, Min } from 'class-validator';

// The only body a client can send to confirm an identity — a candidate
// the user has already seen from GET /migration-workbench/:seriesId/candidates,
// never an arbitrary provider/id pair typed in freehand. providerId/provider
// are still validated as plain strings (not re-verified against TMDb here)
// — the actual verification happens live the next time a proposal is
// requested for this series (GET /migration-workbench/:seriesId/proposal),
// which re-fetches and re-classifies from scratch.
export class ConfirmIdentityDto {
  @ApiProperty({ enum: ['tmdb', 'tvmaze'], example: 'tmdb' })
  @IsIn(['tmdb', 'tvmaze'])
  provider: 'tmdb' | 'tvmaze';

  @ApiProperty({ example: '604' })
  @IsString()
  providerId: string;

  @ApiProperty({ example: 0.92, description: 'The candidate\'s confidence score from the search results — recorded for future staleness auditing.' })
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence: number;
}
