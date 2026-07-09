import { UserSeriesStatus } from '@prisma/client';
import {
  buildMigrationApplyPlan,
  classifyMigrationConfirmation,
  isProtectedMigrationStatus,
  PROTECTED_MIGRATION_STATUSES,
} from '../migration-confirmation-logic';
import { LocalEpisodeForApply, ProviderEpisodeForApply } from '../apply-friends-tvmaze-logic';
import { OrphanedWatchedEpisode } from '../season-zero-orphan-logic';

function orphan(seasonNumber: number, episodeNumber: number, id = `${seasonNumber}-${episodeNumber}`): OrphanedWatchedEpisode {
  return { id, seasonNumber, episodeNumber };
}

describe('isProtectedMigrationStatus / PROTECTED_MIGRATION_STATUSES', () => {
  it('protects exactly DROPPED and PAUSED', () => {
    expect(PROTECTED_MIGRATION_STATUSES.sort()).toEqual([UserSeriesStatus.DROPPED, UserSeriesStatus.PAUSED].sort());
    expect(isProtectedMigrationStatus(UserSeriesStatus.DROPPED)).toBe(true);
    expect(isProtectedMigrationStatus(UserSeriesStatus.PAUSED)).toBe(true);
  });

  it('does not protect WATCHING/CAUGHT_UP/COMPLETED/WATCHLIST/UNKNOWN', () => {
    for (const s of [UserSeriesStatus.WATCHING, UserSeriesStatus.CAUGHT_UP, UserSeriesStatus.COMPLETED, UserSeriesStatus.WATCHLIST, UserSeriesStatus.UNKNOWN]) {
      expect(isProtectedMigrationStatus(s)).toBe(false);
    }
  });
});

describe('classifyMigrationConfirmation — reachability gate (no migration tier without explicit migrationIntent)', () => {
  it('passes through the base classification unchanged when migrationIntent is false', () => {
    const result = classifyMigrationConfirmation({
      baseClassification: 'BLOCKED_RISK',
      baseReason: 'season 21 is missing entirely from the provider response',
      titleYearSanityPassed: true,
      orphanedWatchedEpisodes: Array.from({ length: 472 }, (_, i) => orphan(2 + (i % 20), i)),
      currentUserStatus: UserSeriesStatus.CAUGHT_UP,
      migration: { migrationIntent: false },
    });
    expect(result.classification).toBe('BLOCKED_RISK');
    expect(result.preservedOrphanEpisodes).toEqual([]);
    expect(result.resolvedUserStatus).toBe(UserSeriesStatus.CAUGHT_UP);
  });

  it('passes through even a SAFE_TO_APPLY_LATER base classification unchanged when migrationIntent is false', () => {
    const result = classifyMigrationConfirmation({
      baseClassification: 'SAFE_TO_APPLY_LATER',
      baseReason: 'clean match',
      titleYearSanityPassed: true,
      orphanedWatchedEpisodes: [],
      currentUserStatus: UserSeriesStatus.WATCHING,
      migration: { migrationIntent: false },
    });
    expect(result.classification).toBe('SAFE_TO_APPLY_LATER');
  });

  it('never returns a MigrationClassification value when migrationIntent is false, for any base classification', () => {
    const migrationOnlyValues = ['SAFE_MIGRATION_WITH_PRESERVED_ORPHANS', 'SAFE_MIGRATION_WITH_STATUS_OVERRIDE', 'BLOCKED_DESTRUCTIVE_RISK'];
    for (const base of ['SAFE_TO_APPLY_LATER', 'BLOCKED_RISK', 'NEEDS_MANUAL_REVIEW'] as const) {
      const result = classifyMigrationConfirmation({
        baseClassification: base,
        baseReason: 'x',
        titleYearSanityPassed: false, // even with sanity failing
        orphanedWatchedEpisodes: [orphan(1, 1)],
        currentUserStatus: UserSeriesStatus.WATCHING,
        migration: { migrationIntent: false },
      });
      expect(migrationOnlyValues).not.toContain(result.classification);
    }
  });
});

