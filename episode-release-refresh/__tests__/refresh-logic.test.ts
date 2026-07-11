import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import {
  checkSeriesEligibility,
  chunkArray,
  compareSeriesCatalog,
  detectSeasonZeroProposal,
  detectSuspiciousBulkInsert,
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
  const base = { userStatus: UserSeriesStatus.WATCHING, tmdbId: 'tmdb-1', title: 'Some Show' };

  it('allows a WATCHING, provider-confirmed, non-risky series', () => {
    expect(checkSeriesEligibility(base)).toEqual({ eligible: true, reason: null });
  });

  it('allows CAUGHT_UP the same as WATCHING', () => {
    expect(checkSeriesEligibility({ ...base, userStatus: UserSeriesStatus.CAUGHT_UP }).eligible).toBe(true);
  });

  // Phase 1 apply mode's core product decision: a COMPLETED series can
  // still receive a genuine renewal, so it must be just as eligible as
  // WATCHING/CAUGHT_UP — see the no-releaseStatus-gate tests below for why
  // this only works once the releaseStatus pre-filter is gone too.
  it('allows COMPLETED the same as WATCHING/CAUGHT_UP', () => {
    expect(checkSeriesEligibility({ ...base, userStatus: UserSeriesStatus.COMPLETED }).eligible).toBe(true);
  });

  it.each([UserSeriesStatus.DROPPED, UserSeriesStatus.PAUSED, UserSeriesStatus.WATCHLIST, UserSeriesStatus.UNKNOWN])(
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

  // Phase 1's key eligibility change: releaseStatus is no longer part of
  // SeriesEligibilityInput at all, so a locally-cached ENDED/CANCELLED
  // value (which is exactly what every COMPLETED series already has, by
  // construction — see deriveUserStatusFromNextEpisode) can never silently
  // re-exclude a series Phase 1 is otherwise supposed to include. There is
  // no "finished" release-status branch left to test — the COMPLETED
  // eligibility test above is exactly the case that would break if this
  // gate were ever reintroduced.
  it('checks user-status before tmdbId/risk-list (priority order)', () => {
    expect(checkSeriesEligibility({ userStatus: UserSeriesStatus.DROPPED, tmdbId: null, title: 'Jujutsu Kaisen' })).toEqual({
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

  // The bulk-insert guard wired into classification — confirms
  // compareSeriesCatalog actually calls detectSuspiciousBulkInsert and
  // lets it win over the ordinary NEW_RELEASE_AVAILABLE classification.
  // The exact large-number cases (House, Dr. STONE, etc.) are covered
  // directly against detectSuspiciousBulkInsert below — this only proves
  // the wiring, using a small fixture that still trips the absolute
  // threshold cleanly (12 released new episodes > 10).
  it('classifies SUSPICIOUS_BULK_INSERT instead of NEW_RELEASE_AVAILABLE when the bulk-insert guard trips', () => {
    const localEpisodes = [local({ seasonNumber: 1, episodeNumber: 1, watched: true })];
    const providerEpisodes = [
      provider({ seasonNumber: 1, episodeNumber: 1 }),
      ...Array.from({ length: 12 }, (_, i) => provider({ seasonNumber: 1, episodeNumber: i + 2 })),
    ];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes });

    expect(result.classification).toBe('SUSPICIOUS_BULK_INSERT');
    expect(result.bulkInsertReason).not.toBeNull();
    expect(result.bulkInsertReason).toContain('12');
  });

  it('RISKY_DO_NOT_APPLY (season shift) takes priority over SUSPICIOUS_BULK_INSERT when both signals are present', () => {
    const localEpisodes = [
      local({ seasonNumber: 1, episodeNumber: 1, watched: true }),
      local({ seasonNumber: 1, episodeNumber: 2, watched: true }),
      local({ seasonNumber: 1, episodeNumber: 3, watched: false }),
    ];
    // Season 1 shrinks (3 local -> 1 provider) AND season 2 brings 12 new
    // released episodes — both signals present at once.
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 1 }), ...Array.from({ length: 12 }, (_, i) => provider({ seasonNumber: 2, episodeNumber: i + 1 }))];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes });

    expect(result.classification).toBe('RISKY_DO_NOT_APPLY');
    // Still reported for visibility even though a different classification won.
    expect(result.bulkInsertReason).not.toBeNull();
  });

  it('bulkInsertReason is null when the bulk-insert guard does not trip', () => {
    const localEpisodes = [local({ seasonNumber: 1, episodeNumber: 1, watched: true })];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 1 }), provider({ seasonNumber: 1, episodeNumber: 2 })];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes });

    expect(result.classification).toBe('NEW_RELEASE_AVAILABLE');
    expect(result.bulkInsertReason).toBeNull();
  });

  // The season-0 guard wired into classification — confirms
  // compareSeriesCatalog calls detectSeasonZeroProposal and lets it win
  // over the ordinary NEW_RELEASE_AVAILABLE classification. Modeled on the
  // real One-Punch Man case found during the Phase 1 pre-apply audit: a
  // series that already tracks season 0 locally, where TMDb has since
  // added new released season-0 specials.
  it('classifies SEASON_ZERO_PROPOSED instead of NEW_RELEASE_AVAILABLE when a released new episode is in season 0', () => {
    const localEpisodes = [local({ seasonNumber: 0, episodeNumber: 1, watched: true }), local({ seasonNumber: 1, episodeNumber: 1, watched: true })];
    const providerEpisodes = [provider({ seasonNumber: 0, episodeNumber: 1 }), provider({ seasonNumber: 0, episodeNumber: 2 }), provider({ seasonNumber: 1, episodeNumber: 1 })];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes });

    expect(result.classification).toBe('SEASON_ZERO_PROPOSED');
    expect(result.seasonZeroReason).not.toBeNull();
  });

  it('does not classify SEASON_ZERO_PROPOSED for a season-0 episode that is only a future (unreleased) proposal', () => {
    const localEpisodes = [local({ seasonNumber: 0, episodeNumber: 1, watched: true })];
    const providerEpisodes = [provider({ seasonNumber: 0, episodeNumber: 1 }), provider({ seasonNumber: 0, episodeNumber: 2, airDate: FUTURE })];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes });

    expect(result.classification).toBe('FUTURE_ONLY');
    expect(result.seasonZeroReason).toBeNull();
  });

  it('RISKY_DO_NOT_APPLY (season shift) takes priority over SEASON_ZERO_PROPOSED when both signals are present', () => {
    const localEpisodes = [
      local({ seasonNumber: 1, episodeNumber: 1, watched: true }),
      local({ seasonNumber: 1, episodeNumber: 2, watched: true }),
      local({ seasonNumber: 1, episodeNumber: 3, watched: false }),
    ];
    // Season 1 shrinks AND a new season-0 episode is proposed.
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 1 }), provider({ seasonNumber: 0, episodeNumber: 1 })];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes });

    expect(result.classification).toBe('RISKY_DO_NOT_APPLY');
    expect(result.seasonZeroReason).not.toBeNull(); // still reported for visibility
  });

  it('seasonZeroReason is null when no season-0 episode is proposed', () => {
    const localEpisodes = [local({ seasonNumber: 1, episodeNumber: 1, watched: true })];
    const providerEpisodes = [provider({ seasonNumber: 1, episodeNumber: 1 }), provider({ seasonNumber: 1, episodeNumber: 2 })];

    const result = compareSeriesCatalog({ ...baseInput, localEpisodes, providerEpisodes });

    expect(result.classification).toBe('NEW_RELEASE_AVAILABLE');
    expect(result.seasonZeroReason).toBeNull();
  });
});

