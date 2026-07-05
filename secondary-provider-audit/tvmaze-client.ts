// Minimal TVmaze API client. Unlike TMDb/Trakt, TVmaze requires no API key
// or OAuth at all — every endpoint used here is fully public
// (https://www.tvmaze.com/api). Rate limit is documented as "at least 20
// calls every 10 seconds per IP" — throttled well under that (one request
// per ~550ms, ~18/10s) rather than racing the documented floor.
// fetchFn/sleepFn are injectable for tests (no network, no real waiting) —
// same shape as tmdb-client.ts.

import { TvMazeSearchResult, TvMazeShowWithEpisodes } from './tvmaze-types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepLike = (ms: number) => Promise<void>;

const DEFAULT_BASE_URL = 'https://api.tvmaze.com';
const DEFAULT_USER_AGENT = 'my-tv-server-secondary-provider-audit/0.1.0';
const DEFAULT_MIN_DELAY_MS = 550;
const DEFAULT_MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

export interface TvMazeClientOptions {
  baseUrl?: string;
  userAgent?: string;
  minDelayMs?: number;
  maxRetries?: number;
  fetchFn?: FetchLike;
  sleepFn?: SleepLike;
}

export class TvMazeRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly path: string,
  ) {
    super(message);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TvMazeClient {
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly minDelayMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: FetchLike;
  private readonly sleepFn: SleepLike;
  private lastRequestAt = 0;

  public requestCount = 0;

  constructor(options: TvMazeClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.minDelayMs = options.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchFn = options.fetchFn ?? (fetch as unknown as FetchLike);
    this.sleepFn = options.sleepFn ?? defaultSleep;
  }

  // Multi-result fuzzy search — used for scoring/close-competitor detection,
  // same role as Trakt's/TMDb's search endpoints. Each result carries
  // TVmaze's own relevance `score`, like Trakt (unlike TMDb, which exposes
  // no score, only rank order).
  async searchShows(query: string): Promise<TvMazeSearchResult[]> {
    return this.request<TvMazeSearchResult[]>('/search/shows', { q: query });
  }

  // Show details + full "regular" episode list in a single call
  // (embed=episodes) — specials/insignificant_special episodes are excluded
  // by this shorthand (confirmed empirically: TVmaze's `specials=1` query
  // param has no effect when combined with `embed=episodes`), which is
  // exactly what's wanted for comparing against MyTv's own catalog (TV
  // Time's export has no specials tracking either).
  async getShowWithEpisodes(showId: string | number): Promise<TvMazeShowWithEpisodes> {
    return this.request<TvMazeShowWithEpisodes>(`/shows/${encodeURIComponent(String(showId))}`, { embed: 'episodes' });
  }

  // Dedicated episodes endpoint including specials, for the
  // specials-count-delta signal only — deliberately a second call rather
  // than trying to fold into getShowWithEpisodes, and only ever called for
  // one already-chosen top candidate (not every search result), to keep the
  // per-series API budget small and predictable.
  async getEpisodeCountIncludingSpecials(showId: string | number): Promise<number> {
    const episodes = await this.request<Array<{ type: string }>>(`/shows/${encodeURIComponent(String(showId))}/episodes`, {
      specials: '1',
    });
    return episodes.length;
  }

  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minDelayMs) {
      await this.sleepFn(this.minDelayMs - elapsed);
    }
  }

  private async request<T>(path: string, query: Record<string, string>): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    let attempt = 0;
    for (;;) {
      await this.throttle();
      this.lastRequestAt = Date.now();
      this.requestCount += 1;

      let response: Response;
      try {
        response = await this.fetchFn(url.toString(), {
          headers: { 'User-Agent': this.userAgent },
        });
      } catch (err) {
        attempt += 1;
        if (attempt > this.maxRetries) {
          throw new TvMazeRequestError(`network error after ${this.maxRetries} retries: ${(err as Error).message}`, null, path);
        }
        await this.sleepFn(this.backoffDelay(attempt));
        continue;
      }

      if (response.status === 429) {
        attempt += 1;
        if (attempt > this.maxRetries) {
          throw new TvMazeRequestError('rate limited (429) after exhausting retries', 429, path);
        }
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
        await this.sleepFn(Number.isFinite(retryAfterMs) ? retryAfterMs : this.backoffDelay(attempt));
        continue;
      }

      if (response.status >= 500) {
        attempt += 1;
        if (attempt > this.maxRetries) {
          throw new TvMazeRequestError(`server error ${response.status} after exhausting retries`, response.status, path);
        }
        await this.sleepFn(this.backoffDelay(attempt));
        continue;
      }

      if (response.status === 404) {
        throw new TvMazeRequestError('not found', 404, path);
      }

      if (!response.ok) {
        throw new TvMazeRequestError(`unexpected status ${response.status}`, response.status, path);
      }

      return (await response.json()) as T;
    }
  }

  private backoffDelay(attempt: number): number {
    const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    const jitter = Math.random() * exponential * 0.25;
    return exponential + jitter;
  }
}