describe('classifyMigrationConfirmation — BLOCKED_DESTRUCTIVE_RISK (identity not confirmed)', () => {
  it('refuses migration when title/year sanity failed, regardless of intent or override', () => {
    const result = classifyMigrationConfirmation({
      baseClassification: 'BLOCKED_RISK',
      baseReason: 'candidate title does not resemble local title',
      titleYearSanityPassed: false,
      orphanedWatchedEpisodes: [],
      currentUserStatus: UserSeriesStatus.CAUGHT_UP,
      migration: { migrationIntent: true, statusOverride: UserSeriesStatus.COMPLETED },
    });
    expect(result.classification).toBe('BLOCKED_DESTRUCTIVE_RISK');
    expect(result.preservedOrphanEpisodes).toEqual([]);
    expect(result.resolvedUserStatus).toBe(UserSeriesStatus.CAUGHT_UP); // untouched
  });
});

describe('classifyMigrationConfirmation — Doctor Who style small season-0 orphan migration', () => {
  it('classifies SAFE_MIGRATION_WITH_PRESERVED_ORPHANS, carries CAUGHT_UP forward, preserves the 1 orphan', () => {
    const result = classifyMigrationConfirmation({
      baseClassification: 'SAFE_WITH_LOCAL_SPECIAL_ORPHAN',
      baseReason: 'benign season-0 orphan',
      titleYearSanityPassed: true,
      orphanedWatchedEpisodes: [orphan(0, 0)],
      currentUserStatus: UserSeriesStatus.CAUGHT_UP,
      migration: { migrationIntent: true },
    });
    expect(result.classification).toBe('SAFE_MIGRATION_WITH_PRESERVED_ORPHANS');
    expect(result.statusSource).toBe('derived');
    expect(result.resolvedUserStatus).toBe(UserSeriesStatus.CAUGHT_UP); // carried forward, not recomputed
    expect(result.preservedOrphanEpisodes).toEqual([orphan(0, 0)]);
  });
});

describe('classifyMigrationConfirmation — The Flash style small real-season orphan migration', () => {
  it('classifies SAFE_MIGRATION_WITH_PRESERVED_ORPHANS for a mid-season orphan the non-migration pipeline would block', () => {
    const orphans = [orphan(3, 0), orphan(0, 5)];
    const result = classifyMigrationConfirmation({
      baseClassification: 'BLOCKED_RISK', // this is exactly what the non-migration pipeline returns for The Flash
      baseReason: 'season 3 shrank: 24 local episode(s) vs. 23 from the provider',
      titleYearSanityPassed: true,
      orphanedWatchedEpisodes: orphans,
      currentUserStatus: UserSeriesStatus.WATCHING,
      migration: { migrationIntent: true },
    });
    expect(result.classification).toBe('SAFE_MIGRATION_WITH_PRESERVED_ORPHANS');
    expect(result.preservedOrphanEpisodes).toEqual(orphans);
    expect(result.resolvedUserStatus).toBe(UserSeriesStatus.WATCHING);
    expect(result.statusSource).toBe('derived');
  });
});

describe('classifyMigrationConfirmation — Naruto Shippuden style large absolute-numbering mismatch', () => {
  it('classifies SAFE_MIGRATION_WITH_STATUS_OVERRIDE when a statusOverride is explicitly provided, preserving all ~472 orphans', () => {
    const orphans = Array.from({ length: 472 }, (_, i) => orphan(2 + (i % 20), i));
    const result = classifyMigrationConfirmation({
      baseClassification: 'BLOCKED_RISK',
      baseReason: 'season 21 is missing entirely from the provider response; season 22 is missing entirely...',
      titleYearSanityPassed: true, // seasons 1-9 matched TMDb exactly, confirming identity
      orphanedWatchedEpisodes: orphans,
      currentUserStatus: UserSeriesStatus.CAUGHT_UP,
      migration: { migrationIntent: true, statusOverride: UserSeriesStatus.CAUGHT_UP },
    });
    expect(result.classification).toBe('SAFE_MIGRATION_WITH_STATUS_OVERRIDE');
    expect(result.statusSource).toBe('human-override');
    expect(result.resolvedUserStatus).toBe(UserSeriesStatus.CAUGHT_UP);
    expect(result.preservedOrphanEpisodes).toHaveLength(472);
    expect(result.preservedOrphanEpisodes).toEqual(orphans); // every single one accounted for, none dropped
  });

  it('without an explicit statusOverride, falls back to SAFE_MIGRATION_WITH_PRESERVED_ORPHANS and carries the current status forward instead of guessing', () => {
    const orphans = Array.from({ length: 472 }, (_, i) => orphan(2 + (i % 20), i));
    const result = classifyMigrationConfirmation({
      baseClassification: 'BLOCKED_RISK',
      baseReason: 'massive structural mismatch',
      titleYearSanityPassed: true,
      orphanedWatchedEpisodes: orphans,
      currentUserStatus: UserSeriesStatus.CAUGHT_UP,
      migration: { migrationIntent: true },
    });
    expect(result.classification).toBe('SAFE_MIGRATION_WITH_PRESERVED_ORPHANS');
    expect(result.statusSource).toBe('derived');
    expect(result.resolvedUserStatus).toBe(UserSeriesStatus.CAUGHT_UP);
  });
});

