import { checkBenignSeasonZeroOrphan, detectRealSeasonShrink, findOrphanedWatchedEpisodes } from '../season-zero-orphan-logic';

describe('detectRealSeasonShrink', () => {
  it('is false when every non-zero season has at least as many provider episodes as local', () => {
    const local = [
      { seasonNumber: 0, episodeNumber: 1 },
      { seasonNumber: 1, episodeNumber: 1 },
      { seasonNumber: 1, episodeNumber: 2 },
    ];
    const provider = [
      { seasonNumber: 1, episodeNumber: 1 },
      { seasonNumber: 1, episodeNumber: 2 },
    ];
    expect(detectRealSeasonShrink(local, provider)).toBe(false);
  });

  it('ignores season 0 entirely, even if it shrinks or disappears', () => {
    const local = [
      { seasonNumber: 0, episodeNumber: 1 },
      { seasonNumber: 1, episodeNumber: 1 },
    ];
    const provider = [{ seasonNumber: 1, episodeNumber: 1 }]; // season 0 entirely absent from provider
    expect(detectRealSeasonShrink(local, provider)).toBe(false);
  });

  it('is true when a real (non-zero) season shrinks', () => {
    // The Office (US)-style: season 4 shrinks from 19 local to 14 provider.
    const local = Array.from({ length: 19 }, (_, i) => ({ seasonNumber: 4, episodeNumber: i + 1 }));
    const provider = Array.from({ length: 14 }, (_, i) => ({ seasonNumber: 4, episodeNumber: i + 1 }));
    expect(detectRealSeasonShrink(local, provider)).toBe(true);
  });

  it('is true when a real (non-zero) season disappears entirely from the provider', () => {
    const local = [
      { seasonNumber: 1, episodeNumber: 1 },
      { seasonNumber: 2, episodeNumber: 1 },
    ];
    const provider = [{ seasonNumber: 1, episodeNumber: 1 }];
    expect(detectRealSeasonShrink(local, provider)).toBe(true);
  });

  it('is false when a season grows (more provider episodes than local — still airing)', () => {
    const local = [{ seasonNumber: 1, episodeNumber: 1 }];
    const provider = [
      { seasonNumber: 1, episodeNumber: 1 },
      { seasonNumber: 1, episodeNumber: 2 },
    ];
    expect(detectRealSeasonShrink(local, provider)).toBe(false);
  });
});

describe('findOrphanedWatchedEpisodes', () => {
  it('returns only watched episodes with no matching provider slot', () => {
    const local = [
      { id: 'a', seasonNumber: 1, episodeNumber: 1, watched: true },
      { id: 'b', seasonNumber: 1, episodeNumber: 2, watched: true },
      { id: 'c', seasonNumber: 1, episodeNumber: 3, watched: false },
    ];
    const provider = [{ seasonNumber: 1, episodeNumber: 1 }];
    const result = findOrphanedWatchedEpisodes(local, provider);
    expect(result).toEqual([{ id: 'b', seasonNumber: 1, episodeNumber: 2 }]);
  });

  it('returns an empty array when every watched episode has a matching slot', () => {
    const local = [{ id: 'a', seasonNumber: 1, episodeNumber: 1, watched: true }];
    const provider = [{ seasonNumber: 1, episodeNumber: 1 }];
    expect(findOrphanedWatchedEpisodes(local, provider)).toEqual([]);
  });
});

