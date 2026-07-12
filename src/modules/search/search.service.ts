// Orchestrates the Search feature end to end: federated provider search
// (search-provider-fanout.ts) -> local-library overlay + matching
// (search-matching-logic.ts) -> same-local-identity dedup -> ranking
// (search-ranking-logic.ts) -> pagination. Never a second identity-matching
// or provider-client implementation — reuses TmdbClient/TvMazeClient
// exactly as MigrationWorkbenchService already constructs them (no NestJS
// DI provider for either client in this codebase, same convention here).

import { BadRequestException, Injectable } from '@nestjs/common';
import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TmdbClient } from '../../../tmdb-enrichment/tmdb-client';
import { TvMazeClient } from '../../../secondary-provider-audit/tvmaze-client';
import { tmdbImageUrl } from '../../../tmdb-enrichment/apply-plan-writes';
import { mapTmdbStatusToReleaseStatus } from '../../../tmdb-enrichment/release-status-mapping';
import { extractTitleYearHint } from '../../../trakt-enrichment/scoring';
import { checkTitleYearSanity } from '../../../library-health/provider-confirmation-decisions-logic';
import { classifyIdentityConfidence } from '../../../library-health/migration-policy-logic';
import { hasConfirmedExternalId } from '../../common/has-confirmed-external-id';
import { WatchlistService } from '../watchlist/watchlist.service';
import { WatchlistItemDto } from '../watchlist/dto/watchlist-item.dto';
import { FanoutCandidate, searchProviders } from './search-provider-fanout';
import { LibrarySnapshotEntry, matchCandidateAgainstLibrary } from './search-matching-logic';
import { computeRelevanceScore, rankSearchResults } from './search-ranking-logic';
import { SearchProvider, SearchPrimaryAction, SearchResultsPage, SeriesSearchResult } from './search-types';

const RESULTS_PER_PAGE = 20;

function primaryActionFor(result: Pick<SeriesSearchResult, 'libraryMatch'>): SearchPrimaryAction {
  const match = result.libraryMatch;
  if (match.type === 'EXACT') return match.needsAttention ? 'REVIEW_SERIES' : 'OPEN_SERIES';
  if (match.type === 'POSSIBLE') return 'COMPARE_MATCH';
  return 'ADD_TO_WATCHLIST';
}

