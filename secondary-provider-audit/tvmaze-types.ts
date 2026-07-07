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
  // Optional — always present on the real API but not read by any existing
  // caller, so kept optional here to avoid touching test fixtures that
  // construct this shape without them.
  network?: { name: string; country: { name: string; code: string } | null } | null;
  webChannel?: { name: string; country: { name: string; code: string } | null } | null;
  // Present on the real API, added for library-health/run-provider-confirmation.ts's
  // "poster availability" comparison field — same "optional, always present
  // on the real API" convention as network/webChannel above.
  image?: { medium: string | null; original: string | null } | null;
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
  // Present on the real API but optional here — no existing caller reads
  // these (the secondary-provider audit only needs season/number/name/
  // airdate for chronological-position comparison); added for the targeted
  // Mom TVmaze enrichment, which needs runtime/summary to populate newly
  // created Episode rows.
  runtime?: number | null;
  summary?: string | null; // HTML-formatted, e.g. "<p>...</p>"
}
