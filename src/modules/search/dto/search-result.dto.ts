import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserSeriesStatus } from '@prisma/client';

export class SearchResultNextEpisodeDto {
  @ApiProperty({ example: '3f6b1e2a-8c1d-4b2a-9e2e-222222222222' })
  id: string;

  @ApiProperty({ example: 2 })
  seasonNumber: number;

  @ApiProperty({ example: 4 })
  episodeNumber: number;

  @ApiPropertyOptional({ nullable: true, example: 'Season of the Hunter' })
  title: string | null;
}

export class SearchResultProviderRefDto {
  @ApiProperty({ enum: ['tmdb', 'tvmaze'], example: 'tmdb' })
  provider: 'tmdb' | 'tvmaze';

  @ApiProperty({ example: '95396' })
  providerId: string;
}

// A discriminated union (type: 'EXACT'|'POSSIBLE'|'NONE') can't be
// expressed as one @nestjs/swagger class cleanly, so every field from every
// variant is modeled as optional here and the client discriminates on
// `type` — same pragmatic approach this codebase already takes for
// MigrationWorkbenchItemDto's optional `proposal` field.
export class SearchResultLibraryMatchDto {
  @ApiProperty({ enum: ['EXACT', 'POSSIBLE', 'NONE'], example: 'EXACT' })
  type: 'EXACT' | 'POSSIBLE' | 'NONE';

  @ApiPropertyOptional({ nullable: true, example: '3f6b1e2a-8c1d-4b2a-9e2e-111111111111', description: 'Set for EXACT and POSSIBLE.' })
  seriesId?: string;

  @ApiPropertyOptional({ enum: UserSeriesStatus, nullable: true, description: 'Set for EXACT.' })
  userStatus?: UserSeriesStatus;

  @ApiPropertyOptional({ type: SearchResultNextEpisodeDto, nullable: true, description: 'Set for EXACT when a next episode is known; null otherwise.' })
  nextEpisode?: SearchResultNextEpisodeDto | null;

  @ApiPropertyOptional({ description: 'Set for EXACT — true if this series still needs identity/structure review despite already existing locally.' })
  needsAttention?: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'Set for EXACT when needsAttention is true.' })
  attentionReasonCode?: string | null;

  @ApiPropertyOptional({ description: 'Set for POSSIBLE.' })
  seriesTitle?: string;

  @ApiPropertyOptional({ enum: UserSeriesStatus, description: 'Set for POSSIBLE.' })
  seriesUserStatus?: UserSeriesStatus;

  @ApiPropertyOptional({ minimum: 0, maximum: 1, description: 'Set for POSSIBLE — canonical 0..1 confidence scale.' })
  confidence?: number;

  @ApiPropertyOptional({ description: 'Set for POSSIBLE — plain-language reason, never a raw score.' })
  reason?: string;
}

export class SeriesSearchResultDto {
  @ApiProperty({ example: 'series:3f6b1e2a-8c1d-4b2a-9e2e-111111111111', description: 'Stable across pages — use for list keys.' })
  resultKey: string;

  @ApiProperty({ example: 'Frieren: Beyond Journey\'s End' })
  title: string;

  @ApiPropertyOptional({ nullable: true, example: 2023 })
  year: number | null;

  @ApiPropertyOptional({ nullable: true })
  posterUrl: string | null;

  @ApiProperty({ type: [SearchResultProviderRefDto] })
  providers: SearchResultProviderRefDto[];

  @ApiProperty({ type: SearchResultLibraryMatchDto })
  libraryMatch: SearchResultLibraryMatchDto;

  @ApiProperty({ enum: ['OPEN_SERIES', 'REVIEW_SERIES', 'COMPARE_MATCH', 'ADD_TO_WATCHLIST'], example: 'OPEN_SERIES' })
  primaryAction: 'OPEN_SERIES' | 'REVIEW_SERIES' | 'COMPARE_MATCH' | 'ADD_TO_WATCHLIST';

  @ApiProperty({ example: 110 })
  relevanceScore: number;
}

export class SearchResultsPageDto {
  @ApiProperty({ type: [SeriesSearchResultDto] })
  results: SeriesSearchResultDto[];

  @ApiPropertyOptional({ nullable: true, description: 'Pass back as ?cursor= to load the next page; null when there is nothing more.' })
  nextCursor: string | null;

  @ApiProperty({ description: 'True when at least one provider failed for this query but the others still returned usable results.' })
  hadProviderFailure: boolean;
}