describe('classifyMigrationConfirmation — no status override unless explicitly provided', () => {
  it('carries the current status forward unchanged when statusOverride is omitted', () => {
    const result = classifyMigrationConfirmation({
      baseClassification: 'BLOCKED_RISK',
      baseReason: 'x',
      titleYearSanityPassed: true,
      orphanedWatchedEpisodes: [orphan(1, 1)],
      currentUserStatus: UserSeriesStatus.WATCHING,
      migration: { migrationIntent: true },
    });
    expect(result.statusSource).toBe('derived');
    expect(result.resolvedUserStatus).toBe(UserSeriesStatus.WATCHING);
  });

  it('uses human-override status source only when statusOverride is explicitly set', () => {
    const result = classifyMigrationConfirmation({
      baseClassification: 'BLOCKED_RISK',
      baseReason: 'x',
      titleYearSanityPassed: true,
      orphanedWatchedEpisodes: [orphan(1, 1)],
      currentUserStatus: UserSeriesStatus.WATCHING,
      migration: { migrationIntent: true, statusOverride: UserSeriesStatus.COMPLETED },
    });
    expect(result.statusSource).toBe('human-override');
    expect(result.resolvedUserStatus).toBe(UserSeriesStatus.COMPLETED);
  });
});

describe('classifyMigrationConfirmation — DROPPED/PAUSED protection remains intact', () => {
  it.each([UserSeriesStatus.DROPPED, UserSeriesStatus.PAUSED])('never overrides %s even with an explicit statusOverride', (protectedStatus) => {
    const result = classifyMigrationConfirmation({
      baseClassification: 'BLOCKED_RISK',
      baseReason: 'x',
      titleYearSanityPassed: true,
      orphanedWatchedEpisodes: [orphan(1, 1)],
      currentUserStatus: protectedStatus,
      migration: { migrationIntent: true, statusOverride: UserSeriesStatus.COMPLETED },
    });
    expect(result.resolvedUserStatus).toBe(protectedStatus);
    expect(result.statusSource).toBe('derived');
    // Still a positive migration classification — orphans are preserved,
    // just the status override itself is refused.
    expect(result.classification).toBe('SAFE_MIGRATION_WITH_PRESERVED_ORPHANS');
  });

  it('protection holds even with zero orphans and an override', () => {
    const result = classifyMigrationConfirmation({
      baseClassification: 'SAFE_TO_APPLY_LATER',
      baseReason: 'x',
      titleYearSanityPassed: true,
      orphanedWatchedEpisodes: [],
      currentUserStatus: UserSeriesStatus.DROPPED,
      migration: { migrationIntent: true, statusOverride: UserSeriesStatus.WATCHING },
    });
    expect(result.resolvedUserStatus).toBe(UserSeriesStatus.DROPPED);
  });
});

