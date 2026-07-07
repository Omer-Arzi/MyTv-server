import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { DEFAULT_STALE_AFTER_DAYS } from '../../../common/stale-series-trust';

export class StaleSeriesQueryDto {
  @ApiPropertyOptional({
    example: DEFAULT_STALE_AFTER_DAYS,
    default: DEFAULT_STALE_AFTER_DAYS,
    minimum: 1,
    maximum: 3650,
    description: 'Return series whose lastWatchedAt is older than this many days. Defaults to 90 (~3 months) — the product definition of "haven\'t watched for a while".',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  afterDays: number = DEFAULT_STALE_AFTER_DAYS;
}
