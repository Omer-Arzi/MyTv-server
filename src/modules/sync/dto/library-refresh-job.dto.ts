import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LibraryRefreshJobDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: ['RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'] })
  status: 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

  @ApiProperty()
  startedAt: string;

  @ApiPropertyOptional({ nullable: true })
  finishedAt: string | null;

  @ApiProperty()
  totalSeries: number;

  @ApiProperty()
  checkedSeries: number;

  @ApiProperty()
  seriesWithNewEpisodes: number;

  @ApiProperty()
  seriesWithNewSeasons: number;

  @ApiProperty()
  seriesFailed: number;

  @ApiProperty()
  seriesManualReview: number;

  @ApiProperty()
  seriesActivatedLocally: number;

  @ApiPropertyOptional({ nullable: true, description: 'User-safe — never raw provider/SQL error text.' })
  lastError: string | null;
}

// Library-wide aggregate info the Settings screen needs alongside the
// latest job — automatic-scheduling facts that aren't tied to any single
// manual run (Part 11's "Last provider check" / "Last release activation"
// at the library level).
export class LibraryRefreshStatusDto {
  @ApiPropertyOptional({ type: LibraryRefreshJobDto, nullable: true })
  latestJob: LibraryRefreshJobDto | null;

  @ApiProperty({ description: 'Always true today — automatic scheduling has no user-facing disable switch.' })
  automaticUpdatesEnabled: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'The most recent lastEpisodeRefreshAt across the whole library (any trigger).' })
  lastAutomaticCheckAt: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'The most recent lastLocalActivationAt across the whole library.' })
  lastLocalActivationAt: string | null;
}
