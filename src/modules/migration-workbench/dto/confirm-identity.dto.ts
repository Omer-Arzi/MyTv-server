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

  @ApiProperty({
    example: 0.8,
    minimum: 0,
    maximum: 1,
    description:
      'The candidate\'s confidenceScore from GET /:seriesId/candidates, unmodified — recorded for future staleness auditing. Must be the normalized 0..1 value from the search response, never a percentage (e.g. send 0.8, not 80).',
  })
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence: number;
}
