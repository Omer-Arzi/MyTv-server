import { UserSeriesStatus } from '@prisma/client';
import {
  computeRemainingEpisodesAfterNext,
  filterNonStaleWatchNextCandidates,
  filterReleasedNextEpisodes,
  filterTrustedStaleCandidates,
  groupOrderedEpisodesBySeriesId,
  isTrustedStaleCandidate,
  OrderedEpisodeForRemainingCount,
  ProgressWithNextEpisode,
  StaleCandidateProgress,
} from '../me-query-helpers';
import { EPISODE_NUMBERING_RISK_LIST_TITLES, KNOWN_SEASON_SHIFT_ORPHAN_TITLES, PROVIDER_STRUCTURE_MISMATCH_TITLES } from '../../../common/stale-series-trust';

const PAST = new Date('2000-01-01');
const FUTURE = new Date('2999-01-01');

interface FakeProgress extends ProgressWithNextEpisode {
  id: string;
  nextEpisode: { airDate: Date | null } | null;
}

function progress(id: string, airDate: Date | null): FakeProgress {
  return { id, nextEpisode: { airDate } };
}

// Used as "now" for every filterTrustedStaleCandidates/isTrustedStaleCandidate
// test below, so PAST/FUTURE and the various lastWatchedAt values stay fixed
// relative to a stable reference point.
const NOW = new Date('2026-07-05T00:00:00.000Z');
const NINETY_DAY_CUTOFF = new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000);
const OLD_LAST_WATCHED = new Date('2025-01-01'); // well before the 90-day cutoff
const RECENT_LAST_WATCHED = new Date('2026-07-01'); // within the 90-day cutoff

interface FakeStaleCandidate extends StaleCandidateProgress {
  id: string;
}

function staleCandidate(
  id: string,
  overrides: Partial<Pick<FakeStaleCandidate, 'userStatus' | 'lastWatchedAt' | 'nextEpisode'>> & { title?: string } = {},
): FakeStaleCandidate {
  return {
    id,
    userStatus: overrides.userStatus ?? UserSeriesStatus.WATCHING,
    lastWatchedAt: overrides.lastWatchedAt !== undefined ? overrides.lastWatchedAt : OLD_LAST_WATCHED,
    nextEpisode: overrides.nextEpisode !== undefined ? overrides.nextEpisode : { airDate: PAST },
    series: { title: overrides.title ?? 'The Bear' },
  };
}

describe('filterReleasedNextEpisodes', () => {
  it('keeps rows whose nextEpisode airDate is in the past', () => {
    const result = filterReleasedNextEpisodes([progress('a', PAST)]);
    expect(result.map((p) => p.id)).toEqual(['a']);
  });

  it('excludes rows whose nextEpisode airDate is in the future', () => {
    const result = filterReleasedNextEpisodes([progress('a', FUTURE)]);
    expect(result).toEqual([]);
  });

  it('excludes rows with a null nextEpisode airDate', () => {
    const result = filterReleasedNextEpisodes([progress('a', null)]);
    expect(result).toEqual([]);
  });

  it('excludes rows with no nextEpisode at all', () => {
    const result = filterReleasedNextEpisodes([{ id: 'a', nextEpisode: null }]);
    expect(result).toEqual([]);
  });

  it('filters a mixed list down to only past-and-released episodes', () => {
    const result = filterReleasedNextEpisodes([
      progress('past', PAST),
      progress('future', FUTURE),
      progress('null-date', null),
      { id: 'no-episode', nextEpisode: null },
    ]);
    expect(result.map((p) => p.id)).toEqual(['past']);
  });

  it('treats an airDate exactly equal to "now" as released', () => {
    const now = new Date('2026-07-04T00:00:00.000Z');
    const result = filterReleasedNextEpisodes([progress('a', now)], now);
    expect(result.map((p) => p.id)).toEqual(['a']);
  });
});

