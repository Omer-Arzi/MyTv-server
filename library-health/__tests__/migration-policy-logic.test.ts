import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { classifyIdentityConfidence, evaluateAutoMigrationEligibility, resolveObjectiveMigrationStatus, shouldForceWatchingForPendingNextEpisode } from '../migration-policy-logic';

describe('classifyIdentityConfidence', () => {
  it('is FAILED whenever title/year sanity did not pass, regardless of similarity', () => {
    expect(classifyIdentityConfidence({ titleYearSanityPassed: false, similarity: 1 })).toBe('FAILED');
    expect(classifyIdentityConfidence({ titleYearSanityPassed: false, similarity: 0 })).toBe('FAILED');
  });

  it('is HIGH_CONFIDENCE for an exact match (similarity 1)', () => {
    expect(classifyIdentityConfidence({ titleYearSanityPassed: true, similarity: 1 })).toBe('HIGH_CONFIDENCE');
  });

  it('is HIGH_CONFIDENCE at and above the 0.85 threshold', () => {
    expect(classifyIdentityConfidence({ titleYearSanityPassed: true, similarity: 0.85 })).toBe('HIGH_CONFIDENCE');
    expect(classifyIdentityConfidence({ titleYearSanityPassed: true, similarity: 0.9 })).toBe('HIGH_CONFIDENCE');
  });

  it('is BORDERLINE between the existing 0.6 pass floor and the new 0.85 high-confidence floor', () => {
    expect(classifyIdentityConfidence({ titleYearSanityPassed: true, similarity: 0.6 })).toBe('BORDERLINE');
    expect(classifyIdentityConfidence({ titleYearSanityPassed: true, similarity: 0.84 })).toBe('BORDERLINE');
  });
});

describe('resolveObjectiveMigrationStatus', () => {
  const base = { currentUserStatus: UserSeriesStatus.WATCHING, providerReleaseStatus: ReleaseStatus.RETURNING, matchedWatchedCount: 0, matchedTotalCount: 0 };

  it.each([UserSeriesStatus.DROPPED, UserSeriesStatus.PAUSED])('always protects %s regardless of matched-episode counts', (status) => {
    const result = resolveObjectiveMigrationStatus({ ...base, currentUserStatus: status, matchedWatchedCount: 10, matchedTotalCount: 10 });
    expect(result.resolvedUserStatus).toBe(status);
    expect(result.statusSource).toBe('protected');
  });

  it('derives CAUGHT_UP when every matched episode is watched and the provider is still returning', () => {
    const result = resolveObjectiveMigrationStatus({ ...base, matchedWatchedCount: 24, matchedTotalCount: 24, providerReleaseStatus: ReleaseStatus.RETURNING });
    expect(result.resolvedUserStatus).toBe(UserSeriesStatus.CAUGHT_UP);
    expect(result.statusSource).toBe('derived');
  });

  it('derives COMPLETED when every matched episode is watched and the provider has ended', () => {
    const result = resolveObjectiveMigrationStatus({ ...base, matchedWatchedCount: 24, matchedTotalCount: 24, providerReleaseStatus: ReleaseStatus.ENDED });
    expect(result.resolvedUserStatus).toBe(UserSeriesStatus.COMPLETED);
    expect(result.statusSource).toBe('derived');
  });

  it('derives COMPLETED for a cancelled provider too', () => {
    const result = resolveObjectiveMigrationStatus({ ...base, matchedWatchedCount: 5, matchedTotalCount: 5, providerReleaseStatus: ReleaseStatus.CANCELLED });
    expect(result.resolvedUserStatus).toBe(UserSeriesStatus.COMPLETED);
  });

  // The exact Chunibyo-style case from this session's own migration
  // history: TMDb Ended, exactly 24 matched episodes, all 24 watched
  // locally (alongside orphans that don't count toward this) — objectively
  // COMPLETED without needing the user to confirm it by hand.
  it('matches the real Chunibyo case: 24/24 matched watched, provider ended -> COMPLETED', () => {
    const result = resolveObjectiveMigrationStatus({ ...base, matchedWatchedCount: 24, matchedTotalCount: 24, providerReleaseStatus: ReleaseStatus.ENDED, currentUserStatus: UserSeriesStatus.WATCHING });
    expect(result.resolvedUserStatus).toBe(UserSeriesStatus.COMPLETED);
  });

  // The exact Black Mirror-style case: partial matched-watch coverage must
  // never be silently promoted to COMPLETED/CAUGHT_UP.
  it('preserves current status unchanged when matched-watched coverage is partial (Black Mirror style: 19/33)', () => {
    const result = resolveObjectiveMigrationStatus({ ...base, matchedWatchedCount: 19, matchedTotalCount: 33, currentUserStatus: UserSeriesStatus.WATCHING });
    expect(result.resolvedUserStatus).toBe(UserSeriesStatus.WATCHING);
    expect(result.statusSource).toBe('preserved');
  });

  it('preserves current status unchanged when there are zero matched episodes at all (nothing to derive from)', () => {
    const result = resolveObjectiveMigrationStatus({ ...base, matchedWatchedCount: 0, matchedTotalCount: 0, currentUserStatus: UserSeriesStatus.CAUGHT_UP });
    expect(result.resolvedUserStatus).toBe(UserSeriesStatus.CAUGHT_UP);
    expect(result.statusSource).toBe('preserved');
  });

  it('never regresses a COMPLETED status back down when matched coverage is merely partial', () => {
    const result = resolveObjectiveMigrationStatus({ ...base, matchedWatchedCount: 2, matchedTotalCount: 10, currentUserStatus: UserSeriesStatus.COMPLETED });
    expect(result.resolvedUserStatus).toBe(UserSeriesStatus.COMPLETED);
    expect(result.statusSource).toBe('preserved');
  });
});

