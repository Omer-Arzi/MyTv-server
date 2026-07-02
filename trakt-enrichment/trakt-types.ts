// Shapes of Trakt API responses this enrichment pass consumes. Only the
// fields we actually read are typed — Trakt returns much more per object
// (see docs/trakt-enrichment-plan.md §2) but there's no value in modeling
// fields nothing here uses.

export interface TraktIds {
  trakt: number;
  slug: string | null;
  tvdb: number | null;
  imdb: string | null;
  tmdb: number | null;
}

export interface TraktShowSummary {
  title: string;
  year: number | null;
  ids: TraktIds;
}

export interface TraktSearchResult {
  score: number;
  type: string;
  show: TraktShowSummary;
}

export interface TraktImages {
  poster?: string[];
  fanart?: string[];
  banner?: string[];
  logo?: string[];
  clearart?: string[];
  thumb?: string[];
}

export interface TraktShowFull extends TraktShowSummary {
  overview?: string | null;
  status?: string | null;
  images?: TraktImages;
}

export interface TraktEpisodeSummary {
  season: number;
  number: number;
  title: string | null;
  overview?: string | null;
  first_aired?: string | null;
  ids?: { trakt: number; tvdb: number | null; imdb: string | null; tmdb: number | null };
  images?: TraktImages;
}

export interface TraktSeasonWithEpisodes {
  number: number;
  ids?: { trakt: number; tvdb: number | null; tmdb: number | null };
  episode_count?: number;
  aired_episodes?: number;
  title?: string | null;
  overview?: string | null;
  episodes?: TraktEpisodeSummary[];
  images?: TraktImages;
}
