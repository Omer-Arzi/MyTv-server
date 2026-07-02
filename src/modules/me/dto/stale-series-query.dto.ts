import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class StaleSeriesQueryDto {
  @ApiPropertyOptional({
    example: 30,
    default: 30,
    minimum: 1,
    maximum: 3650,
    description: 'Return series whose lastWatchedAt is older than this many days.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  afterDays: number = 30;
}