describe('evaluateAutoMigrationEligibility', () => {
  it('is eligible when identity is confirmed (HIGH_CONFIDENCE) and there is no real season shrink', () => {
    const result = evaluateAutoMigrationEligibility({ titleYearSanityPassed: true, identityBand: 'HIGH_CONFIDENCE', realSeasonShrinkDetected: false });
    expect(result.eligible).toBe(true);
  });

  it('is eligible for BORDERLINE identity too, but the reason says so explicitly', () => {
    const result = evaluateAutoMigrationEligibility({ titleYearSanityPassed: true, identityBand: 'BORDERLINE', realSeasonShrinkDetected: false });
    expect(result.eligible).toBe(true);
    expect(result.reason).toContain('borderline');
  });

  it('is never eligible when title/year sanity failed', () => {
    const result = evaluateAutoMigrationEligibility({ titleYearSanityPassed: false, identityBand: 'FAILED', realSeasonShrinkDetected: false });
    expect(result.eligible).toBe(false);
  });

  it('is never eligible when identity band is FAILED even if titleYearSanityPassed were somehow true', () => {
    const result = evaluateAutoMigrationEligibility({ titleYearSanityPassed: true, identityBand: 'FAILED', realSeasonShrinkDetected: false });
    expect(result.eligible).toBe(false);
  });

  it('is never eligible when a real season shrink is detected, even with confirmed identity', () => {
    const result = evaluateAutoMigrationEligibility({ titleYearSanityPassed: true, identityBand: 'HIGH_CONFIDENCE', realSeasonShrinkDetected: true });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('season shrank');
  });

  // The whole point of this function: orphan count/pattern never appears
  // as an input at all — eligibility is fully independent of it.
  it('has no orphan-count or orphan-pattern parameter at all', () => {
    const fn = evaluateAutoMigrationEligibility as (input: object) => unknown;
    const result = fn({ titleYearSanityPassed: true, identityBand: 'HIGH_CONFIDENCE', realSeasonShrinkDetected: false, orphanCount: 999999 }) as { eligible: boolean };
    expect(result.eligible).toBe(true); // an extraneous orphanCount field changes nothing
  });
});

