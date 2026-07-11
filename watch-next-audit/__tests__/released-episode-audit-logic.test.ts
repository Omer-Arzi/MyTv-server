import { auditWatchNextSeries } from '../released-episode-audit-logic';

const NOW = new Date('2026-07-11T00:00:00.000Z');
const PAST = new Date('2020-01-01');
const FUTURE = new Date('2999-01-01');

function ep(id: string, airDate: Date | null, watched = false) {
  return { id, airDate, watched };
}

describe('auditWatchNextSeries', () => {
  it('reports "correct" when the stored main episode is released, matches the computed first released unwatched episode, and there is nothing after it at all (legacy and corrected formulas agree)', () => {
    const result = auditWatchNextSeries({
      seriesId: 's1',
      seriesTitle: 'Fully Caught Up Series',
      storedNextEpisodeId: 'e3',
      orderedEpisodes: [ep('e1', PAST, true), ep('e2', PAST, true), ep('e3', PAST)],
      now: NOW,
    });
    expect(result.group).toBe('correct');
    expect(result.storedMainEpisodeReleased).toBe(true);
    expect(result.computedFirstReleasedUnwatchedEpisodeId).toBe('e3');
    expect(result.legacyAdditionalCount).toBe(0);
    expect(result.correctedAdditionalCount).toBe(0);
  });

  // X-Men '97's real shape: watched through S2E3, stored main is S2E4
  // (released), S2E5+ are future. The legacy (pre-fix) formula would have
  // shown +2; this is exactly the bug this task fixes, and the audit must
  // surface it as its own category — not silently as "correct" just
  // because the main episode itself happens to be right.
  it('flags additional-count-includes-future for the X-Men \'97 shape even though the main episode itself is correct', () => {
    const result = auditWatchNextSeries({
      seriesId: 's1',
      seriesTitle: "X-Men '97",
      storedNextEpisodeId: 's2e4',
      orderedEpisodes: [ep('s2e1', PAST, true), ep('s2e2', PAST, true), ep('s2e3', PAST, true), ep('s2e4', PAST), ep('s2e5', FUTURE), ep('s2e6', FUTURE)],
      now: NOW,
    });
    expect(result.storedMainEpisodeReleased).toBe(true);
    expect(result.computedFirstReleasedUnwatchedEpisodeId).toBe('s2e4');
    expect(result.releasedUnwatchedEpisodeCount).toBe(1);
    expect(result.futureUnwatchedEpisodeCount).toBe(2);
    expect(result.legacyAdditionalCount).toBe(2);
    expect(result.correctedAdditionalCount).toBe(0);
    expect(result.group).toBe('additional-count-includes-future');
  });

  it('flags future-main-episode-exposed when the stored main episode is not actually released', () => {
    const result = auditWatchNextSeries({
      seriesId: 's1',
      seriesTitle: 'Bad State Series',
      storedNextEpisodeId: 'e2',
      orderedEpisodes: [ep('e1', PAST, true), ep('e2', FUTURE)],
      now: NOW,
    });
    expect(result.group).toBe('future-main-episode-exposed');
    expect(result.storedMainEpisodeReleased).toBe(false);
  });

  it('flags stale-progress-requiring-reconciliation when the stored main episode differs from the computed first released unwatched episode', () => {
    const result = auditWatchNextSeries({
      seriesId: 's1',
      seriesTitle: 'Stale Series',
      storedNextEpisodeId: null, // e.g. CAUGHT_UP/null while a released unwatched episode exists locally
      orderedEpisodes: [ep('e1', PAST, true), ep('e2', PAST)],
      now: NOW,
    });
    expect(result.group).toBe('stale-progress-requiring-reconciliation');
    expect(result.computedFirstReleasedUnwatchedEpisodeId).toBe('e2');
  });

  it('flags additional-count-includes-future when the legacy formula would have leaked future episodes into the count', () => {
    const result = auditWatchNextSeries({
      seriesId: 's1',
      seriesTitle: 'Legacy Bug Series',
      storedNextEpisodeId: 'e1',
      orderedEpisodes: [ep('e1', PAST), ep('e2', FUTURE), ep('e3', FUTURE)],
      now: NOW,
    });
    expect(result.legacyAdditionalCount).toBe(2);
    expect(result.correctedAdditionalCount).toBe(0);
    expect(result.group).toBe('additional-count-includes-future');
  });

  it('flags ambiguous-manual-review when the stored nextEpisodeId does not resolve to any known local episode', () => {
    const result = auditWatchNextSeries({
      seriesId: 's1',
      seriesTitle: 'Dangling Reference Series',
      storedNextEpisodeId: 'ghost-episode',
      orderedEpisodes: [ep('e1', PAST, true)],
      now: NOW,
    });
    expect(result.group).toBe('ambiguous-manual-review');
  });

  it('counts released-unwatched and future-unwatched independently of what is stored', () => {
    const result = auditWatchNextSeries({
      seriesId: 's1',
      seriesTitle: 'Counts Series',
      storedNextEpisodeId: 'e2',
      orderedEpisodes: [ep('e1', PAST, true), ep('e2', PAST), ep('e3', PAST), ep('e4', FUTURE), ep('e5', FUTURE), ep('e6', FUTURE)],
      now: NOW,
    });
    expect(result.releasedUnwatchedEpisodeCount).toBe(2); // e2, e3
    expect(result.futureUnwatchedEpisodeCount).toBe(3); // e4, e5, e6
    expect(result.totalUnwatchedCatalogEpisodes).toBe(5);
  });
});
