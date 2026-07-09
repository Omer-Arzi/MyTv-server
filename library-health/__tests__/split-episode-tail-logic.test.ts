import { checkSplitEpisodeTailOnly } from '../split-episode-tail-logic';
import { EpisodeSeasonPosition, OrphanedWatchedEpisode } from '../season-zero-orphan-logic';

// Mirrors the real The Office (US) investigation: season 4 local has E1-19,
// TMDb only has E1-14; the 5 trailing local episodes (E15-19) are watched
// and have no provider counterpart, and every TMDb episode (E1-14) has a
// local counterpart.
function officeSeason4Local(): EpisodeSeasonPosition[] {
  return Array.from({ length: 19 }, (_, i) => ({ seasonNumber: 4, episodeNumber: i + 1 }));
}
function officeSeason4Provider(): EpisodeSeasonPosition[] {
  return Array.from({ length: 14 }, (_, i) => ({ seasonNumber: 4, episodeNumber: i + 1 }));
}
function officeSeason4TailOrphans(): OrphanedWatchedEpisode[] {
  return [15, 16, 17, 18, 19].map((n) => ({ id: `s4e${n}`, seasonNumber: 4, episodeNumber: n }));
}

describe('checkSplitEpisodeTailOnly', () => {
  it('detects a tail-only shrink (The Office S4: local E1-19 vs. provider E1-14)', () => {
    const result = checkSplitEpisodeTailOnly({
      localTitle: 'The Office (US)',
      localEpisodes: officeSeason4Local(),
      providerEpisodes: officeSeason4Provider(),
      orphanedWatchedEpisodes: officeSeason4TailOrphans(),
    });

    expect(result.isSplitEpisodeTailOnly).toBe(true);
    expect(result.affectedSeasons).toEqual([{ seasonNumber: 4, providerEpisodeCount: 14, localEpisodeCount: 19, tailOrphanEpisodeNumbers: [15, 16, 17, 18, 19] }]);
    expect(result.tailOrphanedEpisodes).toHaveLength(5);
  });

  it('detects tail-only shrinks across multiple seasons at once (The Office S4/S6/S7 combined)', () => {
    const localEpisodes: EpisodeSeasonPosition[] = [
      ...officeSeason4Local(),
      ...Array.from({ length: 26 }, (_, i) => ({ seasonNumber: 6, episodeNumber: i + 1 })),
      ...Array.from({ length: 26 }, (_, i) => ({ seasonNumber: 7, episodeNumber: i + 1 })),
    ];
    const providerEpisodes: EpisodeSeasonPosition[] = [
      ...officeSeason4Provider(),
      ...Array.from({ length: 24 }, (_, i) => ({ seasonNumber: 6, episodeNumber: i + 1 })),
      ...Array.from({ length: 24 }, (_, i) => ({ seasonNumber: 7, episodeNumber: i + 1 })),
    ];
    const orphanedWatchedEpisodes: OrphanedWatchedEpisode[] = [
      ...officeSeason4TailOrphans(),
      { id: 's6e25', seasonNumber: 6, episodeNumber: 25 },
      { id: 's6e26', seasonNumber: 6, episodeNumber: 26 },
      { id: 's7e25', seasonNumber: 7, episodeNumber: 25 },
      { id: 's7e26', seasonNumber: 7, episodeNumber: 26 },
    ];

    const result = checkSplitEpisodeTailOnly({ localTitle: 'The Office (US)', localEpisodes, providerEpisodes, orphanedWatchedEpisodes });

    expect(result.isSplitEpisodeTailOnly).toBe(true);
    expect(result.affectedSeasons.map((s) => s.seasonNumber)).toEqual([4, 6, 7]);
    expect(result.tailOrphanedEpisodes).toHaveLength(9);
  });

  it('does NOT classify a mid-season gap as tail-only — orphan at or before the provider max still blocks', () => {
    // Provider is missing episode 5 in the middle of the season (a real
    // gap), not trailing extra episodes at the end.
    const localEpisodes: EpisodeSeasonPosition[] = Array.from({ length: 10 }, (_, i) => ({ seasonNumber: 1, episodeNumber: i + 1 }));
    const providerEpisodes: EpisodeSeasonPosition[] = Array.from({ length: 10 }, (_, i) => ({ seasonNumber: 1, episodeNumber: i + 1 })).filter(
      (e) => e.episodeNumber !== 5,
    );
    const orphanedWatchedEpisodes: OrphanedWatchedEpisode[] = [{ id: 'x', seasonNumber: 1, episodeNumber: 5 }];

    const result = checkSplitEpisodeTailOnly({ localTitle: 'Some Show', localEpisodes, providerEpisodes, orphanedWatchedEpisodes });

    expect(result.isSplitEpisodeTailOnly).toBe(false);
    expect(result.reason).toMatch(/real gap, not a clean tail/);
    expect(result.tailOrphanedEpisodes).toEqual([]);
  });

  it('does NOT classify as tail-only when a provider episode has no local counterpart at all', () => {
    const localEpisodes: EpisodeSeasonPosition[] = officeSeason4Local();
    const providerEpisodes: EpisodeSeasonPosition[] = [...officeSeason4Provider(), { seasonNumber: 4, episodeNumber: 20 }]; // provider has an episode local never imported
    const orphanedWatchedEpisodes: OrphanedWatchedEpisode[] = officeSeason4TailOrphans();

    const result = checkSplitEpisodeTailOnly({ localTitle: 'The Office (US)', localEpisodes, providerEpisodes, orphanedWatchedEpisodes });

    expect(result.isSplitEpisodeTailOnly).toBe(false);
    expect(result.reason).toMatch(/no local counterpart/);
  });

  it('preserves every unmatched local tail episode in the result rather than dropping or renumbering any of them', () => {
    const result = checkSplitEpisodeTailOnly({
      localTitle: 'The Office (US)',
      localEpisodes: officeSeason4Local(),
      providerEpisodes: officeSeason4Provider(),
      orphanedWatchedEpisodes: officeSeason4TailOrphans(),
    });

    // Every tail orphan's original id/season/episode must survive intact —
    // this is exactly what a future apply step would read to know which
    // rows must NOT be deleted/renumbered/overwritten.
    expect(result.tailOrphanedEpisodes).toEqual(officeSeason4TailOrphans());
    expect(result.tailOrphanedEpisodes.map((e) => e.id).sort()).toEqual(['s4e15', 's4e16', 's4e17', 's4e18', 's4e19']);
  });

  it('is never triggered by a known risk-listed title, regardless of pattern', () => {
    const result = checkSplitEpisodeTailOnly({
      localTitle: 'Jujutsu Kaisen',
      localEpisodes: officeSeason4Local(),
      providerEpisodes: officeSeason4Provider(),
      orphanedWatchedEpisodes: officeSeason4TailOrphans(),
    });
    expect(result.isSplitEpisodeTailOnly).toBe(false);
    expect(result.reason).toMatch(/risk list/);
  });

  it('returns false with no orphans to report when there are no real-season orphaned watches at all', () => {
    const result = checkSplitEpisodeTailOnly({
      localTitle: 'Friends',
      localEpisodes: officeSeason4Provider(),
      providerEpisodes: officeSeason4Provider(),
      orphanedWatchedEpisodes: [],
    });
    expect(result.isSplitEpisodeTailOnly).toBe(false);
    expect(result.tailOrphanedEpisodes).toEqual([]);
  });

  it('ignores season-0 orphans entirely — orthogonal to the season-zero-orphan check', () => {
    const result = checkSplitEpisodeTailOnly({
      localTitle: 'The Big Bang Theory',
      localEpisodes: officeSeason4Provider(),
      providerEpisodes: officeSeason4Provider(),
      orphanedWatchedEpisodes: [{ id: 'special', seasonNumber: 0, episodeNumber: 6 }],
    });
    expect(result.isSplitEpisodeTailOnly).toBe(false);
    expect(result.reason).toMatch(/no orphaned watched episodes in real/);
  });
});
