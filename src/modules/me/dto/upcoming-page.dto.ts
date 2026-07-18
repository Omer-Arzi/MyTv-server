import { ApiProperty } from '@nestjs/swagger';
import { UpcomingItemDto } from './upcoming-item.dto';

export class UpcomingDayBucketDto {
  @ApiProperty({ example: '2026-07-15' })
  date: string;

  @ApiProperty({ type: UpcomingItemDto, isArray: true })
  items: UpcomingItemDto[];
}

// See docs/upcoming-timeline-todo.md "Pagination" — date-window, not
// opaque-cursor. days is sparse (only dates with >=1 eligible item) — the
// client synthesizes an empty "Today" section itself when needed, since
// only the client knows its own local "today" (this app has no per-user
// timezone; the `today` field below is diagnostic only, never authoritative
// for the client's own grouping).
export class UpcomingPageDto {
  @ApiProperty({ example: '2026-07-01', description: 'Echoes the request window start (inclusive).' })
  from: string;

  @ApiProperty({ example: '2026-07-31', description: 'Echoes the request window end (exclusive).' })
  to: string;

  @ApiProperty({ example: '2026-07-15', description: 'The server\'s own UTC calendar date at response time — diagnostic only, not authoritative for client-side "Today" grouping.' })
  today: string;

  @ApiProperty({ type: UpcomingDayBucketDto, isArray: true })
  days: UpcomingDayBucketDto[];

  @ApiProperty({ example: true, description: 'True if at least one eligible episode exists with a date strictly before "from".' })
  hasMorePast: boolean;

  @ApiProperty({ example: true, description: 'True if at least one eligible episode exists with a date on/after "to".' })
  hasMoreFuture: boolean;
}
