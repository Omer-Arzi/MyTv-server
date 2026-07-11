import { hasConfirmedExternalId } from '../has-confirmed-external-id';

describe('hasConfirmedExternalId', () => {
  it('returns false when there is no ExternalIds row at all', () => {
    expect(hasConfirmedExternalId(null)).toBe(false);
  });

  it('returns false when a row exists but every id field is null', () => {
    expect(hasConfirmedExternalId({ tmdbId: null, traktId: null, imdbId: null })).toBe(false);
  });

  it('returns true when only tmdbId is set', () => {
    expect(hasConfirmedExternalId({ tmdbId: '1418', traktId: null, imdbId: null })).toBe(true);
  });

  it('returns true when only traktId is set', () => {
    expect(hasConfirmedExternalId({ tmdbId: null, traktId: '12345', imdbId: null })).toBe(true);
  });

  it('returns true when only imdbId is set', () => {
    expect(hasConfirmedExternalId({ tmdbId: null, traktId: null, imdbId: 'tt1234567' })).toBe(true);
  });

  it('returns true when multiple ids are set', () => {
    expect(hasConfirmedExternalId({ tmdbId: '1418', traktId: '12345', imdbId: 'tt1234567' })).toBe(true);
  });
});