describe('detectSeasonZeroProposal', () => {
  it('is not suspicious when there are no released new episodes at all', () => {
    expect(detectSeasonZeroProposal([])).toEqual({ proposesSeasonZero: false, reason: null });
  });

  it('is not suspicious when all released new episodes are outside season 0', () => {
    expect(detectSeasonZeroProposal([{ seasonNumber: 1 }, { seasonNumber: 2 }])).toEqual({ proposesSeasonZero: false, reason: null });
  });

  it('flags a single released season-0 episode', () => {
    const result = detectSeasonZeroProposal([{ seasonNumber: 0 }]);
    expect(result.proposesSeasonZero).toBe(true);
    expect(result.reason).toContain('1 proposed released episode');
  });

  it('flags a mix of season-0 and non-season-0 released episodes, counting only the season-0 ones in the reason', () => {
    const result = detectSeasonZeroProposal([{ seasonNumber: 0 }, { seasonNumber: 0 }, { seasonNumber: 1 }]);
    expect(result.proposesSeasonZero).toBe(true);
    expect(result.reason).toContain('2 proposed released episode');
  });
});

describe('detectSuspiciousBulkInsert', () => {
  // Real numbers confirmed via a prior maintainer review's dry-run output
  // against this exact database — see refresh-logic.ts's comment above
  // SUSPICIOUS_BULK_INSERT_ABSOLUTE_THRESHOLD for the full context.
  it.each([
    ['House', 86, 90],
    ['Dr. STONE', 24, 70],
    ['Bungo Stray Dogs', 3, 57],
    ['Somebody Feed Phil', 9, 40],
  ])('flags %s (local %i, released new %i) as suspicious', (_title, localCount, releasedCount) => {
    const result = detectSuspiciousBulkInsert(localCount as number, releasedCount as number);
    expect(result.suspicious).toBe(true);
    expect(result.reason).not.toBeNull();
  });

  it('does not flag a single new episode', () => {
    expect(detectSuspiciousBulkInsert(50, 1)).toEqual({ suspicious: false, reason: null });
  });

  it('does not flag several new episodes below both thresholds', () => {
    expect(detectSuspiciousBulkInsert(20, 5)).toEqual({ suspicious: false, reason: null });
  });

  it('does not flag one new season of exactly 10 released episodes for an already-established series', () => {
    expect(detectSuspiciousBulkInsert(30, 10)).toEqual({ suspicious: false, reason: null });
  });

  it('does not trigger the absolute threshold at exactly 10 (boundary: > 10, not >= 10)', () => {
    expect(detectSuspiciousBulkInsert(25, 10).suspicious).toBe(false);
  });

  it('triggers the absolute threshold at 11 (one past the boundary)', () => {
    const result = detectSuspiciousBulkInsert(25, 11);
    expect(result.suspicious).toBe(true);
    expect(result.reason).toContain('absolute');
  });

  it('triggers the relative threshold alone (local >= 10, released > 50% of local, absolute threshold not tripped)', () => {
    // local=15, released=8: 8 is not > 10 (absolute safe), but 8 > 7.5 (50% of 15).
    const result = detectSuspiciousBulkInsert(15, 8);
    expect(result.suspicious).toBe(true);
    expect(result.reason).toContain('%');
  });

  it('does not apply the relative threshold when the local catalog is below the relative minimum, even at a high ratio', () => {
    // local=5, released=8 — 160% of local, but local < 10 so the relative
    // check never even applies, and 8 is not > 10 absolute either.
    expect(detectSuspiciousBulkInsert(5, 8)).toEqual({ suspicious: false, reason: null });
  });

  it('does not flag zero new episodes', () => {
    expect(detectSuspiciousBulkInsert(0, 0)).toEqual({ suspicious: false, reason: null });
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
