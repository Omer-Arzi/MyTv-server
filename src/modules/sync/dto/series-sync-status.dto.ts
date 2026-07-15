import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SeriesSyncStatusDto {
  @ApiPropertyOptional({ nullable: true, description: 'Null if this series has never been checked.' })
  lastCheckedAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  lastSuccessfulCheckAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  nextEligibleCheckAt: string | null;

  @ApiProperty()
  refreshInProgress: boolean;

  @ApiPropertyOptional({ nullable: true })
  lastChangeAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  lastEpisodesAdded: number | null;

  @ApiPropertyOptional({ nullable: true })
  lastSeasonsAdded: number | null;

  @ApiProperty()
  requiresManualReview: boolean;

  @ApiPropertyOptional({ nullable: true })
  lastLocalActivationAt: string | null;
}

// The client-facing outcome of an on-demand refresh request (manual
// single-series, or the series-page stale-on-open check) — deliberately
// user-safe wording only (Part 11: "avoid exposing internal provider or
// migration jargon to normal users"); detailed diagnostics stay in server
// logs (Part 15), never this response.
export class SeriesRefreshResultDto {
  @ApiProperty({ enum: ['refreshed', 'not-tracked', 'ineligible', 'already-in-progress', 'not-stale', 'error'] })
  outcome: 'refreshed' | 'not-tracked' | 'ineligible' | 'already-in-progress' | 'not-stale' | 'error';

  @ApiProperty()
  message: string;

  @ApiProperty({ type: SeriesSyncStatusDto })
  syncStatus: SeriesSyncStatusDto;
}
