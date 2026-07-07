import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import {
  checkSeriesEligibility,
  chunkArray,
  compareSeriesCatalog,
  LocalEpisodeInput,
  ProviderEpisodeInput,
} from '../refresh-logic';
import { PROVIDER_STRUCTURE_MISMATCH_TITLES } from '../../src/common/stale-series-trust';

const NOW = new Date('2026-07-05T12:00:00.000Z');
const PAST = new Date('2026-01-01');
const FUTURE = new Date('2027-01-01');

function local(overrides: Partial<LocalEpisodeInput> & Pick<LocalEpisodeInput, 'seasonNumber' | 'episodeNumber'>): LocalEpisodeInput {
  return {
    id: `local-${overrides.seasonNumber}-${overrides.episodeNumber}`,
    title: null,
    overview: null,
    airDate: PAST,
    imageUrl: null,
    runtimeMinutes: null,
    watched: false,
    ...overrides,
  };
}

function provider(overrides: Partial<ProviderEpisodeInput> & Pick<ProviderEpisodeInput, 'seasonNumber' | 'episodeNumber'>): ProviderEpisodeInput {
  return {
    title: null,
    overview: null,
    airDate: PAST,
    imageUrl: null,
    runtimeMinutes: null,
    ...overrides,
  };
}

describe('checkSeriesEligibility', () => {
  const base = { userStatus: UserSeriesStatus.WATCHING, tmdbId: 'tmdb-1', title: 'Some Show', releaseStatus: ReleaseStatus.RETURNING };

  it('allows a WATCHING, provider-confirmed, non-risky, non-finished series', () => {
    expect(checkSeriesEligibility(base)).toEqual({ eligible: true, reason: null });
  });

  it('allows CAUGHT_UP the same as WATCHING', () => {
    expect(checkSeriesEligibility({ ...base, userStatus: UserSeriesStatus.CAUGHT_UP }).eligible).toBe(true);
  });

  it.each([UserSeriesStatus.DROPPED, UserSeriesStatus.PAUSED, UserSeriesStatus.WATCHLIST, UserSeriesStatus.UNKNOWN, UserSeriesStatus.COMPLETED])(
    'excludes %s with reason user-status-not-tracked',
    (userStatus) => {
      expect(checkSeriesEligibility({ ...base, userStatus })).toEqual({ eligible: false, reason: 'user-status-not-tracked' });
    },
  );

  it('excludes a series with no tmdbId', () => {
    expect(checkSeriesEligibility({ ...base, tmdbId: null })).toEqual({ eligible: false, reason: 'no-tmdb-id' });
  });

  it('excludes a title on the episode-numbering risk list', () => {
    expect(checkSeriesEligibility({ ...base, title: 'Jujutsu Kaisen' })).toEqual({ eligible: false, reason: 'risk-list' });
  });

  it('excludes a title on the known season-shift orphan list', () => {
    expect(checkSeriesEligibility({ ...base, title: 'Solar Opposites' })).toEqual({ eligible: false, reason: 'risk-list' });
  });

  // These six were themselves found BY this pipeline's dry-run season-shift
  // guard (see docs/episode-numbering-and-season-shift-risk.md's "Newly
  // detected by episode-release-refresh dry run" section) and then added to
  // PROVIDER_STRUCTURE_MISMATCH_TITLES — this confirms a future run now
  // skips them outright at the eligibility stage instead of re-fetching
  // TMDb and re-deriving the same RISKY_DO_NOT_APPLY result every time.
  it.each(PROVIDER_STRUCTURE_MISMATCH_TITLES)('excludes newly-detected provider-structure-mismatch title "%s"', (title) => {
    expect(checkSeriesEligibility({ ...base, title })).toEqual({ eligible: false, reason: 'risk-list' });
  });

  it.each([ReleaseStatus.ENDED, ReleaseStatus.CANCELLED])('excludes a finished series (%s) with reason release-status-finished', (releaseStatus) => {
    expect(checkSeriesEligibility({ ...base, releaseStatus })).toEqual({ eligible: false, reason: 'release-status-finished' });
  });

  it('allows IN_PRODUCTION and UNKNOWN release statuses (not "finished")', () => {
    expect(checkSeriesEligibility({ ...base, releaseStatus: ReleaseStatus.IN_PRODUCTION }).eligible).toBe(true);
    expect(checkSeriesEligibility({ ...base, releaseStatus: ReleaseStatus.UNKNOWN }).eligible).toBe(true);
  });

  it('checks user-status before tmdbId/risk-list/release-status (priority order)', () => {
    expect(checkSeriesEligibility({ userStatus: UserSeriesStatus.DROPPED, tmdbId: null, title: 'Jujutsu Kaisen', releaseStatus: ReleaseStatus.ENDED })).toEqual({
      eligible: false,
      reason: 'user-status-not-tracked',
    });
  });
});

