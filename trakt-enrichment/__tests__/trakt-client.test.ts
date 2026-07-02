import { TraktClient, TraktRequestError } from '../trakt-client';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('TraktClient', () => {
  it('sends the required public-GET headers and no OAuth token', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse([{ score: 1, type: 'show', show: { title: 'X', year: null, ids: { trakt: 1, slug: 'x', tvdb: null, imdb: null, tmdb: null } } }]));

    const client = new TraktClient({ clientId: 'test-client-id', fetchFn, sleepFn: jest.fn().mockResolvedValue(undefined) });
    await client.searchShow('X');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain('/search/show');
    expect(url).toContain('query=X');
    const headers = init.headers as Record<string, string>;
    expect(headers['trakt-api-key']).toBe('test-client-id');
    expect(headers['trakt-api-version']).toBe('2');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('parses a successful search response', async () => {
    const payload = [{ score: 98.5, type: 'show', show: { title: 'Inception', year: 2010, ids: { trakt: 1, slug: 'inception', tvdb: null, imdb: null, tmdb: null } } }];
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse(payload));
    const client = new TraktClient({ clientId: 'x', fetchFn, sleepFn: jest.fn().mockResolvedValue(undefined) });

    const result = await client.searchShow('Inception');
    expect(result).toEqual(payload);
  });

  it('retries after a 429 using the Retry-After header, then succeeds', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(jsonResponse([]));
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const client = new TraktClient({ clientId: 'x', fetchFn, sleepFn });

    const result = await client.searchShow('Something');

    expect(result).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // Retry-After: 2 seconds -> 2000ms sleep specifically for the retry
    expect(sleepFn).toHaveBeenCalledWith(2000);
  });

  it('retries on 5xx with backoff, then succeeds', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse([]));
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const client = new TraktClient({ clientId: 'x', fetchFn, sleepFn });

    const result = await client.searchShow('Something');

    expect(result).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxRetries and throws TraktRequestError', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({}, 503));
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const client = new TraktClient({ clientId: 'x', fetchFn, sleepFn, maxRetries: 2 });

    await expect(client.searchShow('Something')).rejects.toThrow(TraktRequestError);
    // 1 initial attempt + 2 retries = 3 calls
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 404 — fails fast', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({}, 404));
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const client = new TraktClient({ clientId: 'x', fetchFn, sleepFn });

    await expect(client.getShow('unknown-slug')).rejects.toThrow(TraktRequestError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('paces consecutive requests using sleepFn', async () => {
    // A fresh Response per call — Response bodies can only be read once, and
    // mockResolvedValue (vs mockImplementation) would hand back the same
    // instance for both searchShow() calls below.
    const fetchFn = jest.fn().mockImplementation(() => jsonResponse([]));
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const client = new TraktClient({ clientId: 'x', fetchFn, sleepFn, minDelayMs: 250 });

    await client.searchShow('A');
    await client.searchShow('B');

    // second call happens (near-)immediately after the first in a test, so
    // throttle should have slept roughly minDelayMs before it.
    expect(sleepFn).toHaveBeenCalled();
  });

  it('builds the seasons endpoint with extended=full,episodes', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse([]));
    const client = new TraktClient({ clientId: 'x', fetchFn, sleepFn: jest.fn().mockResolvedValue(undefined) });

    await client.getSeasonsWithEpisodes('breaking-bad');

    const [url] = fetchFn.mock.calls[0];
    expect(url).toContain('/shows/breaking-bad/seasons');
    expect(url).toContain('extended=full%2Cepisodes');
  });
});
