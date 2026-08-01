import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class DeleteSeriesRequestDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'Must be true to actually delete. Omitted or false returns a preview (title, season/episode/watched-episode ' +
      'counts) without deleting anything — this is a hard, irreversible delete of the whole Series row and every ' +
      'season/episode/watch under it, so callers should always show the preview to the user before setting this.',
  })
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}
