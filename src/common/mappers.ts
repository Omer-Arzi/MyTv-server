import { Episode, Season, Series } from '@prisma/client';
import { EpisodeSummaryDto } from './dto/episode-summary.dto';
import { SeriesSummaryDto } from './dto/series-summary.dto';

export function toSeriesSummary(series: Series): SeriesSummaryDto {
  return {
    id: series.id,
    title: series.title,
    overview: series.overview,
    posterUrl: series.posterUrl,
    releaseStatus: series.releaseStatus,
  };
}

export function toEpisodeSummary(episode: Episode & { season: Season }): EpisodeSummaryDto {
  return {
    id: episode.id,
    seasonId: episode.seasonId,
    seasonNumber: episode.season.seasonNumber,
    episodeNumber: episode.episodeNumber,
    title: episode.title,
    overview: episode.overview,
    airDate: episode.airDate,
    runtimeMinutes: episode.runtimeMinutes,
  };
}