describe('isTrustedStaleCandidate / filterTrustedStaleCandidates', () => {
  it('includes WATCHING + released nextEpisode + lastWatchedAt older than the cutoff', () => {
    const candidate = staleCandidate('a');
    expect(isTrustedStaleCandidate(candidate, NINETY_DAY_CUTOFF, NOW)).toBe(true);
    expect(filterTrustedStaleCandidates([candidate], NINETY_DAY_CUTOFF, NOW).map((p) => p.id)).toEqual(['a']);
  });

  it('excludes WATCHING with a recent lastWatchedAt (within the cutoff)', () => {
    const candidate = staleCandidate('a', { lastWatchedAt: RECENT_LAST_WATCHED });
    expect(isTrustedStaleCandidate(candidate, NINETY_DAY_CUTOFF, NOW)).toBe(false);
  });

  it('excludes WATCHING with no nextEpisodeId', () => {
    const candidate = staleCandidate('a', { nextEpisode: null });
    expect(isTrustedStaleCandidate(candidate, NINETY_DAY_CUTOFF, NOW)).toBe(false);
  });

  it('excludes WATCHING with a future nextEpisode', () => {
    const candidate = staleCandidate('a', { nextEpisode: { airDate: FUTURE } });
    expect(isTrustedStaleCandidate(candidate, NINETY_DAY_CUTOFF, NOW)).toBe(false);
  });

  it('excludes WATCHING with a null-airDate nextEpisode', () => {
    const candidate = staleCandidate('a', { nextEpisode: { airDate: null } });
    expect(isTrustedStaleCandidate(candidate, NINETY_DAY_CUTOFF, NOW)).toBe(false);
  });

  it.each([
    UserSeriesStatus.CAUGHT_UP,
    UserSeriesStatus.COMPLETED,
    UserSeriesStatus.DROPPED,
    UserSeriesStatus.PAUSED,
    UserSeriesStatus.WATCHLIST,
    UserSeriesStatus.UNKNOWN,
  ])('excludes userStatus %s even with an otherwise-eligible released nextEpisode', (userStatus) => {
    const candidate = staleCandidate('a', { userStatus });
    expect(isTrustedStaleCandidate(candidate, NINETY_DAY_CUTOFF, NOW)).toBe(false);
  });

  it.each(EPISODE_NUMBERING_RISK_LIST_TITLES)('excludes risk-listed title "%s" even with an otherwise-eligible released nextEpisode', (title) => {
    const candidate = staleCandidate('a', { title });
    expect(isTrustedStaleCandidate(candidate, NINETY_DAY_CUTOFF, NOW)).toBe(false);
  });

  it.each(KNOWN_SEASON_SHIFT_ORPHAN_TITLES)('excludes known season-shift-orphan title "%s" even with an otherwise-eligible released nextEpisode', (title) => {
    const candidate = staleCandidate('a', { title });
    expect(isTrustedStaleCandidate(candidate, NINETY_DAY_CUTOFF, NOW)).toBe(false);
  });

  it.each(PROVIDER_STRUCTURE_MISMATCH_TITLES)(
    'excludes newly-detected provider-structure-mismatch title "%s" even with an otherwise-eligible released nextEpisode',
    (title) => {
      const candidate = staleCandidate('a', { title });
      expect(isTrustedStaleCandidate(candidate, NINETY_DAY_CUTOFF, NOW)).toBe(false);
    },
  );

  it('respects a shorter afterDays-derived cutoff override (e.g. 30 days) independent of the 90-day default', () => {
    const thirtyDayCutoff = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    // 45 days before NOW: stale relative to a 30-day cutoff, not stale relative to the 90-day default.
    const fortyFiveDaysAgo = new Date(NOW.getTime() - 45 * 24 * 60 * 60 * 1000);
    const candidate = staleCandidate('a', { lastWatchedAt: fortyFiveDaysAgo });

    expect(isTrustedStaleCandidate(candidate, thirtyDayCutoff, NOW)).toBe(true);
    expect(isTrustedStaleCandidate(candidate, NINETY_DAY_CUTOFF, NOW)).toBe(false);
  });

  it('filters a mixed list down to only fully-eligible candidates', () => {
    const result = filterTrustedStaleCandidates(
      [
        staleCandidate('eligible'),
        staleCandidate('caught-up', { userStatus: UserSeriesStatus.CAUGHT_UP }),
        staleCandidate('recent', { lastWatchedAt: RECENT_LAST_WATCHED }),
        staleCandidate('no-next-episode', { nextEpisode: null }),
        staleCandidate('risk-listed', { title: EPISODE_NUMBERING_RISK_LIST_TITLES[0] }),
      ],
      NINETY_DAY_CUTOFF,
      NOW,
    );
    expect(result.map((p) => p.id)).toEqual(['eligible']);
  });
});

