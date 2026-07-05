// Minimal typed slices of TVmaze's API responses — only the fields this
// audit actually reads. See https://www.tvmaze.com/api.

export interface TvMazeSearchResult {
  score: number;
  show: TvMazeShowSummary;
}

export interface TvMazeShowSummary {
  id: number;
  name: string;
  premiered: string | null; // "YYYY-MM-DD"
  ended: string | null;
  status: string | null; // "Running" | "Ended" | "To Be Determined" | ...
  genres: string[];
  language: string | null;
}

export interface TvMazeShowWithEpisodes extends TvMazeShowSummary {
  _embedded?: {
    episodes?: TvMazeEpisode[];
  };
}

export type TvMazeEpisodeType = 'regular' | 'significant_special' | 'insignificant_special' | string;

export interface TvMazeEpisode {
  id: number;
  name: string;
  season: number;
  number: number | null; // null for some specials
  type: TvMazeEpisodeType;
  airdate: string | null; // "YYYY-MM-DD"
  airstamp: string | null;
}
