import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class SearchQueryDto {
  @ApiPropertyOptional({ example: 'frieren', description: 'Minimum 2 characters — shorter queries return an empty page rather than a 400, so a fast-typing client never needs to special-case it.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  q?: string;

  @ApiPropertyOptional({ example: '2', description: 'Opaque — pass back nextCursor from the previous page verbatim.' })
  @IsOptional()
  @IsString()
  cursor?: string;
}