describe('checkBenignSeasonZeroOrphan', () => {
  it('classifies a single season-0 orphan (clean real seasons) as benign — the BBT/Modern Family/HIMYM/Flash/Superstore pattern', () => {
    const result = checkBenignSeasonZeroOrphan({
      localTitle: 'The Big Bang Theory',
      orphanedWatchedEpisodes: [{ id: 'x', seasonNumber: 0, episodeNumber: 6 }],
      realSeasonShrinkDetected: false,
    });
    expect(result.isBenignSeasonZeroOrphan).toBe(true);
    expect(result.orphanSeasonZeroEpisodeCount).toBe(1);
    expect(result.orphanSeasonZeroEpisodes).toEqual([{ id: 'x', seasonNumber: 0, episodeNumber: 6 }]);
    expect(result.realSeasonShapeMatchesProvider).toBe(true);
  });

  it('classifies an exact match with zero orphans as NOT benign (nothing to acknowledge)', () => {
    const result = checkBenignSeasonZeroOrphan({ localTitle: 'Friends', orphanedWatchedEpisodes: [], realSeasonShrinkDetected: false });
    expect(result.isBenignSeasonZeroOrphan).toBe(false);
    expect(result.orphanSeasonZeroEpisodeCount).toBe(0);
  });

  it('remains blocked (not benign) when real-season orphans exist alongside a season-0 orphan', () => {
    const result = checkBenignSeasonZeroOrphan({
      localTitle: 'The Office (US)',
      orphanedWatchedEpisodes: [
        { id: 'a', seasonNumber: 0, episodeNumber: 1 },
        { id: 'b', seasonNumber: 4, episodeNumber: 16 },
        { id: 'c', seasonNumber: 6, episodeNumber: 25 },
      ],
      realSeasonShrinkDetected: true,
    });
    expect(result.isBenignSeasonZeroOrphan).toBe(false);
    expect(result.realSeasonShapeMatchesProvider).toBe(false);
  });

  it('remains blocked (not benign) when a real season shrank, even with zero season-0 orphans', () => {
    const result = checkBenignSeasonZeroOrphan({ localTitle: 'The Office (US)', orphanedWatchedEpisodes: [], realSeasonShrinkDetected: true });
    expect(result.isBenignSeasonZeroOrphan).toBe(false);
    expect(result.reason).toMatch(/real .* season/);
  });

  it('remains blocked (not benign) when orphaned episodes exist only in real seasons (no real shrink, but a real-season episode is still orphaned)', () => {
    const result = checkBenignSeasonZeroOrphan({
      localTitle: 'Some Show',
      orphanedWatchedEpisodes: [{ id: 'a', seasonNumber: 2, episodeNumber: 5 }],
      realSeasonShrinkDetected: false,
    });
    expect(result.isBenignSeasonZeroOrphan).toBe(false);
    expect(result.reason).toMatch(/real \(non-zero\) seasons/);
  });

  it('remains blocked (not benign) when the season-0 orphan count exceeds the configured maximum', () => {
    const result = checkBenignSeasonZeroOrphan({
      localTitle: 'Some Show',
      orphanedWatchedEpisodes: [
        { id: 'a', seasonNumber: 0, episodeNumber: 1 },
        { id: 'b', seasonNumber: 0, episodeNumber: 2 },
      ],
      realSeasonShrinkDetected: false,
      maxOrphanCount: 1,
    });
    expect(result.isBenignSeasonZeroOrphan).toBe(false);
    expect(result.orphanSeasonZeroEpisodeCount).toBe(2);
  });

  it('respects a higher configured maxOrphanCount', () => {
    const result = checkBenignSeasonZeroOrphan({
      localTitle: 'Some Show',
      orphanedWatchedEpisodes: [
        { id: 'a', seasonNumber: 0, episodeNumber: 1 },
        { id: 'b', seasonNumber: 0, episodeNumber: 2 },
      ],
      realSeasonShrinkDetected: false,
      maxOrphanCount: 2,
    });
    expect(result.isBenignSeasonZeroOrphan).toBe(true);
  });

  it('never treats a known risk-listed title as a benign orphan, even with an otherwise-perfect season-0-only pattern', () => {
    const result = checkBenignSeasonZeroOrphan({
      localTitle: 'Jujutsu Kaisen',
      orphanedWatchedEpisodes: [{ id: 'x', seasonNumber: 0, episodeNumber: 1 }],
      realSeasonShrinkDetected: false,
    });
    expect(result.isBenignSeasonZeroOrphan).toBe(false);
    expect(result.reason).toMatch(/risk list/);
  });
});
