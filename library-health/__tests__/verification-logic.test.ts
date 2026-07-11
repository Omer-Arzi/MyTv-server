import { verifySeriesPostApply, verifyBatchScope, verifyClassificationConvergence, verifyBatch, SeriesSnapshot, PostApplyExpectation } from '../verification-logic';

const BATCH_ID = 'library-health:provider-confirmation-pipeline:catalog-reconciliation';

function snapshot(overrides: Partial<SeriesSnapshot> = {}): SeriesSnapshot {
  return {
    seriesId: 's1',
    episodes: [
      { id: 'e1', seasonNumber: 1, episodeNumber: 1, importBatchId: null },
      { id: 'e2', seasonNumber: 1, episodeNumber: 2, importBatchId: null },
      { id: 'orph1', seasonNumber: 1, episodeNumber: 99, importBatchId: null },
    ],
    seasons: [{ seasonNumber: 1, importBatchId: null }],
    episodeWatches: [{ episodeId: 'e1' }, { episodeId: 'e2' }, { episodeId: 'orph1' }],
    progress: { userStatus: 'WATCHING', nextEpisodeId: null },
    ...overrides,
  };
}

function expectation(overrides: Partial<PostApplyExpectation> = {}): PostApplyExpectation {
  return {
    seriesId: 's1',
    expectedImportBatchId: BATCH_ID,
    expectedNewSeasonNumbers: [2],
    expectedNewEpisodeCount: 2,
    preservedOrphanEpisodeIds: ['orph1'],
    expectedUserStatus: 'COMPLETED',
    expectedNextEpisodeId: null,
    ...overrides,
  };
}

function successfulAfter(): SeriesSnapshot {
  return snapshot({
    episodes: [
      { id: 'e1', seasonNumber: 1, episodeNumber: 1, importBatchId: null },
      { id: 'e2', seasonNumber: 1, episodeNumber: 2, importBatchId: null },
      { id: 'orph1', seasonNumber: 1, episodeNumber: 99, importBatchId: null },
      { id: 'new1', seasonNumber: 2, episodeNumber: 1, importBatchId: BATCH_ID },
      { id: 'new2', seasonNumber: 2, episodeNumber: 2, importBatchId: BATCH_ID },
    ],
    seasons: [
      { seasonNumber: 1, importBatchId: null },
      { seasonNumber: 2, importBatchId: BATCH_ID },
    ],
    episodeWatches: [{ episodeId: 'e1' }, { episodeId: 'e2' }, { episodeId: 'orph1' }],
    progress: { userStatus: 'COMPLETED', nextEpisodeId: null },
  });
}

describe('verifySeriesPostApply', () => {
  it('passes every check for a correctly-applied catalog reconciliation', () => {
    const result = verifySeriesPostApply(snapshot(), successfulAfter(), expectation());
    expect(result.passed).toBe(true);
    expect(result.checks.every((c) => c.status === 'PASS')).toBe(true);
  });

  it('catches an extra row: a new episode with the wrong/missing importBatchId', () => {
    const after = successfulAfter();
    after.episodes.push({ id: 'rogue', seasonNumber: 3, episodeNumber: 1, importBatchId: null });
    const result = verifySeriesPostApply(snapshot(), after, expectation());
    expect(result.passed).toBe(false);
    const failed = result.checks.find((c) => c.name === 'new-episodes-carry-expected-provenance');
    expect(failed?.status).toBe('FAIL');
  });

  it('catches a missing row: an existing episode that disappeared', () => {
    const after = successfulAfter();
    after.episodes = after.episodes.filter((e) => e.id !== 'e1');
    const result = verifySeriesPostApply(snapshot(), after, expectation());
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name === 'no-episode-deletions')?.status).toBe('FAIL');
  });

  it('catches a changed orphan: the preserved orphan got renumbered', () => {
    const after = successfulAfter();
    after.episodes = after.episodes.map((e) => (e.id === 'orph1' ? { ...e, episodeNumber: 100 } : e));
    const result = verifySeriesPostApply(snapshot(), after, expectation());
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name === 'preserved-orphans-untouched')?.status).toBe('FAIL');
    // Also legitimately flags this as unexpected renumbering of an existing episode.
    expect(result.checks.find((c) => c.name === 'no-unexpected-renumbering')?.status).toBe('FAIL');
  });

  it('catches a lost EpisodeWatch: a prior watch record disappeared', () => {
    const after = successfulAfter();
    after.episodeWatches = after.episodeWatches.filter((w) => w.episodeId !== 'orph1');
    const result = verifySeriesPostApply(snapshot(), after, expectation());
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name === 'no-lost-watch-records')?.status).toBe('FAIL');
  });

  it('catches a newly-created episode that got auto-watched', () => {
    const after = successfulAfter();
    after.episodeWatches.push({ episodeId: 'new1' });
    const result = verifySeriesPostApply(snapshot(), after, expectation());
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name === 'new-episodes-not-auto-watched')?.status).toBe('FAIL');
  });

  it('catches an unplanned progress mutation: userStatus does not match what was expected', () => {
    const after = successfulAfter();
    after.progress = { userStatus: 'DROPPED', nextEpisodeId: null };
    const result = verifySeriesPostApply(snapshot(), after, expectation());
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name === 'progress-status-matches-expected')?.status).toBe('FAIL');
  });

  it('catches an unexpected nextEpisodeId change', () => {
    const after = successfulAfter();
    after.progress = { userStatus: 'COMPLETED', nextEpisodeId: 'e1' };
    const result = verifySeriesPostApply(snapshot(), after, expectation({ expectedNextEpisodeId: null }));
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name === 'progress-next-episode-matches-expected')?.status).toBe('FAIL');
  });

  it('accepts correct derived progress with a real nextEpisodeId (not just null)', () => {
    const after = snapshot({
      episodes: [
        { id: 'e1', seasonNumber: 1, episodeNumber: 1, importBatchId: null },
        { id: 'e2', seasonNumber: 1, episodeNumber: 2, importBatchId: null },
        { id: 'orph1', seasonNumber: 1, episodeNumber: 99, importBatchId: null },
      ],
      seasons: [{ seasonNumber: 1, importBatchId: null }],
      progress: { userStatus: 'WATCHING', nextEpisodeId: 'e2' },
    });
    const result = verifySeriesPostApply(
      snapshot({ progress: { userStatus: 'WATCHING', nextEpisodeId: 'e1' } }),
      after,
      expectation({ expectedNewSeasonNumbers: [], expectedNewEpisodeCount: 0, expectedUserStatus: 'WATCHING', expectedNextEpisodeId: 'e2' }),
    );
    expect(result.passed).toBe(true);
  });

  it('catches wrong season count when fewer/more seasons were created than expected', () => {
    const after = successfulAfter();
    after.seasons.push({ seasonNumber: 3, importBatchId: BATCH_ID });
    after.episodes.push({ id: 'new3', seasonNumber: 3, episodeNumber: 1, importBatchId: BATCH_ID });
    const result = verifySeriesPostApply(snapshot(), after, expectation({ expectedNewEpisodeCount: 3 }));
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name === 'new-seasons-match-expected')?.status).toBe('FAIL');
  });
});