function resultKeyFor(candidate: FanoutCandidate, match: SeriesSearchResult['libraryMatch']): string {
  if (match.type === 'EXACT' || match.type === 'POSSIBLE') return `series:${match.seriesId}`;
  return `provider:${candidate.provider}:${candidate.providerId}`;
}

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly watchlistService: WatchlistService,
  ) {}

  async search(userId: string, query: string, cursor: string | null): Promise<SearchResultsPage> {
    const accessToken = this.requireTmdbAccessToken();
    const tmdb = new TmdbClient({ accessToken });
    const tvmaze = new TvMazeClient();

    const tmdbPage = cursor ? Number(cursor) : 1;
    const [library, fanout] = await Promise.all([this.loadLibrarySnapshot(userId), searchProviders({ tmdb, tvmaze, query, tmdbPage })]);

    // Same-local-identity dedup only (see search-provider-fanout.ts's file
    // header): group by the LOCAL match's seriesId when one was found, else
    // each provider hit stays its own card — never a speculative
    // cross-provider merge of two un-owned external results.
    const bySeriesKey = new Map<string, { candidate: FanoutCandidate; providers: Array<{ provider: SearchProvider; providerId: string }>; libraryMatch: SeriesSearchResult['libraryMatch'] }>();

    for (const candidate of fanout.candidates) {
      const libraryMatch = matchCandidateAgainstLibrary(candidate, library);
      const key = resultKeyFor(candidate, libraryMatch);
      const existing = bySeriesKey.get(key);
      if (existing) {
        existing.providers.push({ provider: candidate.provider, providerId: candidate.providerId });
        // TMDb is the richer/primary provider — prefer its metadata for the
        // merged card if a TMDb hit merges with an already-seen TVmaze hit.
        if (candidate.provider === 'tmdb') existing.candidate = candidate;
        continue;
      }
      bySeriesKey.set(key, { candidate, providers: [{ provider: candidate.provider, providerId: candidate.providerId }], libraryMatch });
    }

    const results: SeriesSearchResult[] = [...bySeriesKey.values()].map(({ candidate, providers, libraryMatch }) => {
      const base = { title: candidate.title, year: candidate.year, posterUrl: candidate.posterUrl, providers, libraryMatch };
      const relevanceScore = computeRelevanceScore(base, query);
      return { resultKey: resultKeyFor(candidate, libraryMatch), ...base, primaryAction: primaryActionFor(base), relevanceScore };
    });

    const ranked = rankSearchResults(results).slice(0, RESULTS_PER_PAGE);
    const nextCursor = fanout.candidates.length > 0 ? String(tmdbPage + 1) : null;

    return { results: ranked, nextCursor, hadProviderFailure: fanout.failedProviders.length > 0 };
  }

  // Server-side re-validation: only (provider, providerId) is ever trusted
  // from the client (mirrors ConfirmIdentityDto's own posture) — every
  // other field (title/poster/overview/releaseStatus) is fetched fresh from
  // the provider here, never taken from whatever the search response
  // showed at query time. Idempotent: adding an already-added provider
  // identity returns the existing series, never a duplicate.
  async addSearchResult(userId: string, provider: SearchProvider, providerId: string): Promise<WatchlistItemDto> {
    const existing = await this.findExistingSeriesForProviderIdentity(provider, providerId);
    if (existing) {
      return this.watchlistService.add(userId, existing.seriesId);
    }

    const accessToken = this.requireTmdbAccessToken();
    const tmdb = new TmdbClient({ accessToken });
    const created = provider === 'tmdb' ? await this.createSeriesFromTmdb(tmdb, providerId) : await this.createSeriesFromTvMaze(tmdb, providerId);
    return this.watchlistService.add(userId, created.seriesId);
  }

  private async findExistingSeriesForProviderIdentity(provider: SearchProvider, providerId: string): Promise<{ seriesId: string } | null> {
    const row =
      provider === 'tmdb'
        ? await this.prisma.externalIds.findFirst({ where: { tmdbId: providerId }, select: { seriesId: true } })
        : await this.prisma.externalIds.findFirst({ where: { provider: 'tvmaze', providerId }, select: { seriesId: true } });
    return row;
  }

  private async createSeriesFromTmdb(tmdb: TmdbClient, providerId: string): Promise<{ seriesId: string }> {
    const details = await tmdb.getShowDetails(providerId);
    const series = await this.prisma.series.create({
      data: {
        title: details.name,
        overview: details.overview ?? null,
        posterUrl: tmdbImageUrl(details.poster_path),
        backdropUrl: tmdbImageUrl(details.backdrop_path),
        releaseStatus: mapTmdbStatusToReleaseStatus(details.status),
      },
    });
    await this.prisma.externalIds.create({
      data: {
        seriesId: series.id,
        tmdbId: providerId,
        imdbId: details.external_ids?.imdb_id ?? null,
        provider: 'tmdb',
        providerId,
        matchConfidence: 1,
        matchSource: 'search-add',
        matchedAt: new Date(),
      },
    });
    return { seriesId: series.id };
  }

  // TVmaze has no equivalent to TMDb's syncable ExternalIds.tmdbId column —
  // the background sync scheduler (episode-sync-scheduler.service.ts) only
  // ever picks up a series with a tmdbId set. Without a crosswalk, a
  // TVmaze-only add would silently never get its episode catalog populated.
  // Opportunistically resolves a TMDb id via one extra exact-title search —
  // only trusted at HIGH_CONFIDENCE (checkTitleYearSanity + classifyIdentityConfidence,
  // the same identity bar used everywhere else in this codebase); left null
  // rather than guessed if no clean match is found.
  private async createSeriesFromTvMaze(tmdb: TmdbClient, providerId: string): Promise<{ seriesId: string }> {
    const tvmaze = new TvMazeClient();
    const details = await tvmaze.getShowWithEpisodes(providerId);
    const year = details.premiered ? Number(details.premiered.slice(0, 4)) : null;

    let crosswalkTmdbId: string | null = null;
    let crosswalkImdbId: string | null = null;
    try {
      const hint = extractTitleYearHint(details.name);
      const candidates = await tmdb.searchTv(hint.bareTitle, hint.titleYear ?? year ?? undefined);
      const top = candidates[0];
      if (top) {
        const sanity = checkTitleYearSanity({ localTitle: details.name, candidateTitle: top.name, candidateYear: top.first_air_date ? Number(top.first_air_date.slice(0, 4)) : null });
        const band = classifyIdentityConfidence({ titleYearSanityPassed: sanity.passed, similarity: sanity.passed ? 1 : 0 });
        if (band === 'HIGH_CONFIDENCE') {
          crosswalkTmdbId = String(top.id);
          const tmdbDetails = await tmdb.getShowDetails(crosswalkTmdbId);
          crosswalkImdbId = tmdbDetails.external_ids?.imdb_id ?? null;
        }
      }
    } catch {
      // Best-effort only — a failed crosswalk never blocks the add itself.
    }

    const series = await this.prisma.series.create({
      data: {
        title: details.name,
        posterUrl: details.image?.original ?? details.image?.medium ?? null,
        releaseStatus: mapTvMazeStatusToReleaseStatus(details.status),
      },
    });
    await this.prisma.externalIds.create({
      data: {
        seriesId: series.id,
        tmdbId: crosswalkTmdbId,
        imdbId: crosswalkImdbId,
        provider: 'tvmaze',
        providerId,
        matchConfidence: 1,
        matchSource: 'search-add',
        matchedAt: new Date(),
      },
    });
    return { seriesId: series.id };
  }

  private async loadLibrarySnapshot(userId: string): Promise<LibrarySnapshotEntry[]> {
    const rows = await this.prisma.userSeriesProgress.findMany({
      where: { userId },
      include: {
        series: { include: { externalIds: true } },
        nextEpisode: { include: { season: true } },
      },
    });

    return rows.map((row) => ({
      seriesId: row.seriesId,
      title: row.series.title,
      userStatus: row.userStatus as UserSeriesStatus,
      tmdbId: row.series.externalIds?.tmdbId ?? null,
      provider: row.series.externalIds?.provider ?? null,
      providerId: row.series.externalIds?.providerId ?? null,
      hasConfirmedProviderMatch: hasConfirmedExternalId(row.series.externalIds),
      nextEpisode: row.nextEpisode ? { id: row.nextEpisode.id, seasonNumber: row.nextEpisode.season.seasonNumber, episodeNumber: row.nextEpisode.episodeNumber, title: row.nextEpisode.title } : null,
    }));
  }

  private requireTmdbAccessToken(): string {
    const accessToken = process.env.TMDB_ACCESS_TOKEN;
    if (!accessToken) throw new BadRequestException('Server is missing TMDB_ACCESS_TOKEN — cannot search providers.');
    return accessToken;
  }
}

function mapTvMazeStatusToReleaseStatus(rawStatus: string | null | undefined): ReleaseStatus {
  switch (rawStatus) {
    case 'Running':
      return ReleaseStatus.RETURNING;
    case 'Ended':
      return ReleaseStatus.ENDED;
    default:
      return ReleaseStatus.UNKNOWN;
  }
}