// Watch Next / stale-series overlap fix: a series should never appear in
// both sections. filterNonStaleWatchNextCandidates reuses the exact same
// isTrustedStaleCandidate predicate stale-series uses, so "is this stale"
// can never disagree between the two.
describe('filterNonStaleWatchNextCandidates', () => {
  it('includes a normal WATCHING series with a released nextEpisode and a recent lastWatchedAt', () => {
    const candidate = staleCandidate('a', { lastWatchedAt: RECENT_LAST_WATCHED });
    const result = filterNonStaleWatchNextCandidates([candidate], NINETY_DAY_CUTOFF, NOW);
    expect(result.map((p) => p.id)).toEqual(['a']);
  });

  it('excludes a series whose lastWatchedAt is older than the stale threshold — it belongs in stale-series instead', () => {
    const candidate = staleCandidate('a', { lastWatchedAt: OLD_LAST_WATCHED });
    // Sanity check: this exact candidate is what stale-series would include.
    expect(isTrustedStaleCandidate(candidate, NINETY_DAY_CUTOFF, NOW)).toBe(true);
    const result = filterNonStaleWatchNextCandidates([candidate], NINETY_DAY_CUTOFF, NOW);
    expect(result).toEqual([]);
  });

  it('excludes a CAUGHT_UP series either way (not stale-eligible, but also not a Watch Next candidate)', () => {
    const candidate = staleCandidate('a', { userStatus: UserSeriesStatus.CAUGHT_UP, lastWatchedAt: RECENT_LAST_WATCHED });
    const result = filterNonStaleWatchNextCandidates([candidate], NINETY_DAY_CUTOFF, NOW);
    expect(result).toEqual([]);
  });

  it('excludes a future nextEpisode regardless of staleness', () => {
    const candidate = staleCandidate('a', { nextEpisode: { airDate: FUTURE }, lastWatchedAt: RECENT_LAST_WATCHED });
    const result = filterNonStaleWatchNextCandidates([candidate], NINETY_DAY_CUTOFF, NOW);
    expect(result).toEqual([]);
  });

  it('excludes a null-airDate nextEpisode regardless of staleness', () => {
    const candidate = staleCandidate('a', { nextEpisode: { airDate: null }, lastWatchedAt: RECENT_LAST_WATCHED });
    const result = filterNonStaleWatchNextCandidates([candidate], NINETY_DAY_CUTOFF, NOW);
    expect(result).toEqual([]);
  });

  it('excludes a risk-listed title even when otherwise a fresh, non-stale candidate', () => {
    const candidate = staleCandidate('a', { title: EPISODE_NUMBERING_RISK_LIST_TITLES[0], lastWatchedAt: RECENT_LAST_WATCHED });
    // Risk-listed titles only get excluded here via the staleness check they
    // share with stale-series; a recent, non-stale risk-listed title is not
    // excluded by this helper (it's excluded from stale-series instead,
    // where the risk-list check actually applies). Documented here so this
    // helper's scope is explicit rather than assumed.
    const result = filterNonStaleWatchNextCandidates([candidate], NINETY_DAY_CUTOFF, NOW);
    expect(result.map((p) => p.id)).toEqual(['a']);
  });

  it.each(KNOWN_SEASON_SHIFT_ORPHAN_TITLES)(
    'known season-shift-orphan title "%s" stays in Watch Next even when also stale — it never qualifies as "trusted stale" so it is not excluded here (a pre-existing gap, not new overlap: it does not appear in stale-series either)',
    (title) => {
      const candidate = staleCandidate('a', { title, lastWatchedAt: OLD_LAST_WATCHED });
      expect(isTrustedStaleCandidate(candidate, NINETY_DAY_CUTOFF, NOW)).toBe(false);
      const result = filterNonStaleWatchNextCandidates([candidate], NINETY_DAY_CUTOFF, NOW);
      expect(result.map((p) => p.id)).toEqual(['a']);
    },
  );

  it.each(PROVIDER_STRUCTURE_MISMATCH_TITLES)(
    'newly-detected provider-structure-mismatch title "%s" stays in Watch Next even when also stale (same pre-existing gap as KNOWN_SEASON_SHIFT_ORPHAN_TITLES above)',
    (title) => {
      const candidate = staleCandidate('a', { title, lastWatchedAt: OLD_LAST_WATCHED });
      expect(isTrustedStaleCandidate(candidate, NINETY_DAY_CUTOFF, NOW)).toBe(false);
      const result = filterNonStaleWatchNextCandidates([candidate], NINETY_DAY_CUTOFF, NOW);
      expect(result.map((p) => p.id)).toEqual(['a']);
    },
  );

  it('produces zero overlap with filterTrustedStaleCandidates on a mixed list — every id appears in at most one result', () => {
    const list = [
      staleCandidate('fresh', { lastWatchedAt: RECENT_LAST_WATCHED }),
      staleCandidate('stale', { lastWatchedAt: OLD_LAST_WATCHED }),
      staleCandidate('caught-up', { userStatus: UserSeriesStatus.CAUGHT_UP, lastWatchedAt: OLD_LAST_WATCHED }),
      staleCandidate('no-next-episode', { nextEpisode: null, lastWatchedAt: OLD_LAST_WATCHED }),
    ];

    const watchNextIds = filterNonStaleWatchNextCandidates(list, NINETY_DAY_CUTOFF, NOW).map((p) => p.id);
    const staleIds = filterTrustedStaleCandidates(list, NINETY_DAY_CUTOFF, NOW).map((p) => p.id);

    expect(watchNextIds).toEqual(['fresh']);
    expect(staleIds).toEqual(['stale']);
    expect(watchNextIds.filter((id) => staleIds.includes(id))).toEqual([]);
  });
});