describe('verifyBatchScope', () => {
  it('passes when only manifest series were touched', () => {
    const check = verifyBatchScope(['s1', 's2'], ['s1', 's2', 's3']);
    expect(check.status).toBe('PASS');
  });

  it('fails when a series outside the manifest was touched', () => {
    const check = verifyBatchScope(['s1', 's-unrelated'], ['s1']);
    expect(check.status).toBe('FAIL');
    expect(check.detail).toContain('s-unrelated');
  });
});

describe('verifyClassificationConvergence', () => {
  it('accepts AUTO_REFRESH as the only valid convergence outcome', () => {
    expect(verifyClassificationConvergence('AUTO_REFRESH').status).toBe('PASS');
  });

  it('rejects REVIEW_ALIGNMENT / REVIEW_IDENTITY / PROVIDER_ERROR / AUTO_MIGRATE as non-converged', () => {
    for (const c of ['REVIEW_ALIGNMENT', 'REVIEW_IDENTITY', 'PROVIDER_ERROR', 'AUTO_MIGRATE']) {
      expect(verifyClassificationConvergence(c).status).toBe('FAIL');
    }
  });

  // Explicit regression test for the task's own callout: FUTURE_ONLY is a
  // valid, accurate convergence state (a real future episode remains
  // pending) — it must not be treated as an error just because it isn't
  // NO_CHANGE. AUTO_REFRESH already covers FUTURE_ONLY per
  // refresh-operating-outcome.ts's mapping, so passing the *mapped*
  // top-level value here (as the real caller would) passes correctly.
  it('does not require NO_CHANGE specifically — AUTO_REFRESH (which subsumes FUTURE_ONLY) is sufficient', () => {
    expect(verifyClassificationConvergence('AUTO_REFRESH').status).toBe('PASS');
  });
});

describe('verifyBatch', () => {
  it('passes only when scope check and every series result pass', () => {
    const passingSeries = verifySeriesPostApply(snapshot(), successfulAfter(), expectation());
    const scopeOk = verifyBatchScope(['s1'], ['s1']);
    expect(verifyBatch('batch-1', [passingSeries], scopeOk).passed).toBe(true);
  });

  it('fails the whole batch if any single series fails, even if scope is fine', () => {
    const after = successfulAfter();
    after.progress = { userStatus: 'DROPPED', nextEpisodeId: null };
    const failingSeries = verifySeriesPostApply(snapshot(), after, expectation());
    const scopeOk = verifyBatchScope(['s1'], ['s1']);
    expect(verifyBatch('batch-1', [failingSeries], scopeOk).passed).toBe(false);
  });

  it('fails the whole batch if scope check fails, even if every series result passes', () => {
    const passingSeries = verifySeriesPostApply(snapshot(), successfulAfter(), expectation());
    const scopeBad = verifyBatchScope(['s1', 's-unrelated'], ['s1']);
    expect(verifyBatch('batch-1', [passingSeries], scopeBad).passed).toBe(false);
  });
});
