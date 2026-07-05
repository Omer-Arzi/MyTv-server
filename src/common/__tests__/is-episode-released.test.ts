import { isEpisodeReleased } from '../is-episode-released';

const NOW = new Date('2026-07-04T00:00:00.000Z');

describe('isEpisodeReleased', () => {
  it('is true for an airDate in the past', () => {
    expect(isEpisodeReleased(new Date('2026-01-01'), NOW)).toBe(true);
  });

  it('is true for an airDate exactly equal to now', () => {
    expect(isEpisodeReleased(NOW, NOW)).toBe(true);
  });

  it('is false for an airDate in the future', () => {
    expect(isEpisodeReleased(new Date('2026-12-31'), NOW)).toBe(false);
  });

  it('is false for a null airDate (conservative default)', () => {
    expect(isEpisodeReleased(null, NOW)).toBe(false);
  });

  it('defaults "now" to the real current time when not provided', () => {
    const wellInThePast = new Date('2000-01-01');
    const wellInTheFuture = new Date('2999-01-01');
    expect(isEpisodeReleased(wellInThePast)).toBe(true);
    expect(isEpisodeReleased(wellInTheFuture)).toBe(false);
  });
});
