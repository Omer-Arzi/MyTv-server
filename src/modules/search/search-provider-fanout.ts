// Federated provider search: queries TMDb and TVmaze in parallel, each
// bounded by its own timeout (neither client supports an AbortSignal today
// — see the file-level note on withTimeout below), and normalizes both into
// one common candidate shape. Never merges two un-owned external hits into
// one card here — that only ever happens downstream, in search.service.ts,
// and only when both already resolve to the same LOCAL series' confirmed
// identity (see search-matching-logic.ts). TMDb and TVmaze share no ID
// crosswalk, so two un-owned results are never spuriously combined.
//
// TVmaze's /search/shows has no pagination at all (confirmed in the
// architecture audit this feature was planned from) — it always returns
// everything TVmaze has for the query in one call. Pagination therefore
// only ever extends TMDb's results; TVmaze simply has nothing further to
// contribute past page 1. This is expected, not a bug.

import { TmdbClient, TmdbRequestError } from '../../../tmdb-enrichment/tmdb-client';
import { TvMazeClient, TvMazeRequestError } from '../../../secondary-provider-audit/tvmaze-client';
import { tmdbImageUrl } from '../../../tmdb-enrichment/apply-plan-writes';
import { parseYearFromDate } from '../../../tmdb-enrichment/scoring';
import { SearchProvider } from './search-types';

export interface FanoutCandidate {
  provider: SearchProvider;
  providerId: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
}

export interface ProviderFanoutResult {
  candidates: FanoutCandidate[];
  // Providers that failed or timed out for this query — never surfaced to
  // the client as raw provider names/errors (search.controller.ts maps
  // this to the plain hadProviderFailure boolean only).
  failedProviders: SearchProvider[];
}

const DEFAULT_PROVIDER_TIMEOUT_MS = 5000;

// Neither TmdbClient nor TvMazeClient accepts an AbortSignal (see the
// architecture audit — no request-timeout mechanism exists anywhere in this
// codebase yet). This bounds how long the SEARCH ENDPOINT waits on a slow
// provider without touching either shared client (both are reused by
// Migration Workbench and the sync scheduler — a behavior change there is
// out of scope for this feature). The underlying HTTP request itself isn't
// cancelled, only abandoned from this call's perspective — acceptable here
// since a single extra in-flight request has no user-visible cost.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface SearchProvidersInput {
  tmdb: TmdbClient;
  tvmaze: TvMazeClient;
  query: string;
  // TMDb-only — see file header. Omitted/1 for the first page.
  tmdbPage?: number;
  timeoutMs?: number;
}

export async function searchProviders(input: SearchProvidersInput): Promise<ProviderFanoutResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;

  const [tmdbSettled, tvmazeSettled] = await Promise.allSettled([
    withTimeout(input.tmdb.searchTv(input.query, undefined, input.tmdbPage), timeoutMs),
    // TVmaze has no pagination (see file header) — only ever queried on the
    // first page, so "load more" doesn't re-request the same fixed result
    // set from it every time.
    (input.tmdbPage ?? 1) <= 1 ? withTimeout(input.tvmaze.searchShows(input.query), timeoutMs) : Promise.resolve([]),
  ]);

  const candidates: FanoutCandidate[] = [];
  const failedProviders: SearchProvider[] = [];

  if (tmdbSettled.status === 'fulfilled') {
    for (const r of tmdbSettled.value) {
      candidates.push({ provider: 'tmdb', providerId: String(r.id), title: r.name, year: parseYearFromDate(r.first_air_date), posterUrl: tmdbImageUrl(r.poster_path) });
    }
  } else {
    logFailure('tmdb', tmdbSettled.reason);
    failedProviders.push('tmdb');
  }

  if (tvmazeSettled.status === 'fulfilled') {
    for (const r of tvmazeSettled.value) {
      candidates.push({
        provider: 'tvmaze',
        providerId: String(r.show.id),
        title: r.show.name,
        year: parseYearFromDate(r.show.premiered),
        posterUrl: r.show.image?.original ?? r.show.image?.medium ?? null,
      });
    }
  } else {
    logFailure('tvmaze', tvmazeSettled.reason);
    failedProviders.push('tvmaze');
  }

  return { candidates, failedProviders };
}

function logFailure(provider: SearchProvider, reason: unknown): void {
  const message = reason instanceof TmdbRequestError || reason instanceof TvMazeRequestError || reason instanceof Error ? reason.message : String(reason);
  // eslint-disable-next-line no-console
  console.warn(`[search] ${provider} search failed: ${message}`);
}