describe('compareSeriesCatalog', () => {
  const baseInput = {
    currentReleaseStatus: ReleaseStatus.RETURNING,
    providerReleaseStatus: ReleaseStatus.RETURNING,
    currentUserStatus: UserSeriesStatus.WATCHING,
    currentNextEpisodeId: null as string | null,
    now: NOW,
  };

  it('classifies NO_CHANGE when local and provider catalogs match exactly', () => {
    const localEpisodes = [local({ seasonNumber: 1, episodeNumber: 1, watched: true }), local({ seasonNumber: 1, episodeNumber: 2, watched: false })];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 1 }), provider({ seasonNumber: 1, episodeNumber: 2 })];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes, currentNextEpisodeId: 'local-1-2' });

    expect(result.classification).toBe('NO_CHANGE');
    expect(result.newEpisodes).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.nextEpisodeWouldChange).toBe(false);
    expect(result.proposedNextEpisodeId).toBe('local-1-2');
  });

  it('classifies NEW_RELEASE_AVAILABLE and proposes the new episode as next when it is released and earliest unwatched', () => {
    const localEpisodes = [local({ seasonNumber: 1, episodeNumber: 1, watched: true })];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 1 }), provider({ seasonNumber: 1, episodeNumber: 2, airDate: PAST, title: 'New Ep' })];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes, currentNextEpisodeId: null });

    expect(result.classification).toBe('NEW_RELEASE_AVAILABLE');
    expect(result.releasedNewEpisodeCount).toBe(1);
    expect(result.futureNewEpisodeCount).toBe(0);
    expect(result.proposedNextEpisodeIsNew).toBe(true);
    expect(result.proposedNextEpisodeId).toBeNull();
    expect(result.proposedNextEpisodeLabel).toBe('S1E2');
    expect(result.nextEpisodeWouldChange).toBe(true);
  });

  it('moves a CAUGHT_UP series to WATCHING when a new released episode is found', () => {
    const localEpisodes = [local({ seasonNumber: 1, episodeNumber: 1, watched: true })];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 1 }), provider({ seasonNumber: 1, episodeNumber: 2, airDate: PAST })];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes, currentUserStatus: UserSeriesStatus.CAUGHT_UP, currentNextEpisodeId: null });

    expect(result.proposedUserStatus).toBe(UserSeriesStatus.WATCHING);
    expect(result.userStatusWouldChangeToWatching).toBe(true);
  });

  it('classifies FUTURE_ONLY when the only new episodes have not aired yet', () => {
    const localEpisodes = [local({ seasonNumber: 1, episodeNumber: 1, watched: true })];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 1 }), provider({ seasonNumber: 1, episodeNumber: 2, airDate: FUTURE })];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes, currentNextEpisodeId: null });

    expect(result.classification).toBe('FUTURE_ONLY');
    expect(result.releasedNewEpisodeCount).toBe(0);
    expect(result.futureNewEpisodeCount).toBe(1);
    // A not-yet-released episode must never be proposed as "next".
    expect(result.proposedNextEpisodeId).toBeNull();
    expect(result.proposedNextEpisodeLabel).toBeNull();
    expect(result.nextEpisodeWouldChange).toBe(false);
  });

  it('classifies RISKY_DO_NOT_APPLY when a season shrinks relative to the provider', () => {
    const localEpisodes = [
      local({ seasonNumber: 1, episodeNumber: 1, watched: true }),
      local({ seasonNumber: 1, episodeNumber: 2, watched: true }),
      local({ seasonNumber: 1, episodeNumber: 3, watched: false }),
    ];
    // Provider now reports season 1 with only 2 episodes — a shrink.
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 1 }), provider({ seasonNumber: 1, episodeNumber: 2 })];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes });

    expect(result.classification).toBe('RISKY_DO_NOT_APPLY');
    expect(result.warnings.some((w) => w.includes('shrank'))).toBe(true);
  });

  it('classifies RISKY_DO_NOT_APPLY when a whole local season is missing from the provider', () => {
    const localEpisodes = [local({ seasonNumber: 1, episodeNumber: 1, watched: true }), local({ seasonNumber: 2, episodeNumber: 1, watched: true })];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 1 })];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes });

    expect(result.classification).toBe('RISKY_DO_NOT_APPLY');
    expect(result.warnings.some((w) => w.includes('missing entirely'))).toBe(true);
  });

  it('classifies NEEDS_MANUAL_REVIEW when a watched episode has no matching provider slot but season counts still line up', () => {
    // Same count (2 vs 2), but the specific watched slot (S1E1) isn't in
    // the provider's response at all — e.g. a renumbering within the same
    // season. Season-level counts alone wouldn't catch this.
    const localEpisodes = [local({ seasonNumber: 1, episodeNumber: 1, watched: true }), local({ seasonNumber: 1, episodeNumber: 2, watched: false })];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 2 }), provider({ seasonNumber: 1, episodeNumber: 3 })];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes });

    expect(result.classification).toBe('NEEDS_MANUAL_REVIEW');
    expect(result.warnings.some((w) => w.includes('watched episode S1E1'))).toBe(true);
  });

  it('RISKY_DO_NOT_APPLY takes priority over NEEDS_MANUAL_REVIEW when both signals are present', () => {
    const localEpisodes = [
      local({ seasonNumber: 1, episodeNumber: 1, watched: true }),
      local({ seasonNumber: 1, episodeNumber: 2, watched: true }),
      local({ seasonNumber: 1, episodeNumber: 3, watched: false }),
    ];
    // Shrink AND a watched episode (S1E1) is dropped.
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 2 })];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes });

    expect(result.classification).toBe('RISKY_DO_NOT_APPLY');
  });

  it('reports field changes on existing episodes without affecting classification', () => {
    const localEpisodes = [local({ seasonNumber: 1, episodeNumber: 1, watched: true, title: 'Old Title', airDate: PAST })];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 1, title: 'New Title', airDate: PAST })];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes });

    expect(result.classification).toBe('NO_CHANGE');
    expect(result.fieldChanges).toEqual([{ episodeId: 'local-1-1', seasonNumber: 1, episodeNumber: 1, changedFields: ['title'] }]);
  });

  it('reports an airDate field change distinctly from a title change', () => {
    const localEpisodes = [local({ seasonNumber: 1, episodeNumber: 1, watched: false, airDate: null })];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 1, airDate: PAST })];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes });

    expect(result.fieldChanges[0].changedFields).toEqual(['airDate']);
  });

  it('reports a releaseStatus change without it alone forcing a non-NO_CHANGE classification', () => {
    const localEpisodes = [local({ seasonNumber: 1, episodeNumber: 1, watched: true })];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 1 })];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes, providerReleaseStatus: ReleaseStatus.ENDED });

    expect(result.releaseStatusChange).toEqual({ from: ReleaseStatus.RETURNING, to: ReleaseStatus.ENDED });
    expect(result.classification).toBe('NO_CHANGE');
  });

  it('proposes an existing unwatched local episode as next when no new episodes exist', () => {
    const localEpisodes = [local({ seasonNumber: 1, episodeNumber: 1, watched: true }), local({ seasonNumber: 1, episodeNumber: 2, watched: false, airDate: PAST })];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 1 }), provider({ seasonNumber: 1, episodeNumber: 2 })];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes, currentNextEpisodeId: null });

    expect(result.proposedNextEpisodeId).toBe('local-1-2');
    expect(result.proposedNextEpisodeIsNew).toBe(false);
    expect(result.nextEpisodeWouldChange).toBe(true); // was null, now local-1-2
  });

  it('does not flag nextEpisodeWouldChange when the proposed next matches the current one', () => {
    const localEpisodes = [local({ seasonNumber: 1, episodeNumber: 1, watched: false, airDate: PAST })];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 1 })];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes, currentNextEpisodeId: 'local-1-1' });

    expect(result.nextEpisodeWouldChange).toBe(false);
  });
});

describe('chunkArray', () => {
  it('splits an array into chunks of the given size', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns one chunk when size exceeds the array length', () => {
    expect(chunkArray([1, 2], 20)).toEqual([[1, 2]]);
  });

  it('returns an empty array for empty input', () => {
    expect(chunkArray([], 5)).toEqual([]);
  });

  it('throws for a non-positive size', () => {
    expect(() => chunkArray([1], 0)).toThrow();
  });
});
