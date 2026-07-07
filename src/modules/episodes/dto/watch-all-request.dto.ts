import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class WatchAllRequestDto {
  @ApiPropertyOptional({
    default: false,
    description: 'Preview what would be created/changed without writing anything.',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Include episodes with no known airDate as eligible to mark watched. Excluded by default — a missing ' +
      'airDate could mean "already aired, just not recorded" or "not aired yet," and there is no way to tell ' +
      'them apart, so the conservative default is to leave them alone.',
  })
  @IsOptional()
  @IsBoolean()
  includeUnknownAirDate?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: 'Required to be true if this series\' current userStatus is DROPPED or PAUSED — otherwise the request is rejected.',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
