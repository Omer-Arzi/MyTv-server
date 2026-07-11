// Shapes of TMDb API responses this enrichment pass consumes. Only the
// fields actually read are typed — see docs/tmdb-enrichment-plan.md §2 for
// the full field list TMDb returns.
//
// Note the TV-object field is `name`, not `title` (that's the movie-object
// field) — deliberately named `name` below too, not aliased, so a mismatch
// against the real API response would show up as a type error rather than
// silently reading `undefined`.

export interface TmdbTvSearchResult {
  id: number;
  name: string;
  first_air_date: string | null;
  overview?: string | null;
  poster_path?: string | null;
  popularity?: number;
}

export interface TmdbTvSearchResponse {
  page: number;
  results: TmdbTvSearchResult[];
  total_results: number;
  total_pages: number;
}

export interface TmdbExternalIds {
  imdb_id?: string | null;
  tvdb_id?: number | null;
}

export interface TmdbGenre {
  id: number;
  name: string;
}

export interface TmdbTvDetails {
  id: number;
  name: string;
  overview?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  first_air_date?: string | null;
  status?: string | null;
  number_of_seasons?: number;
  number_of_episodes?: number;
  genres?: TmdbGenre[];
  original_language?: string | null;
  origin_country?: string[];
  external_ids?: TmdbExternalIds;
}

export interface TmdbEpisode {
  id: number;
  name: string | null;
  overview?: string | null;
  air_date?: string | null;
  episode_number: number;
  season_number: number;
  still_path?: string | null;
  // Minutes, per TMDb's season/episode payloads — genuinely nullable when
  // TMDb hasn't recorded a runtime for that episode yet, not just an
  // absent field.
  runtime?: number | null;
}

export interface TmdbSeason {
  id: number;
  season_number: number;
  name?: string | null;
  overview?: string | null;
  episodes?: TmdbEpisode[];
}

// GET /tv/{id}?append_to_response=season/1,season/2,... comes back with each
// appended season as a top-level key literally named "season/1", "season/2"
// (a real TMDb quirk, not a typo) rather than nested under a "seasons"
// array — a plain interface can't express a dynamic key like that, so
// callers read it via getAppendedSeason() below instead of direct property access.
export type TmdbShowWithAppendedSeasons = Record<string, unknown>;

export function getAppendedSeason(response: TmdbShowWithAppendedSeasons, seasonNumber: number): TmdbSeason | undefined {
  return response[`season/${seasonNumber}`] as TmdbSeason | undefined;
}
