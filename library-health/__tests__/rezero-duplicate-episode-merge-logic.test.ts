import { buildReZeroMergePlan, LegacyEpisodeInput, SurvivorEpisodeInput, WatchInfo } from '../rezero-duplicate-episode-merge-logic';

function watch(overrides: Partial<WatchInfo> & Pick<WatchInfo, 'id' | 'watchedAt'>): WatchInfo {
  return { rewatchCount: 0, watchDateApproximate: false, watchSource: 'SINGLE', importBatchId: null, rawMetadata: null, ...overrides };
}

describe('buildReZeroMergePlan', () => {
  it('replaces the survivor watch with the legacy watch when both sides are watched (the real Re:Zero shape)', () => {
    const legacyEpisodes: LegacyEpisodeInput[] = [
      { id: 'legacy-4-1', seasonId: 'season-4', seasonNumber: 4, episodeNumber: 1, watch: watch({ id: 'watch-legacy-1', watchedAt: '2026-04-08T00:00:00.000Z' }) },
    ];
    const survivorEpisodesByNumber = new Map<number, SurvivorEpisodeInput>([
      [67, { id: 'survivor-1-67', episodeNumber: 67, watch: watch({ id: 'watch-survivor-67', watchedAt: '2026-07-12T09:33:15.536Z' }) }],
    ]);

    const plan = buildReZeroMergePlan({ legacyEpisodes, survivorEpisodesByNumber });

    expect(plan.warnings).toEqual([]);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      kind: 'replace_survivor_watch_with_legacy',
      legacyEpisodeId: 'legacy-4-1',
      legacyLabel: 'S4E1',
      survivorEpisodeId: 'survivor-1-67',
      survivorLabel: 'S1E67',
    });
    expect(plan.actions[0].survivorWatchToDelete?.id).toBe('watch-survivor-67');
    expect(plan.actions[0].legacyWatch?.id).toBe('watch-legacy-1');
    expect(plan.seasonsToRemove).toEqual([{ seasonId: 'season-4', seasonNumber: 4, legacyEpisodeIds: ['legacy-4-1'] }]);
  });

  it('moves the legacy watch onto the survivor with no conflict when only the legacy side is watched', () => {
    const legacyEpisodes: LegacyEpisodeInput[] = [{ id: 'legacy-2-1', seasonId: 'season-2', seasonNumber: 2, episodeNumber: 1, watch: watch({ id: 'watch-legacy-1', watchedAt: '2020-07-09T05:34:08.000Z' }) }];
    const survivorEpisodesByNumber = new Map<number, SurvivorEpisodeInput>([[26, { id: 'survivor-1-26', episodeNumber: 26, watch: null }]]);

    const plan = buildReZeroMergePlan({ legacyEpisodes, survivorEpisodesByNumber });

    expect(plan.actions[0].kind).toBe('move_watch_no_conflict');
    expect(plan.actions[0].survivorWatchToDelete).toBeNull();
  });

  it('deletes the legacy episode with nothing to move when neither side is watched', () => {
    const legacyEpisodes: LegacyEpisodeInput[] = [{ id: 'legacy-3-5', seasonId: 'season-3', seasonNumber: 3, episodeNumber: 5, watch: null }];
    const survivorEpisodesByNumber = new Map<number, SurvivorEpisodeInput>([[55, { id: 'survivor-1-55', episodeNumber: 55, watch: null }]]);

    const plan = buildReZeroMergePlan({ legacyEpisodes, survivorEpisodesByNumber });

    expect(plan.actions[0].kind).toBe('delete_legacy_only_no_watch');
    expect(plan.actions[0].legacyWatch).toBeNull();
    expect(plan.actions[0].survivorWatchToDelete).toBeNull();
  });

  it('warns and skips (does not merge) a legacy episode in a season with no known offset -- safeguard: stop on unexpected data', () => {
    const legacyEpisodes: LegacyEpisodeInput[] = [{ id: 'legacy-5-1', seasonId: 'season-5', seasonNumber: 5, episodeNumber: 1, watch: null }];
    const survivorEpisodesByNumber = new Map<number, SurvivorEpisodeInput>();

    const plan = buildReZeroMergePlan({ legacyEpisodes, survivorEpisodesByNumber });

    expect(plan.actions).toEqual([]);
    expect(plan.seasonsToRemove).toEqual([]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('unexpected season');
  });

  it('warns and skips (does not merge) a legacy episode whose expected survivor is missing -- never fabricates a target', () => {
    const legacyEpisodes: LegacyEpisodeInput[] = [{ id: 'legacy-4-12', seasonId: 'season-4', seasonNumber: 4, episodeNumber: 12, watch: null }];
    const survivorEpisodesByNumber = new Map<number, SurvivorEpisodeInput>(); // no absolute episode 78 provided

    const plan = buildReZeroMergePlan({ legacyEpisodes, survivorEpisodesByNumber });

    expect(plan.actions).toEqual([]);
    expect(plan.warnings[0]).toContain('no Season 1 counterpart at absolute episode 78');
  });

  it('groups multiple legacy episodes from the same season into one seasonsToRemove entry', () => {
    const legacyEpisodes: LegacyEpisodeInput[] = [
      { id: 'legacy-2-1', seasonId: 'season-2', seasonNumber: 2, episodeNumber: 1, watch: null },
      { id: 'legacy-2-2', seasonId: 'season-2', seasonNumber: 2, episodeNumber: 2, watch: null },
    ];
    const survivorEpisodesByNumber = new Map<number, SurvivorEpisodeInput>([
      [26, { id: 'survivor-1-26', episodeNumber: 26, watch: null }],
      [27, { id: 'survivor-1-27', episodeNumber: 27, watch: null }],
    ]);

    const plan = buildReZeroMergePlan({ legacyEpisodes, survivorEpisodesByNumber });

    expect(plan.seasonsToRemove).toHaveLength(1);
    expect(plan.seasonsToRemove[0].legacyEpisodeIds).toEqual(['legacy-2-1', 'legacy-2-2']);
  });
});
