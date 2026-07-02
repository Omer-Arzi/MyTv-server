// Minimal TMDb API client: public read endpoints only, Bearer read-access
// token auth (not OAuth — a static, account-issued long-lived token, per
// docs/tmdb-enrichment-plan.md §2). Handles TMDb's (loosely documented,
// can-change-anytime) rate limit, backs off on 429/5xx/network errors.
// Unlike Trakt, TMDb does not document a Retry-After header — this still
// opportunistically honors one if present (costs nothing, might help) but
// defaults to exponential backoff rather than assuming it'll be there.
// fetchFn/sleepFn are injectable for tests (no network, no real waiting).

import { TmdbShowWithAppendedSeasons, TmdbTvDetails, TmdbTvSearchResult } from './tmdb-types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepLike = (ms: number) => Promise<void>;

const DEFAULT_BASE_URL = 'https://api.themoviedb.org/3';
const DEFAULT_USER_AGENT = 'my-tv-server-tmdb-enrichment/0.1.0';
// TMDb's documented ceiling is "somewhere in the 40 requests per second
// range" (docs/tmdb-enrichment-plan.md §5) — paced well under that on
// purpose, same reasoning as the Trakt client.
const DEFAULT_MIN_DELAY_MS = 100;
const DEFAULT_MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
// TMDb caps append_to_response at 20 comma-separated namespaces per call.
export const MAX_APPEND_TO_RESPONSE_ITEMS = 20;

export interface TmdbClientOptions {
  accessToken: string;
  baseUrl?: string;
  userAgent?: string;
  minDelayMs?: number;
  maxRetries?: number;
  fetchFn?: FetchLike;
  sleepFn?: SleepLike;
}

export class TmdbRequestError extends Error {
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

export class TmdbClient {
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly minDelayMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: FetchLike;
  private readonly sleepFn: SleepLike;
  private lastRequestAt = 0;

  public requestCount = 0;

  constructor(private readonly options: TmdbClientOptions) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.minDelayMs = options.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchFn = options.fetchFn ?? (fetch as unknown as FetchLike);
    this.sleepFn = options.sleepFn ?? defaultSleep;
  }

  // first_air_date_year narrows server-side when a year hint is known —
  // the one place TMDb search can do less client-side filtering than Trakt's
  // (docs/tmdb-enrichment-plan.md §2/§3.1).
  async searchTv(query: string, year?: number | null): Promise<TmdbTvSearchResult[]> {
    const params: Record<string, string> = { query };
    if (year) params.first_air_date_year = String(year);
    const response = await this.request<{ results: TmdbTvSearchResult[] }>('/search/tv', params);
    return response.results;
  }

  async getShowDetails(tmdbId: string): Promise<TmdbTvDetails> {
    return this.request<TmdbTvDetails>(`/tv/${encodeURIComponent(tmdbId)}`, { append_to_response: 'external_ids' });
  }

  // seasonNumbers must already be chunked to <= MAX_APPEND_TO_RESPONSE_ITEMS
  // by the caller — this method doesn't chunk itself so its contract is
  // exactly "one HTTP call," matching how callers reason about rate limits.
  async getSeasonsBatch(tmdbId: string, seasonNumbers: number[]): Promise<TmdbShowWithAppendedSeasons> {
    if (seasonNumbers.length > MAX_APPEND_TO_RESPONSE_ITEMS) {
      throw new Error(`getSeasonsBatch: ${seasonNumbers.length} seasons exceeds TMDb's ${MAX_APPEND_TO_RESPONSE_ITEMS}-item append_to_response cap`);
    }
    const append = seasonNumbers.map((n) => `season/${n}`).join(',');
    return this.request<TmdbShowWithAppendedSeasons>(`/tv/${encodeURIComponent(tmdbId)}`, { append_to_response: append });
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
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': this.userAgent,
            Authorization: `Bearer ${this.options.accessToken}`,
          },
        });
      } catch (err) {
        attempt += 1;
        if (attempt > this.maxRetries) {
          throw new TmdbRequestError(`network error after ${this.maxRetries} retries: ${(err as Error).message}`, null, path);
        }
        await this.sleepFn(this.backoffDelay(attempt));
        continue;
      }

      if (response.status === 429) {
        attempt += 1;
        if (attempt > this.maxRetries) {
          throw new TmdbRequestError('rate limited (429) after exhausting retries', 429, path);
        }
        // Not documented by TMDb, but honor it if present rather than
        // assuming — see file header.
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
        await this.sleepFn(Number.isFinite(retryAfterMs) ? retryAfterMs : this.backoffDelay(attempt));
        continue;
      }

      if (response.status >= 500) {
        attempt += 1;
        if (attempt > this.maxRetries) {
          throw new TmdbRequestError(`server error ${response.status} after exhausting retries`, response.status, path);
        }
        await this.sleepFn(this.backoffDelay(attempt));
        continue;
      }

      if (response.status === 404) {
        throw new TmdbRequestError('not found', 404, path);
      }

      if (!response.ok) {
        throw new TmdbRequestError(`unexpected status ${response.status}`, response.status, path);
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