// Watch Next "+N" remaining-episodes indicator (mobile Continue Watching
// card) — see docs comment on computeRemainingEpisodesAfterNext for the
// null-vs-0 contract this is testing, and
// docs/watch-next-released-episode-semantics-todo.md for why this must
// only ever count RELEASED, UNWATCHED episodes.
describe('computeRemainingEpisodesAfterNext', () => {
  const NOW = new Date('2026-07-11T00:00:00.000Z');
  const PAST = new Date('2020-01-01');
  const FUTURE = new Date('2999-01-01');

  function ep(id: string, airDate: Date | null): OrderedEpisodeForRemainingCount {
    return { id, seriesId: 's', airDate };
  }

  it('counts released episodes strictly after the next episode, excluding it', () => {
    const ordered = Array.from({ length: 100 }, (_, i) => ep(`ep-${i + 1}`, PAST));
    expect(computeRemainingEpisodesAfterNext(ordered, 'ep-13', new Set(), NOW)).toBe(87);
  });

  it('returns 0 when the next episode is the last known released episode', () => {
    const ordered = [ep('ep-1', PAST), ep('ep-2', PAST), ep('ep-3', PAST)];
    expect(computeRemainingEpisodesAfterNext(ordered, 'ep-3', new Set(), NOW)).toBe(0);
  });

  it('returns the full count minus one when the next episode is first', () => {
    const ordered = [ep('ep-1', PAST), ep('ep-2', PAST), ep('ep-3', PAST)];
    expect(computeRemainingEpisodesAfterNext(ordered, 'ep-1', new Set(), NOW)).toBe(2);
  });

  it('returns null (not 0, not a guess) when the next episode id is not found in the catalog', () => {
    const ordered = [ep('ep-1', PAST), ep('ep-2', PAST), ep('ep-3', PAST)];
    expect(computeRemainingEpisodesAfterNext(ordered, 'missing', new Set(), NOW)).toBeNull();
  });

  it('returns null for an empty ordered catalog', () => {
    expect(computeRemainingEpisodesAfterNext([], 'ep-1', new Set(), NOW)).toBeNull();
  });

  // The X-Men '97 regression case: future-dated episodes already stored
  // locally must never inflate this count, regardless of catalog position.
  it('excludes future-dated episodes from the count, even though they are stored locally after the next episode', () => {
    const ordered = [ep('ep-1', PAST), ep('ep-2', PAST), ep('ep-3', PAST), ep('ep-4', FUTURE), ep('ep-5', FUTURE)];
    expect(computeRemainingEpisodesAfterNext(ordered, 'ep-2', new Set(), NOW)).toBe(1);
  });

  it('excludes future episodes entirely — only released-but-unwatched ones after the main episode', () => {
    // Real catalog contains S2E4 (released, main), S2E5 (released,
    // unwatched), S2E6-S2E9 (future). Only S2E5 should count.
    const ordered = [ep('e-s2e4', PAST), ep('e-s2e5', PAST), ep('e-s2e6', FUTURE), ep('e-s2e7', FUTURE), ep('e-s2e8', FUTURE), ep('e-s2e9', FUTURE)];
    expect(computeRemainingEpisodesAfterNext(ordered, 'e-s2e4', new Set(), NOW)).toBe(1);
  });

  it('a released episode with no released unwatched episodes after it, only future ones, returns 0 — never counts the future ones', () => {
    const ordered = [ep('e-s2e4', PAST), ep('e-s2e5', FUTURE), ep('e-s2e6', FUTURE), ep('e-s2e7', FUTURE)];
    expect(computeRemainingEpisodesAfterNext(ordered, 'e-s2e4', new Set(), NOW)).toBe(0);
  });

  it('excludes already-watched episodes from the count', () => {
    const ordered = [ep('ep-1', PAST), ep('ep-2', PAST), ep('ep-3', PAST), ep('ep-4', PAST)];
    // ep-3 was watched out of order (unusual but possible); should not count.
    expect(computeRemainingEpisodesAfterNext(ordered, 'ep-2', new Set(['ep-3']), NOW)).toBe(1);
  });

  it('treats a null airDate as not released, per the canonical isEpisodeReleased rule — never counted', () => {
    const ordered = [ep('ep-1', PAST), ep('ep-2', PAST), ep('ep-3', null)];
    expect(computeRemainingEpisodesAfterNext(ordered, 'ep-1', new Set(), NOW)).toBe(1);
  });

  it('an airDate exactly equal to now counts as released (matches isEpisodeReleased\'s <= rule)', () => {
    const ordered = [ep('ep-1', PAST), ep('ep-2', NOW)];
    expect(computeRemainingEpisodesAfterNext(ordered, 'ep-1', new Set(), NOW)).toBe(1);
  });
});

