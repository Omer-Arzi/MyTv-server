import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { computeSeriesFieldUpdate, computeSeriesTitleUpdate, decideUserStatusUpdate, tmdbImageUrl } from '../apply-plan-writes';

describe('decideUserStatusUpdate', () => {
  it('updates WATCHING -> COMPLETED when the plan proposes it', () => {
    const result = decideUserStatusUpdate(UserSeriesStatus.WATCHING, UserSeriesStatus.COMPLETED);
    expect(result).toEqual({ shouldUpdate: true, reason: 'updating userStatus from WATCHING to COMPLETED per the apply plan' });
  });

  it('updates WATCHING -> CAUGHT_UP when the plan proposes it', () => {
    const result = decideUserStatusUpdate(UserSeriesStatus.WATCHING, UserSeriesStatus.CAUGHT_UP);
    expect(result.shouldUpdate).toBe(true);
  });

  it.each([UserSeriesStatus.DROPPED, UserSeriesStatus.PAUSED, UserSeriesStatus.WATCHLIST])(
    'never overrides %s, even if the plan proposes COMPLETED',
    (protectedStatus) => {
      const result = decideUserStatusUpdate(protectedStatus, UserSeriesStatus.COMPLETED);
      expect(result.shouldUpdate).toBe(false);
      expect(result.reason).toContain('protected');
    },
  );

  it('does not update when already at the proposed status (no-op)', () => {
    const result = decideUserStatusUpdate(UserSeriesStatus.COMPLETED, UserSeriesStatus.COMPLETED);
    expect(result.shouldUpdate).toBe(false);
    expect(result.reason).toContain('no-op');
  });

  it('only updates WATCHING -> COMPLETED/CAUGHT_UP, not any other transition the plan might propose', () => {
    // Sanity: this function does exactly what it's told, but this test
    // documents the intended real-world usage — the plan's
    // proposedUserStatusAfterEnrichment is what proposeUserStatusAfterEnrichment
    // (src/common/derive-user-status.ts) already computed upstream, this
    // function just decides whether the LIVE status permits applying it.
    const result = decideUserStatusUpdate(UserSeriesStatus.WATCHING, UserSeriesStatus.WATCHING);
    expect(result.shouldUpdate).toBe(false);
  });
});

describe('computeSeriesTitleUpdate', () => {
  it('strips a disambiguating year suffix', () => {
    const result = computeSeriesTitleUpdate('Alice in Borderland (2020)');
    expect(result.newTitle).toBe('Alice in Borderland');
  });

  it('leaves a title with no year suffix unchanged', () => {
    const result = computeSeriesTitleUpdate('Breaking Bad');
    expect(result.newTitle).toBeNull();
  });
});

describe('tmdbImageUrl', () => {
  it('builds a full URL from a relative TMDb path', () => {
    expect(tmdbImageUrl('/abc123.jpg')).toBe('https://image.tmdb.org/t/p/original/abc123.jpg');
  });

  it('returns null for a missing path', () => {
    expect(tmdbImageUrl(null)).toBeNull();
    expect(tmdbImageUrl(undefined)).toBeNull();
  });
});

describe('computeSeriesFieldUpdate', () => {
  it('maps overview/poster/backdrop/releaseStatus from a TMDb show', () => {
    const mapStatus = () => ReleaseStatus.ENDED;
    const result = computeSeriesFieldUpdate({ name: '07-Ghost', overview: 'A story.', poster_path: '/p.jpg', backdrop_path: '/b.jpg', status: 'Ended' }, mapStatus);

    expect(result).toEqual({
      overview: 'A story.',
      posterUrl: 'https://image.tmdb.org/t/p/original/p.jpg',
      backdropUrl: 'https://image.tmdb.org/t/p/original/b.jpg',
      releaseStatus: ReleaseStatus.ENDED,
    });
  });

  it('handles missing overview/images gracefully', () => {
    const mapStatus = () => ReleaseStatus.UNKNOWN;
    const result = computeSeriesFieldUpdate({ name: 'X' }, mapStatus);
    expect(result.overview).toBeNull();
    expect(result.posterUrl).toBeNull();
    expect(result.backdropUrl).toBeNull();
  });
});
