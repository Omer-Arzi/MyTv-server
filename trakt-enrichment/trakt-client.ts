// Minimal Trakt API client: public GET endpoints only, no OAuth (per
// docs/trakt-enrichment-plan.md §2 — a trakt-api-key/client_id header is
// sufficient for /search, /shows/:id, /shows/:id/seasons). Handles the
// documented rate limit (1000 GET/5min), 429 + Retry-After, and backoff for
// transient failures. fetchFn/sleepFn are injectable so this is unit
// testable without a network or real waiting.

import { TraktSearchResult, TraktShowFull, TraktSeasonWithEpisodes } from './trakt-types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepLike = (ms: number) => Promise<void>;

const DEFAULT_BASE_URL = 'https://api.trakt.tv';
const DEFAULT_USER_AGENT = 'my-tv-server-trakt-enrichment/0.1.0';
// Conservative pace well under the documented 1000-per-5-minutes limit
// (docs/trakt-enrichment-plan.md §5) — this is a background job with no
// user waiting on it, so headroom costs nothing.
const DEFAULT_MIN_DELAY_MS = 250;
const DEFAULT_MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

export interface TraktClientOptions {
  clientId: string;
  baseUrl?: string;
  userAgent?: string;
  minDelayMs?: number;
  maxRetries?: number;
  fetchFn?: FetchLike;
  sleepFn?: SleepLike;
}

export class TraktRequestError extends Error {
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

export class TraktClient {
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly minDelayMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: FetchLike;
  private readonly sleepFn: SleepLike;
  private lastRequestAt = 0;

  public requestCount = 0;

  constructor(private readonly options: TraktClientOptions) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.minDelayMs = options.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchFn = options.fetchFn ?? (fetch as unknown as FetchLike);
    this.sleepFn = options.sleepFn ?? defaultSleep;
  }

  async searchShow(query: string, limit = 10): Promise<TraktSearchResult[]> {
    return this.request<TraktSearchResult[]>('/search/show', { query, limit: String(limit) });
  }

  async getShow(idOrSlug: string): Promise<TraktShowFull> {
    return this.request<TraktShowFull>(`/shows/${encodeURIComponent(idOrSlug)}`, { extended: 'full' });
  }

  async getSeasonsWithEpisodes(idOrSlug: string): Promise<TraktSeasonWithEpisodes[]> {
    return this.request<TraktSeasonWithEpisodes[]>(`/shows/${encodeURIComponent(idOrSlug)}/seasons`, {
      extended: 'full,episodes',
    });
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
            'trakt-api-key': this.options.clientId,
            'trakt-api-version': '2',
          },
        });
      } catch (err) {
        attempt += 1;
        if (attempt > this.maxRetries) {
          throw new TraktRequestError(`network error after ${this.maxRetries} retries: ${(err as Error).message}`, null, path);
        }
        await this.sleepFn(this.backoffDelay(attempt));
        continue;
      }

      if (response.status === 429) {
        attempt += 1;
        if (attempt > this.maxRetries) {
          throw new TraktRequestError('rate limited (429) after exhausting retries', 429, path);
        }
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : this.backoffDelay(attempt);
        await this.sleepFn(Number.isFinite(retryAfterMs) ? retryAfterMs : this.backoffDelay(attempt));
        continue;
      }

      if (response.status >= 500) {
        attempt += 1;
        if (attempt > this.maxRetries) {
          throw new TraktRequestError(`server error ${response.status} after exhausting retries`, response.status, path);
        }
        await this.sleepFn(this.backoffDelay(attempt));
        continue;
      }

      if (response.status === 404) {
        throw new TraktRequestError('not found', 404, path);
      }

      if (!response.ok) {
        throw new TraktRequestError(`unexpected status ${response.status}`, response.status, path);
      }

      return (await response.json()) as T;
    }
  }

  // Exponential backoff with jitter, capped — used for network errors and
  // 5xx responses, and as a fallback if a 429 arrives with no Retry-After.
  private backoffDelay(attempt: number): number {
    const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    const jitter = Math.random() * exponential * 0.25;
    return exponential + jitter;
  }
}
