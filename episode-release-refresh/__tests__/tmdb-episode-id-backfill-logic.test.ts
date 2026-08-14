import { buildEpisodeBackfillPlan, LocalEpisodeForBackfill, ProviderEpisodeForBackfill } from '../tmdb-episode-id-backfill-logic';

const DATE_1 = new Date('2016-04-04');
const DATE_2 = new Date('2016-04-11');

function local(overrides: Partial<LocalEpisodeForBackfill> & Pick<LocalEpisodeForBackfill, 'id' | 'seasonNumber' | 'episodeNumber'>): LocalEpisodeForBackfill {
  return { title: null, airDate: null, ...overrides };
}

function provider(overrides: Partial<ProviderEpisodeForBackfill> & Pick<ProviderEpisodeForBackfill, 'seasonNumber' | 'episodeNumber' | 'tmdbEpisodeId'>): ProviderEpisodeForBackfill {
  return { title: null, airDate: null, ...overrides };
}

describe('buildEpisodeBackfillPlan', () => {
  it('matches a correctly-numbered local episode via season/episode key', () => {
    const localEpisodes = [local({ id: 'ep-1', seasonNumber: 1, episodeNumber: 1, title: 'Pilot', airDate: DATE_1 })];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 1, title: 'Pilot', airDate: DATE_1, tmdbEpisodeId: 100 })];

    const plan = buildEpisodeBackfillPlan({ localEpisodes, providerEpisodes });

    expect(plan.exactMatches).toEqual([{ localEpisodeId: 'ep-1', localLabel: 'S1E1', tmdbEpisodeId: 100, matchedOn: 'season-episode-key' }]);
    expect(plan.ambiguous).toEqual([]);
    expect(plan.unmatchedLocal).toEqual([]);
  });

  it('trusts a season/episode-key match even when neither side has an airDate to cross-check', () => {
    const localEpisodes = [local({ id: 'ep-1', seasonNumber: 1, episodeNumber: 1 })];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 1, tmdbEpisodeId: 100 })];

    const plan = buildEpisodeBackfillPlan({ localEpisodes, providerEpisodes });

    expect(plan.exactMatches).toHaveLength(1);
    expect(plan.exactMatches[0].matchedOn).toBe('season-episode-key');
  });

  it('downgrades a season/episode-key match to ambiguous when airDate disagrees on both sides', () => {
    const localEpisodes = [local({ id: 'ep-1', seasonNumber: 1, episodeNumber: 1, airDate: DATE_1 })];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 1, airDate: DATE_2, tmdbEpisodeId: 100 })];

    const plan = buildEpisodeBackfillPlan({ localEpisodes, providerEpisodes });

    expect(plan.exactMatches).toEqual([]);
    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0].localEpisodeId).toBe('ep-1');
    expect(plan.ambiguous[0].candidateTmdbEpisodeIds).toEqual([100]);
  });

  it('matches an orphan local episode (no season/episode-key counterpart) by exact airDate+title', () => {
    // Exactly Re:Zero's actively-synced-side shape: a local row correctly
    // enriched with real metadata, but whose season/episode number doesn't
    // line up with the provider's response at all in this test (simulating
    // a genuinely orphaned slot that still carries real matchable data).
    const localEpisodes = [local({ id: 'ep-legacy-1', seasonNumber: 4, episodeNumber: 1, title: 'From Now On', airDate: DATE_1 })];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 67, title: 'From Now On', airDate: DATE_1, tmdbEpisodeId: 7130060 })];

    const plan = buildEpisodeBackfillPlan({ localEpisodes, providerEpisodes });

    expect(plan.exactMatches).toEqual([{ localEpisodeId: 'ep-legacy-1', localLabel: 'S4E1', tmdbEpisodeId: 7130060, matchedOn: 'air-date-and-title' }]);
  });

  it('leaves a legacy row with no airDate/title unmatched, never guessed — the actual Re:Zero Season 2-4 shape', () => {
    // Re:Zero's real Season 2-4 rows: TV Time's export carries no title or
    // airDate for these episodes at all, so there is no signal to match on.
    // Resolving these requires the dedicated per-series repair, not this
    // generic backfill.
    const localEpisodes = [
      local({ id: 'ep-1-67', seasonNumber: 1, episodeNumber: 67, title: 'From Now On', airDate: DATE_1 }),
      local({ id: 'ep-4-1', seasonNumber: 4, episodeNumber: 1 }), // title/airDate both null
    ];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 67, title: 'From Now On', airDate: DATE_1, tmdbEpisodeId: 7130060 })];

    const plan = buildEpisodeBackfillPlan({ localEpisodes, providerEpisodes });

    expect(plan.exactMatches).toEqual([{ localEpisodeId: 'ep-1-67', localLabel: 'S1E67', tmdbEpisodeId: 7130060, matchedOn: 'season-episode-key' }]);
    expect(plan.unmatchedLocal).toEqual([{ localEpisodeId: 'ep-4-1', localLabel: 'S4E1', reason: 'no season/episode-key match, and local row has no airDate/title to match on' }]);
  });

  it('treats a shared airDate+title across multiple provider episodes as ambiguous, not a match', () => {
    const localEpisodes = [local({ id: 'ep-1', seasonNumber: 9, episodeNumber: 1, title: 'Recap', airDate: DATE_1 })];
    const providerEpisodes = [
      provider({ seasonNumber: 1, episodeNumber: 5, title: 'Recap', airDate: DATE_1, tmdbEpisodeId: 100 }),
      provider({ seasonNumber: 1, episodeNumber: 6, title: 'Recap', airDate: DATE_1, tmdbEpisodeId: 101 }),
    ];

    const plan = buildEpisodeBackfillPlan({ localEpisodes, providerEpisodes });

    expect(plan.exactMatches).toEqual([]);
    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0].candidateTmdbEpisodeIds.sort()).toEqual([100, 101]);
  });

  it('reports a collision and excludes both rows from exactMatches when two local episodes resolve to the same tmdbEpisodeId', () => {
    // A genuine duplicate-representation case: two DIFFERENT local rows
    // (the actively-synced one and a legacy one that happens to carry
    // matching metadata) would both resolve to the same real provider
    // episode — must never silently pick one, per safeguard #1.
    const localEpisodes = [
      local({ id: 'ep-1-67', seasonNumber: 1, episodeNumber: 67, title: 'From Now On', airDate: DATE_1 }),
      local({ id: 'ep-4-1', seasonNumber: 4, episodeNumber: 1, title: 'From Now On', airDate: DATE_1 }),
    ];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 67, title: 'From Now On', airDate: DATE_1, tmdbEpisodeId: 7130060 })];

    const plan = buildEpisodeBackfillPlan({ localEpisodes, providerEpisodes });

    expect(plan.exactMatches).toEqual([]);
    expect(plan.collisions).toHaveLength(1);
    expect(plan.collisions[0].tmdbEpisodeId).toBe(7130060);
    expect(plan.collisions[0].localEpisodeIds.sort()).toEqual(['ep-1-67', 'ep-4-1']);
  });

  it('reports provider episodes with no local match as unmatchedProvider, purely for visibility', () => {
    const localEpisodes = [local({ id: 'ep-1', seasonNumber: 1, episodeNumber: 1, title: 'Pilot', airDate: DATE_1 })];
    const providerEpisodes = [
      provider({ seasonNumber: 1, episodeNumber: 1, title: 'Pilot', airDate: DATE_1, tmdbEpisodeId: 100 }),
      provider({ seasonNumber: 1, episodeNumber: 2, title: 'Second', airDate: DATE_2, tmdbEpisodeId: 101 }),
    ];

    const plan = buildEpisodeBackfillPlan({ localEpisodes, providerEpisodes });

    expect(plan.unmatchedProvider).toEqual([{ seasonNumber: 1, episodeNumber: 2, tmdbEpisodeId: 101 }]);
  });
});
