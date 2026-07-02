import { TmdbClient, TmdbRequestError } from '../tmdb-client';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('TmdbClient', () => {
  it('sends a Bearer token, not an api_key query param', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({ results: [] }));
    const client = new TmdbClient({ accessToken: 'test-token', fetchFn, sleepFn: jest.fn().mockResolvedValue(undefined) });

    await client.searchTv('X');

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).not.toContain('api_key');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-token');
  });

  it('adds first_air_date_year to the search query only when a year is given', async () => {
    // A fresh Response per call — Response bodies can only be read once, and
    // mockResolvedValue (vs mockImplementation) would hand back the same
    // instance for both searchTv() calls below.
    const fetchFn = jest.fn().mockImplementation(() => jsonResponse({ results: [] }));
    const client = new TmdbClient({ accessToken: 'x', fetchFn, sleepFn: jest.fn().mockResolvedValue(undefined) });

    await client.searchTv('Doctor Who', 2005);
    expect(fetchFn.mock.calls[0][0]).toContain('first_air_date_year=2005');

    await client.searchTv('Futurama', null);
    expect(fetchFn.mock.calls[1][0]).not.toContain('first_air_date_year');
  });

  it('parses search results from the results array', async () => {
    const payload = { page: 1, results: [{ id: 42, name: 'Inception', first_air_date: '2010-07-16' }], total_results: 1, total_pages: 1 };
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse(payload));
    const client = new TmdbClient({ accessToken: 'x', fetchFn, sleepFn: jest.fn().mockResolvedValue(undefined) });

    const result = await client.searchTv('Inception');
    expect(result).toEqual(payload.results);
  });

  it('requests external_ids alongside show details in one call', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({ id: 1, name: 'X' }));
    const client = new TmdbClient({ accessToken: 'x', fetchFn, sleepFn: jest.fn().mockResolvedValue(undefined) });

    await client.getShowDetails('1');
    expect(fetchFn.mock.calls[0][0]).toContain('append_to_response=external_ids');
  });

  it('builds a season batch request with comma-separated season/N namespaces', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({}));
    const client = new TmdbClient({ accessToken: 'x', fetchFn, sleepFn: jest.fn().mockResolvedValue(undefined) });

    await client.getSeasonsBatch('1', [1, 2, 3]);
    const [rawUrl] = fetchFn.mock.calls[0];
    const parsed = new URL(rawUrl);
    expect(parsed.searchParams.get('append_to_response')).toBe('season/1,season/2,season/3');
  });

  it('refuses to build a season batch over the 20-item append_to_response cap', async () => {
    const client = new TmdbClient({ accessToken: 'x', sleepFn: jest.fn().mockResolvedValue(undefined) });
    const tooMany = Array.from({ length: 21 }, (_, i) => i + 1);

    await expect(client.getSeasonsBatch('1', tooMany)).rejects.toThrow(/20-item/);
  });

  it('retries on 429 using Retry-After if present, otherwise falls back to backoff', async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(jsonResponse({ results: [] }));
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const client = new TmdbClient({ accessToken: 'x', fetchFn, sleepFn });

    await client.searchTv('X');

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(1000);
  });

  it('falls back to exponential backoff on 429 when no Retry-After header is sent (TMDb does not document one)', async () => {
    const fetchFn = jest.fn().mockResolvedValueOnce(jsonResponse({}, 429)).mockResolvedValueOnce(jsonResponse({ results: [] }));
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const client = new TmdbClient({ accessToken: 'x', fetchFn, sleepFn });

    await client.searchTv('X');

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledWith(expect.any(Number));
    expect(sleepFn.mock.calls[0][0]).not.toBe(NaN);
  });

  it('gives up after maxRetries and throws TmdbRequestError', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({}, 503));
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const client = new TmdbClient({ accessToken: 'x', fetchFn, sleepFn, maxRetries: 2 });

    await expect(client.searchTv('X')).rejects.toThrow(TmdbRequestError);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 404', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({}, 404));
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const client = new TmdbClient({ accessToken: 'x', fetchFn, sleepFn });

    await expect(client.getShowDetails('unknown')).rejects.toThrow(TmdbRequestError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });
});
