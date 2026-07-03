import { ApiProperty } from '@nestjs/swagger';
import { SeriesCardDto } from './series-card.dto';

export class SeriesListPageDto {
  @ApiProperty({ type: [SeriesCardDto] })
  items: SeriesCardDto[];

  @ApiProperty({
    example: 'M2Y2YjFlMmEtOGMxZC00YjJhLTllMmUtMTExMTExMTExMTEx',
    nullable: true,
    description: 'Pass as ?cursor= to fetch the next page. Null when there are no more items.',
  })
  nextCursor: string | null;
}
