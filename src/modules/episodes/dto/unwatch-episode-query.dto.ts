import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class UnwatchEpisodeQueryDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'Required to be true if this watch has a note, rating, or emotion reaction attached — otherwise the ' +
      'request is rejected with 400 so user content is never removed silently.',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
