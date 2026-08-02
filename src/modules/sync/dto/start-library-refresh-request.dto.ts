import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsOptional } from 'class-validator';
import { UserSeriesStatus } from '@prisma/client';

export class StartLibraryRefreshRequestDto {
  @ApiPropertyOptional({
    enum: UserSeriesStatus,
    isArray: true,
    description:
      'Narrow this run to only series at one of these personal statuses (e.g. ["COMPLETED", "CAUGHT_UP"]). ' +
      'Omit (or send an empty array) to refresh every tracked status, matching the previous whole-library behavior.',
  })
  @IsOptional()
  @IsArray()
  @IsEnum(UserSeriesStatus, { each: true })
  statuses?: UserSeriesStatus[];
}
