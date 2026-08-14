import { findPendingEpisodesCoveredByMapping, NewMappingInput, PendingEpisodeForPromotion } from '../numbering-mapping-promotion-logic';

function pending(overrides: Partial<PendingEpisodeForPromotion> & Pick<PendingEpisodeForPromotion, 'id' | 'tmdbEpisodeId' | 'providerSeasonNumber' | 'providerEpisodeNumber'>): PendingEpisodeForPromotion {
  return { title: null, overview: null, airDate: null, imageUrl: null, runtimeMinutes: null, ...overrides };
}

describe('findPendingEpisodesCoveredByMapping', () => {
  it('promotes a pending episode covered by the mapping range to its resolved season/episode', () => {
    const pendingRows = [pending({ id: 'p1', tmdbEpisodeId: 7130159, providerSeasonNumber: 1, providerEpisodeNumber: 79, title: 'Episode 79' })];
    const mapping: NewMappingInput = { providerSeasonNumber: 1, providerEpisodeStart: 79, providerEpisodeEnd: null, localSeasonNumber: 5, localEpisodeOffset: 78 };

    const promoted = findPendingEpisodesCoveredByMapping(pendingRows, mapping);

    expect(promoted).toEqual([{ pendingId: 'p1', seasonNumber: 5, episodeNumber: 1, title: 'Episode 79', overview: null, airDate: null, imageUrl: null, runtimeMinutes: null, tmdbEpisodeId: 7130159 }]);
  });

  it('leaves a pending episode untouched (not promoted) when the mapping does not cover it', () => {
    const pendingRows = [pending({ id: 'p1', tmdbEpisodeId: 300, providerSeasonNumber: 2, providerEpisodeNumber: 1 })];
    const mapping: NewMappingInput = { providerSeasonNumber: 1, providerEpisodeStart: 79, providerEpisodeEnd: null, localSeasonNumber: 5, localEpisodeOffset: 78 };

    expect(findPendingEpisodesCoveredByMapping(pendingRows, mapping)).toEqual([]);
  });

  it('respects a bounded (non-open-ended) range', () => {
    const pendingRows = [
      pending({ id: 'p1', tmdbEpisodeId: 1, providerSeasonNumber: 1, providerEpisodeNumber: 79 }),
      pending({ id: 'p2', tmdbEpisodeId: 2, providerSeasonNumber: 1, providerEpisodeNumber: 90 }),
    ];
    const mapping: NewMappingInput = { providerSeasonNumber: 1, providerEpisodeStart: 79, providerEpisodeEnd: 85, localSeasonNumber: 5, localEpisodeOffset: 78 };

    const promoted = findPendingEpisodesCoveredByMapping(pendingRows, mapping);

    expect(promoted).toHaveLength(1);
    expect(promoted[0].pendingId).toBe('p1');
  });

  it('promotes multiple covered pending episodes, each independently offset', () => {
    const pendingRows = [
      pending({ id: 'p1', tmdbEpisodeId: 1, providerSeasonNumber: 1, providerEpisodeNumber: 79 }),
      pending({ id: 'p2', tmdbEpisodeId: 2, providerSeasonNumber: 1, providerEpisodeNumber: 80 }),
    ];
    const mapping: NewMappingInput = { providerSeasonNumber: 1, providerEpisodeStart: 79, providerEpisodeEnd: null, localSeasonNumber: 5, localEpisodeOffset: 78 };

    const promoted = findPendingEpisodesCoveredByMapping(pendingRows, mapping);

    expect(promoted.map((p) => p.episodeNumber)).toEqual([1, 2]);
  });
});