describe('groupOrderedEpisodesBySeriesId', () => {
  const PAST = new Date('2020-01-01');

  it('groups episodes by seriesId while preserving relative order within each group', () => {
    const grouped = groupOrderedEpisodesBySeriesId([
      { id: 'a1', seriesId: 'series-a', airDate: PAST },
      { id: 'b1', seriesId: 'series-b', airDate: PAST },
      { id: 'a2', seriesId: 'series-a', airDate: PAST },
      { id: 'b2', seriesId: 'series-b', airDate: PAST },
      { id: 'a3', seriesId: 'series-a', airDate: PAST },
    ]);

    expect(grouped.get('series-a')?.map((e) => e.id)).toEqual(['a1', 'a2', 'a3']);
    expect(grouped.get('series-b')?.map((e) => e.id)).toEqual(['b1', 'b2']);
  });

  it('returns an empty map for an empty input', () => {
    expect(groupOrderedEpisodesBySeriesId([])).toEqual(new Map());
  });

  it('composes with computeRemainingEpisodesAfterNext for a realistic multi-series batch', () => {
    const grouped = groupOrderedEpisodesBySeriesId([
      { id: 'a1', seriesId: 'series-a', airDate: PAST },
      { id: 'a2', seriesId: 'series-a', airDate: PAST },
      { id: 'a3', seriesId: 'series-a', airDate: PAST },
      { id: 'b1', seriesId: 'series-b', airDate: PAST },
      { id: 'b2', seriesId: 'series-b', airDate: PAST },
    ]);

    expect(computeRemainingEpisodesAfterNext(grouped.get('series-a') ?? [], 'a1', new Set())).toBe(2);
    expect(computeRemainingEpisodesAfterNext(grouped.get('series-b') ?? [], 'b2', new Set())).toBe(0);
  });
});
