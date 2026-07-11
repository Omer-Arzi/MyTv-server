import { buildMigrationRollbackPreview, evaluateMigrationRollbackEligibility } from '../migration-rollback-logic';

function baseInput(overrides: Partial<Parameters<typeof evaluateMigrationRollbackEligibility>[0]> = {}) {
  return {
    alreadyRolledBack: false,
    episodesInsertedIds: ['ep1', 'ep2'],
    watchedInsertedEpisodeIds: [] as string[],
    currentUserStatus: 'WATCHING',
    currentNextEpisodeId: null,
    userStatusAfter: 'WATCHING',
    nextEpisodeIdAfter: null,
    userStatusBefore: 'CAUGHT_UP',
    nextEpisodeIdBefore: null,
    ...overrides,
  };
}

describe('evaluateMigrationRollbackEligibility', () => {
  it('is eligible when nothing has drifted and no inserted episode has been watched', () => {
    const result = evaluateMigrationRollbackEligibility(baseInput());
    expect(result.eligible).toBe(true);
    expect(result.refusalReasons).toEqual([]);
  });

  it('refuses when the migration was already rolled back, and skips every other check', () => {
    const result = evaluateMigrationRollbackEligibility(baseInput({ alreadyRolledBack: true, watchedInsertedEpisodeIds: ['ep1'] }));
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons).toEqual(['ALREADY_ROLLED_BACK']);
  });

  it('refuses when an inserted episode has since been watched', () => {
    const result = evaluateMigrationRollbackEligibility(baseInput({ watchedInsertedEpisodeIds: ['ep1'] }));
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons).toContain('EPISODE_HAS_BEEN_WATCHED');
    expect(result.explanations[0]).toContain('1 episode(s)');
  });

  it('refuses when userStatus has drifted since the migration', () => {
    const result = evaluateMigrationRollbackEligibility(baseInput({ currentUserStatus: 'COMPLETED' }));
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons).toContain('PROGRESS_HAS_DRIFTED_SINCE_MIGRATION');
  });

  it('refuses when nextEpisodeId has drifted since the migration', () => {
    const result = evaluateMigrationRollbackEligibility(baseInput({ currentNextEpisodeId: 'some-other-episode' }));
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons).toContain('PROGRESS_HAS_DRIFTED_SINCE_MIGRATION');
  });

  it('refuses with NO_REVERSIBLE_CHANGES when nothing was actually changed by the migration', () => {
    const result = evaluateMigrationRollbackEligibility(
      baseInput({ episodesInsertedIds: [], userStatusBefore: 'WATCHING', userStatusAfter: 'WATCHING', nextEpisodeIdBefore: null, nextEpisodeIdAfter: null }),
    );
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons).toEqual(['NO_REVERSIBLE_CHANGES']);
  });

  it('is eligible when only the status changed (no episodes inserted)', () => {
    const result = evaluateMigrationRollbackEligibility(baseInput({ episodesInsertedIds: [] }));
    expect(result.eligible).toBe(true);
  });

  it('can accumulate multiple refusal reasons at once', () => {
    const result = evaluateMigrationRollbackEligibility(baseInput({ watchedInsertedEpisodeIds: ['ep1'], currentUserStatus: 'COMPLETED' }));
    expect(result.refusalReasons).toEqual(expect.arrayContaining(['EPISODE_HAS_BEEN_WATCHED', 'PROGRESS_HAS_DRIFTED_SINCE_MIGRATION']));
  });
});

describe('buildMigrationRollbackPreview', () => {
  it('reports what would be restored/removed when eligible', () => {
    const eligibility = evaluateMigrationRollbackEligibility(baseInput());
    const preview = buildMigrationRollbackPreview({
      migrationId: 'm1',
      eligibility,
      providerBefore: { provider: 'tmdb', providerId: '123', tmdbId: '123' },
      userStatusBefore: 'CAUGHT_UP',
      nextEpisodeIdBefore: null,
      episodesInsertedIds: ['ep1', 'ep2'],
    });
    expect(preview).toEqual({
      migrationId: 'm1',
      eligible: true,
      refusalReasons: [],
      explanations: [],
      wouldRestoreProvider: { provider: 'tmdb', providerId: '123', tmdbId: '123' },
      wouldRestoreUserStatus: 'CAUGHT_UP',
      wouldRestoreNextEpisodeId: null,
      wouldRemoveEpisodeCount: 2,
      watchHistoryPreserved: true,
    });
  });

  it('reports nothing restorable when ineligible, but still always preserves watch history', () => {
    const eligibility = evaluateMigrationRollbackEligibility(baseInput({ watchedInsertedEpisodeIds: ['ep1'] }));
    const preview = buildMigrationRollbackPreview({
      migrationId: 'm1',
      eligibility,
      providerBefore: null,
      userStatusBefore: 'CAUGHT_UP',
      nextEpisodeIdBefore: null,
      episodesInsertedIds: ['ep1', 'ep2'],
    });
    expect(preview.eligible).toBe(false);
    expect(preview.wouldRestoreProvider).toBeNull();
    expect(preview.wouldRestoreUserStatus).toBeNull();
    expect(preview.wouldRemoveEpisodeCount).toBe(0);
    expect(preview.watchHistoryPreserved).toBe(true);
  });

  it('reports a null providerBefore (no prior confirmed match) correctly when eligible', () => {
    const eligibility = evaluateMigrationRollbackEligibility(baseInput());
    const preview = buildMigrationRollbackPreview({
      migrationId: 'm1',
      eligibility,
      providerBefore: null,
      userStatusBefore: 'CAUGHT_UP',
      nextEpisodeIdBefore: null,
      episodesInsertedIds: [],
    });
    expect(preview.wouldRestoreProvider).toBeNull();
    expect(preview.eligible).toBe(true);
  });
});
