import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';

export class SeriesListQueryDto {
  @ApiPropertyOptional({
    enum: UserSeriesStatus,
    description: 'Filter to series at exactly this personal userStatus (e.g. WATCHING for "what am I currently watching").',
  })
  @IsOptional()
  @IsEnum(UserSeriesStatus)
  status?: UserSeriesStatus;

  @ApiPropertyOptional({
    enum: ReleaseStatus,
    description: 'Filter to series whose public releaseStatus is exactly this value.',
  })
  @IsOptional()
  @IsEnum(ReleaseStatus)
  releaseStatus?: ReleaseStatus;

  @ApiPropertyOptional({ example: 'dragon', maxLength: 200, description: 'Case-insensitive substring search on title.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ example: 20, default: 20, minimum: 1, maximum: 50, description: 'Max number of series to return.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;

  @ApiPropertyOptional({
    description: 'Opaque cursor from a previous response\'s nextCursor. Returns the next page after that cursor.',
    example: 'M2Y2YjFlMmEtOGMxZC00YjJhLTllMmUtMTExMTExMTExMTEx',
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}
