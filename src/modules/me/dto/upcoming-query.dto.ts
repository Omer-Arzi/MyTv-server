import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Date-window pagination, not opaque-cursor — see
// docs/upcoming-timeline-todo.md "Pagination" for why. Both are required
// (unlike every other endpoint's optional-with-default params) because the
// window itself IS the pagination state and is entirely client-owned — the
// mobile client always knows its own local "today" and picks the window
// around it; the server has no sensible default "today" of its own (no
// per-user timezone exists in this app).
export class UpcomingQueryDto {
  @ApiProperty({
    example: '2026-07-01',
    description: 'Start of the window (inclusive), plain calendar date "YYYY-MM-DD". Interpreted identically to a provider airDate (UTC-midnight-of-that-date).',
  })
  @Matches(DATE_ONLY_PATTERN, { message: 'from must be a plain YYYY-MM-DD date' })
  from: string;

  @ApiProperty({
    example: '2026-07-31',
    description: 'End of the window (exclusive), plain calendar date "YYYY-MM-DD". Window (from, to] span must be between 1 and 45 days.',
  })
  @Matches(DATE_ONLY_PATTERN, { message: 'to must be a plain YYYY-MM-DD date' })
  to: string;
}
