import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';

export class UpcomingBadgesDto {
  @ApiProperty({ example: false, description: 'episodeNumber === 1 in a canonical (season > 0) season.' })
  seasonPremiere: boolean;

  @ApiProperty({ example: false, description: 'seasonNumber === 1 && episodeNumber === 1. Implies seasonPremiere.' })
  seriesPremiere: boolean;
}

// One dated release event on the Upcoming timeline. Deliberately carries NO
// platform/network/channel field — see docs/upcoming-timeline-todo.md "Do
// not display platform". No pre-formatted localized time string either —
// this app has no per-user timezone, so localization (and the
// raw-date-vs-local-date day-bucketing rule) is entirely a client concern;
// the server only ever ships raw, unconverted values.
export class UpcomingItemDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111' })
  seriesId: string;

  @ApiProperty({ example: 'The Great Voyage' })
  seriesTitle: string;

  @ApiPropertyOptional({ example: 'https://images.example.com/great-voyage/poster.jpg', nullable: true })
  posterUrl: string | null;

  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-222222222222' })
  episodeId: string;

  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-333333333333' })
  seasonId: string;

  @ApiProperty({ example: 1 })
  seasonNumber: number;

  @ApiProperty({ example: 6 })
  episodeNumber: number;

  @ApiPropertyOptional({ example: 'Signal Lost', nullable: true })
  episodeTitle: string | null;

  @ApiProperty({ example: '2026-07-15', description: 'Raw provider calendar date, unconverted — never passed through a timezone conversion.' })
  airDateOnly: string;

  @ApiProperty({ example: '2026-07-15T00:00:00.000Z', description: 'UTC-midnight-parsed instant of airDateOnly (existing app-wide convention).' })
  airDateInstant: Date;

  @ApiProperty({
    example: false,
    description:
      'Whether airDateInstant carries a real time-of-day. Always false today (no integrated provider supplies episode time-of-day) — ' +
      'the nullable architecture is in place so a future data source is picked up automatically. When true, render the localized time; ' +
      'when false, omit any time display entirely (never a placeholder/"Unknown"/"--").',
  })
  hasKnownReleaseTime: boolean;

  @ApiProperty({ example: true, description: 'Canonical isEpisodeReleased(airDate, now) at response-build time — same predicate markWatched enforces.' })
  isReleased: boolean;

  @ApiProperty({ example: false })
  isWatched: boolean;

  @ApiPropertyOptional({
    example: null,
    nullable: true,
    description: 'EpisodeWatch id when isWatched, for DELETE /episode-watches/:watchId — reuses the existing unwatch endpoint, no new mutation API.',
  })
  episodeWatchId: string | null;

  @ApiProperty({ enum: UserSeriesStatus, example: UserSeriesStatus.WATCHING })
  seriesUserStatus: UserSeriesStatus;

  @ApiProperty({ enum: ReleaseStatus, example: ReleaseStatus.RETURNING })
  seriesReleaseStatus: ReleaseStatus;

  @ApiProperty({ type: UpcomingBadgesDto })
  badges: UpcomingBadgesDto;
}