describe('buildMigrationApplyPlan — no watched episode deletion / no orphan touched', () => {
  const localEpisodes: LocalEpisodeForApply[] = [
    { id: 'ep-1', seasonNumber: 1, episodeNumber: 1, title: null, overview: null, airDate: null, runtimeMinutes: null },
    { id: 'ep-2', seasonNumber: 1, episodeNumber: 2, title: null, overview: null, airDate: null, runtimeMinutes: null }, // orphan — no provider counterpart
  ];
  const providerEpisodes: ProviderEpisodeForApply[] = [
    { seasonNumber: 1, episodeNumber: 1, title: 'Pilot', overviewHtml: '<p>It begins.</p>', airDate: '2020-01-01', runtimeMinutes: 30 },
  ];

  it('never includes an orphan episode id in episodeUpdates — the plan has no delete/restructure path at all', () => {
    const plan = buildMigrationApplyPlan({
      seriesId: 's1',
      title: 'Some Show',
      provider: 'tmdb',
      providerId: '1',
      userId: 'u1',
      currentPosterUrl: null,
      providerPosterUrl: null,
      localEpisodes,
      providerEpisodes,
      orphanedWatchedEpisodes: [orphan(1, 2, 'ep-2')],
      resolvedUserStatus: UserSeriesStatus.CAUGHT_UP,
      statusSource: 'derived',
      currentNextEpisodeId: null,
    });
    expect(plan.episodeUpdates.map((u) => u.episodeId)).not.toContain('ep-2');
    expect(plan.preservedOrphanEpisodes).toEqual([orphan(1, 2, 'ep-2')]);
    expect(Object.keys(plan)).not.toContain('deletedEpisodeIds');
  });

  it('throws rather than silently producing an unsafe plan if an orphan somehow appears in episodeUpdates (defensive invariant)', () => {
    // Constructed adversarial input: provider now DOES have a slot for ep-2,
    // so it's not really an orphan any more — but the caller mistakenly
    // still lists it as one. The plan builder must refuse rather than
    // silently doing whatever the (buggy) caller says.
    const providerEpisodesWithMatch: ProviderEpisodeForApply[] = [
      ...providerEpisodes,
      { seasonNumber: 1, episodeNumber: 2, title: 'Episode 2', overviewHtml: null, airDate: null, runtimeMinutes: null },
    ];
    expect(() =>
      buildMigrationApplyPlan({
        seriesId: 's1',
        title: 'Some Show',
        provider: 'tmdb',
        providerId: '1',
        userId: 'u1',
        currentPosterUrl: null,
        providerPosterUrl: null,
        localEpisodes,
        providerEpisodes: providerEpisodesWithMatch,
        orphanedWatchedEpisodes: [orphan(1, 2, 'ep-2')],
        resolvedUserStatus: UserSeriesStatus.CAUGHT_UP,
        statusSource: 'derived',
        currentNextEpisodeId: null,
      }),
    ).toThrow(/invariant violated/);
  });

  it('preserves every orphan at Naruto-Shippuden scale (472) with none dropped', () => {
    const bigLocalEpisodes: LocalEpisodeForApply[] = Array.from({ length: 472 }, (_, i) => ({
      id: `orphan-${i}`,
      seasonNumber: 2 + (i % 20),
      episodeNumber: 1000 + i, // guaranteed no provider counterpart
      title: null,
      overview: null,
      airDate: null,
      runtimeMinutes: null,
    }));
    const bigOrphans = bigLocalEpisodes.map((e) => orphan(e.seasonNumber, e.episodeNumber, e.id));

    const plan = buildMigrationApplyPlan({
      seriesId: 's1',
      title: 'Naruto Shippuden',
      provider: 'tmdb',
      providerId: '31910',
      userId: 'u1',
      currentPosterUrl: null,
      providerPosterUrl: null,
      localEpisodes: [...localEpisodes, ...bigLocalEpisodes],
      providerEpisodes,
      orphanedWatchedEpisodes: [orphan(1, 2, 'ep-2'), ...bigOrphans],
      resolvedUserStatus: UserSeriesStatus.CAUGHT_UP,
      statusSource: 'human-override',
      currentNextEpisodeId: null,
    });

    expect(plan.preservedOrphanEpisodes).toHaveLength(473);
    const updatedIds = new Set(plan.episodeUpdates.map((u) => u.episodeId));
    for (const o of plan.preservedOrphanEpisodes) {
      expect(updatedIds.has(o.id)).toBe(false);
    }
  });

  it('nulls nextEpisodeId for finished statuses (COMPLETED/CAUGHT_UP), never recomputing it from provider matching', () => {
    const completedPlan = buildMigrationApplyPlan({
      seriesId: 's1', title: 'Show', provider: 'tmdb', providerId: '1', userId: 'u1',
      currentPosterUrl: null, providerPosterUrl: null, localEpisodes, providerEpisodes,
      orphanedWatchedEpisodes: [], resolvedUserStatus: UserSeriesStatus.COMPLETED, statusSource: 'human-override',
      currentNextEpisodeId: 'ep-existing-next',
    });
    expect(completedPlan.progressUpdate.nextEpisodeId).toBeNull();

    const caughtUpPlan = buildMigrationApplyPlan({
      seriesId: 's1', title: 'Show', provider: 'tmdb', providerId: '1', userId: 'u1',
      currentPosterUrl: null, providerPosterUrl: null, localEpisodes, providerEpisodes,
      orphanedWatchedEpisodes: [], resolvedUserStatus: UserSeriesStatus.CAUGHT_UP, statusSource: 'derived',
      currentNextEpisodeId: 'ep-existing-next',
    });
    expect(caughtUpPlan.progressUpdate.nextEpisodeId).toBeNull();
  });

  it('carries the current nextEpisodeId forward unchanged for a non-finished status (WATCHING) — never recomputed', () => {
    const plan = buildMigrationApplyPlan({
      seriesId: 's1', title: 'Show', provider: 'tmdb', providerId: '1', userId: 'u1',
      currentPosterUrl: null, providerPosterUrl: null, localEpisodes, providerEpisodes,
      orphanedWatchedEpisodes: [], resolvedUserStatus: UserSeriesStatus.WATCHING, statusSource: 'derived',
      currentNextEpisodeId: 'ep-existing-next',
    });
    expect(plan.progressUpdate.nextEpisodeId).toBe('ep-existing-next');
  });

  it('uses the same field-update rules as the non-migration plan (planEpisodeUpdate is reused, not reimplemented) — an existing non-null field that differs from the provider still updates, same as today', () => {
    const localWithData: LocalEpisodeForApply[] = [{ id: 'ep-1', seasonNumber: 1, episodeNumber: 1, title: 'My Curated Title', overview: null, airDate: null, runtimeMinutes: null }];
    const plan = buildMigrationApplyPlan({
      seriesId: 's1', title: 'Show', provider: 'tmdb', providerId: '1', userId: 'u1',
      currentPosterUrl: null, providerPosterUrl: null, localEpisodes: localWithData, providerEpisodes,
      orphanedWatchedEpisodes: [], resolvedUserStatus: UserSeriesStatus.WATCHING, statusSource: 'derived',
      currentNextEpisodeId: null,
    });
    // Migration mode doesn't change field-update semantics at all — it
    // only changes orphan tolerance and status handling. Matched-episode
    // field updates go through the exact same planEpisodeUpdate as the
    // ordinary pipeline (see apply-friends-tvmaze-logic.ts).
    const titleChange = plan.episodeUpdates.find((u) => u.episodeId === 'ep-1');
    expect(titleChange?.changes.title).toBe('Pilot');
  });

  it('sets externalIdsUpdate.tmdbId to the providerId for a tmdb migration match', () => {
    const plan = buildMigrationApplyPlan({
      seriesId: 's1', title: 'Naruto Shippuden', provider: 'tmdb', providerId: '31910', userId: 'u1',
      currentPosterUrl: null, providerPosterUrl: null, localEpisodes, providerEpisodes,
      orphanedWatchedEpisodes: [], resolvedUserStatus: UserSeriesStatus.CAUGHT_UP, statusSource: 'human-override',
      currentNextEpisodeId: null,
    });
    expect(plan.externalIdsUpdate.tmdbId).toBe('31910');
  });

  it('leaves externalIdsUpdate.tmdbId undefined for a tvmaze migration match', () => {
    const plan = buildMigrationApplyPlan({
      seriesId: 's1', title: 'Some Show', provider: 'tvmaze', providerId: '431', userId: 'u1',
      currentPosterUrl: null, providerPosterUrl: null, localEpisodes, providerEpisodes,
      orphanedWatchedEpisodes: [], resolvedUserStatus: UserSeriesStatus.WATCHING, statusSource: 'derived',
      currentNextEpisodeId: null,
    });
    expect(plan.externalIdsUpdate.tmdbId).toBeUndefined();
  });
});
