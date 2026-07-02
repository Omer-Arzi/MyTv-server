import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class RecentlyWatchedQueryDto {
  @ApiPropertyOptional({
    example: 10,
    default: 10,
    minimum: 1,
    maximum: 50,
    description: 'Max number of watched episodes to return.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 10;

  @ApiPropertyOptional({
    description:
      'Opaque cursor from a previous response\'s nextCursor. Returns the page of items watched before that cursor.',
    example: 'M2Y2YjFlMmEtOGMxZC00YjJhLTllMmUtNDQ0NDQ0NDQ0NDQ0',
  })
  @IsOptional()
  @IsString()
  before?: string;
}
