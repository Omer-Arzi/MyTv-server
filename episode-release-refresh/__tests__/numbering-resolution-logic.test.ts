import { NewEpisodeFound, ProviderEpisodeInput } from '../refresh-logic';
import { NumberingMappingInput, resolveEpisodeNumbering } from '../numbering-resolution-logic';

function newEp(overrides: Partial<NewEpisodeFound> & Pick<NewEpisodeFound, 'seasonNumber' | 'episodeNumber'>): NewEpisodeFound {
  return { title: null, airDate: null, released: true, ...overrides };
}

function providerEp(overrides: Partial<ProviderEpisodeInput> & Pick<ProviderEpisodeInput, 'seasonNumber' | 'episodeNumber'>): ProviderEpisodeInput {
  return { title: null, overview: null, airDate: null, imageUrl: null, runtimeMinutes: null, ...overrides };
}

describe('resolveEpisodeNumbering', () => {
  it('passes every new episode through unchanged when the series has never needed numbering supervision (zero mappings) -- the common case, unaffected', () => {
    const newEpisodes = [newEp({ seasonNumber: 1, episodeNumber: 5 }), newEp({ seasonNumber: 5, episodeNumber: 1 })];
    const providerEpisodes = [providerEp({ seasonNumber: 1, episodeNumber: 5, tmdbEpisodeId: 100 }), providerEp({ seasonNumber: 5, episodeNumber: 1, tmdbEpisodeId: 200 })];

    const result = resolveEpisodeNumbering({ newEpisodes, providerEpisodes, mappings: [] });

    expect(result.resolvedNewEpisodes).toEqual(newEpisodes);
    expect(result.pending).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('relabels a new episode to the resolved local season/episode when a mapping covers it', () => {
    const newEpisodes = [newEp({ seasonNumber: 1, episodeNumber: 79, title: 'Episode 79' })];
    const providerEpisodes = [providerEp({ seasonNumber: 1, episodeNumber: 79, title: 'Episode 79', tmdbEpisodeId: 7130159 })];
    const mappings: NumberingMappingInput[] = [{ providerSeasonNumber: 1, providerEpisodeStart: 79, providerEpisodeEnd: null, localSeasonNumber: 5, localEpisodeOffset: 78 }];

    const result = resolveEpisodeNumbering({ newEpisodes, providerEpisodes, mappings });

    expect(result.resolvedNewEpisodes).toEqual([{ seasonNumber: 5, episodeNumber: 1, title: 'Episode 79', airDate: null, released: true }]);
    expect(result.resolvedProviderEpisodes.find((p) => p.seasonNumber === 5 && p.episodeNumber === 1)).toMatchObject({ tmdbEpisodeId: 7130159 });
    expect(result.pending).toEqual([]);
  });

  it('holds a new episode as pending when the series needs supervision and no mapping covers it -- never guesses, even if its provider season number happens to match a season this series already has locally', () => {
    // The critical case: provider season 1 already "exists locally" in the
    // sense that earlier episodes of provider season 1 were mapped there --
    // but once a series has ANY mapping, a bare season-number coincidence
    // must never be trusted on its own; only an explicit mapping range can
    // resolve a new episode.
    const newEpisodes = [newEp({ seasonNumber: 1, episodeNumber: 79, title: 'Episode 79', airDate: new Date('2026-08-19') })];
    const providerEpisodes = [providerEp({ seasonNumber: 1, episodeNumber: 79, title: 'Episode 79', airDate: new Date('2026-08-19'), tmdbEpisodeId: 7130159 })];
    const mappings: NumberingMappingInput[] = [{ providerSeasonNumber: 1, providerEpisodeStart: 1, providerEpisodeEnd: 78, localSeasonNumber: 1, localEpisodeOffset: 0 }];

    const result = resolveEpisodeNumbering({ newEpisodes, providerEpisodes, mappings });

    expect(result.resolvedNewEpisodes).toEqual([]);
    expect(result.pending).toEqual([
      { tmdbEpisodeId: 7130159, providerSeasonNumber: 1, providerEpisodeNumber: 79, title: 'Episode 79', overview: null, airDate: new Date('2026-08-19'), imageUrl: null, runtimeMinutes: null },
    ]);
  });

  it('treats providerEpisodeEnd: null as open-ended, covering every future episode in that range automatically', () => {
    const newEpisodes = [newEp({ seasonNumber: 1, episodeNumber: 150 })];
    const providerEpisodes = [providerEp({ seasonNumber: 1, episodeNumber: 150, tmdbEpisodeId: 999 })];
    const mappings: NumberingMappingInput[] = [{ providerSeasonNumber: 1, providerEpisodeStart: 79, providerEpisodeEnd: null, localSeasonNumber: 5, localEpisodeOffset: 78 }];

    const result = resolveEpisodeNumbering({ newEpisodes, providerEpisodes, mappings });

    expect(result.resolvedNewEpisodes[0]).toMatchObject({ seasonNumber: 5, episodeNumber: 72 });
    expect(result.pending).toEqual([]);
  });

  it('falls back to the provider numbering (never drops the episode) and warns when a new episode has no tmdbEpisodeId', () => {
    const newEpisodes = [newEp({ seasonNumber: 1, episodeNumber: 79 })];
    const providerEpisodes = [providerEp({ seasonNumber: 1, episodeNumber: 79 })]; // no tmdbEpisodeId
    const mappings: NumberingMappingInput[] = [{ providerSeasonNumber: 1, providerEpisodeStart: 1, providerEpisodeEnd: 78, localSeasonNumber: 1, localEpisodeOffset: 0 }];

    const result = resolveEpisodeNumbering({ newEpisodes, providerEpisodes, mappings });

    expect(result.resolvedNewEpisodes).toEqual(newEpisodes);
    expect(result.pending).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('no tmdbEpisodeId');
  });

  it('resolves multiple new episodes independently -- some pass through, some relabel, some pend', () => {
    const newEpisodes = [
      newEp({ seasonNumber: 2, episodeNumber: 1 }), // no mapping touches season 2 at all -> pending
      newEp({ seasonNumber: 1, episodeNumber: 79 }), // covered by mapping -> relabel
    ];
    const providerEpisodes = [providerEp({ seasonNumber: 2, episodeNumber: 1, tmdbEpisodeId: 300 }), providerEp({ seasonNumber: 1, episodeNumber: 79, tmdbEpisodeId: 7130159 })];
    const mappings: NumberingMappingInput[] = [{ providerSeasonNumber: 1, providerEpisodeStart: 79, providerEpisodeEnd: null, localSeasonNumber: 5, localEpisodeOffset: 78 }];

    const result = resolveEpisodeNumbering({ newEpisodes, providerEpisodes, mappings });

    expect(result.resolvedNewEpisodes).toEqual([{ seasonNumber: 5, episodeNumber: 1, title: null, airDate: null, released: true }]);
    expect(result.pending).toEqual([{ tmdbEpisodeId: 300, providerSeasonNumber: 2, providerEpisodeNumber: 1, title: null, overview: null, airDate: null, imageUrl: null, runtimeMinutes: null }]);
  });
});
