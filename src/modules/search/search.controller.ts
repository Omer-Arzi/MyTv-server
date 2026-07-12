import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types';
import { WatchlistItemDto } from '../watchlist/dto/watchlist-item.dto';
import { SearchService } from './search.service';
import { SearchQueryDto } from './dto/search-query.dto';
import { AddSearchResultDto } from './dto/add-search-result.dto';
import { SearchResultsPageDto } from './dto/search-result.dto';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiOperation({
    summary: 'Library-aware series search',
    description:
      'Queries TMDb and TVmaze in parallel (one provider failing still returns the other\'s results — see hadProviderFailure) and overlays each result with this ' +
      'user\'s local-library state. A confirmed local match is returned as EXACT and never duplicated as a separate new-series result. A local series with no ' +
      'confirmed provider identity yet is also returned as EXACT with needsAttention: true (routes to the existing Migration Workbench review flow) when the ' +
      'title match is confident, or as POSSIBLE (routes to a comparison flow) when it is not. Queries under 2 characters return an empty page.',
  })
  @ApiOkResponse({ type: SearchResultsPageDto })
  async search(@CurrentUser() user: RequestUser, @Query() query: SearchQueryDto): Promise<SearchResultsPageDto> {
    const q = (query.q ?? '').trim();
    if (q.length < 2) return { results: [], nextCursor: null, hadProviderFailure: false };
    return this.searchService.search(user.id, q, query.cursor ?? null);
  }

  @Post('add')
  @ApiOperation({
    summary: 'Add a new series found via search to the watchlist',
    description:
      'Idempotent and identity-revalidating: only (provider, providerId) is trusted from the client — title/poster/overview/releaseStatus are always fetched ' +
      'fresh from the provider here, never from a possibly-stale search response. If this provider identity already resolves to an existing series (added by ' +
      'this request or a previous one), returns that series rather than creating a duplicate. Defaults the new series to WATCHLIST, same as adding any other series.',
  })
  @ApiOkResponse({ type: WatchlistItemDto })
  async add(@CurrentUser() user: RequestUser, @Body() body: AddSearchResultDto): Promise<WatchlistItemDto> {
    return this.searchService.addSearchResult(user.id, body.provider, body.providerId);
  }
}