// Reproduces the real Batch 2 (Castlevania) and Batch 1 (House, Dr. STONE,
// Monster Allergy, Devil May Cry, One-Punch Man, Checkout, The Big Bang
// Theory, Doctor Who, Black Mirror) finding: catalogInsertPlan can create
// brand-new unwatched RELEASED episodes as part of the same apply that
// resolves userStatus/nextEpisodeId, but every one of the pre-existing
// status/next-episode resolution paths has no way to know about them —
// each was written before catalog creation existed at all.
describe('shouldForceWatchingForPendingNextEpisode', () => {
  it('forces the correction when there is a proposed next episode, status is not protected, no explicit override was given, and the series has watch history (the Castlevania case: 20 new unwatched episodes about to be created, currently WATCHING)', () => {
    const result = shouldForceWatchingForPendingNextEpisode({
      hasProposedNextEpisode: true,
      liveUserStatus: UserSeriesStatus.WATCHING,
      explicitStatusOverrideGiven: false,
      hasAnyWatchedEpisode: true,
    });
    expect(result).toBe(true);
  });

  it('forces the correction even when the current status is a "finished" one that predates the new episodes (the Doctor Who case: CAUGHT_UP with 156 new unwatched episodes about to be created, already watched)', () => {
    const result = shouldForceWatchingForPendingNextEpisode({
      hasProposedNextEpisode: true,
      liveUserStatus: UserSeriesStatus.CAUGHT_UP,
      explicitStatusOverrideGiven: false,
      hasAnyWatchedEpisode: true,
    });
    expect(result).toBe(true);
  });

  it('does nothing when there is no proposed next episode at all — leaves every other status nuance (derive/preserve/carry-forward) untouched', () => {
    const result = shouldForceWatchingForPendingNextEpisode({
      hasProposedNextEpisode: false,
      liveUserStatus: UserSeriesStatus.CAUGHT_UP,
      explicitStatusOverrideGiven: false,
      hasAnyWatchedEpisode: true,
    });
    expect(result).toBe(false);
  });

  it('never overrides a protected DROPPED status, even with a proposed next episode', () => {
    const result = shouldForceWatchingForPendingNextEpisode({
      hasProposedNextEpisode: true,
      liveUserStatus: UserSeriesStatus.DROPPED,
      explicitStatusOverrideGiven: false,
      hasAnyWatchedEpisode: true,
    });
    expect(result).toBe(false);
  });

  it('never overrides a protected PAUSED status, even with a proposed next episode', () => {
    const result = shouldForceWatchingForPendingNextEpisode({
      hasProposedNextEpisode: true,
      liveUserStatus: UserSeriesStatus.PAUSED,
      explicitStatusOverrideGiven: false,
      hasAnyWatchedEpisode: true,
    });
    expect(result).toBe(false);
  });

  it('never overrides an explicit human statusOverride, even with a proposed next episode (the Game of Thrones case: explicit statusOverride=COMPLETED with 299 new unwatched episodes)', () => {
    const result = shouldForceWatchingForPendingNextEpisode({
      hasProposedNextEpisode: true,
      liveUserStatus: UserSeriesStatus.COMPLETED,
      explicitStatusOverrideGiven: true,
      hasAnyWatchedEpisode: true,
    });
    expect(result).toBe(false);
  });

  // The bug this test guards against: confirming migration for a WATCHLIST
  // series the user has never started watching used to force it straight
  // to WATCHING (landing it in Home's "Watch Next" instead of "Haven't
  // Started Yet") purely because it has a next unwatched, released episode
  // — true of virtually every unstarted series by definition. Zero watch
  // history means there is nothing "newly revealed" to correct for.
  it('does not force WATCHING for a never-started WATCHLIST series with zero watch history, even with a proposed next episode', () => {
    const result = shouldForceWatchingForPendingNextEpisode({
      hasProposedNextEpisode: true,
      liveUserStatus: UserSeriesStatus.WATCHLIST,
      explicitStatusOverrideGiven: false,
      hasAnyWatchedEpisode: false,
    });
    expect(result).toBe(false);
  });

  it('does not force WATCHING for an UNKNOWN-status series with zero watch history', () => {
    const result = shouldForceWatchingForPendingNextEpisode({
      hasProposedNextEpisode: true,
      liveUserStatus: UserSeriesStatus.UNKNOWN,
      explicitStatusOverrideGiven: false,
      hasAnyWatchedEpisode: false,
    });
    expect(result).toBe(false);
  });
});
