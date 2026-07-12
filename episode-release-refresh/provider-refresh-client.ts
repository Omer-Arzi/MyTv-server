// The minimal shape refreshOneSeries (and, transitively, the sync
// scheduler) needs from a catalog provider — TMDb is the only
// implementation today, and TmdbClient already satisfies this interface
// structurally, so no wrapper/adapter class exists yet. The point of this
// interface existing at all is that refresh-one-series.ts and
// src/modules/sync-scheduler never import or reference TmdbClient's
// concrete type — only this one. Adding a second provider later (TVMaze,
// AniList, ...) means writing a class that implements
// ProviderRefreshClient, not touching the pipeline or scheduler.
//
// Deliberately reuses TMDb's own response shapes (TmdbTvDetails,
// TmdbShowWithAppendedSeasons) rather than inventing a provider-neutral DTO
// — see docs for the scheduler-architecture task's Part 8: this task
// reports future optimization/extensibility opportunities, it does not
// rewrite the existing provider integration. A genuinely provider-neutral
// response shape is exactly the kind of change that belongs to whichever
// future task actually adds a second provider, not this one.
import { TmdbShowWithAppendedSeasons, TmdbTvDetails } from '../tmdb-enrichment/tmdb-types';

export interface ProviderRefreshClient {
  getShowDetails(providerId: string): Promise<TmdbTvDetails>;
  getSeasonsBatch(providerId: string, seasonNumbers: number[]): Promise<TmdbShowWithAppendedSeasons>;
}
