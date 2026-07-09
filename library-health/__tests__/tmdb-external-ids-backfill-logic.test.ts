import { BackfillCandidateRow, planTmdbIdBackfill } from '../tmdb-external-ids-backfill-logic';

function candidate(overrides: Partial<BackfillCandidateRow> & { seriesId: string; providerId: string }): BackfillCandidateRow {
  return { title: `Series ${overrides.seriesId}`, matchSource: 'library-health:provider-confirmation-pipeline', ...overrides };
}

describe('planTmdbIdBackfill', () => {
  it('backfills every candidate when there are no collisions', () => {
    const candidates = [candidate({ seriesId: 's1', providerId: '100' }), candidate({ seriesId: 's2', providerId: '200' })];
    const plan = planTmdbIdBackfill({ candidates, existingTmdbIds: new Set() });
    expect(plan).toEqual([
      { seriesId: 's1', title: 'Series s1', providerId: '100', action: 'backfill', reason: expect.stringContaining('no collision') },
      { seriesId: 's2', title: 'Series s2', providerId: '200', action: 'backfill', reason: expect.stringContaining('no collision') },
    ]);
  });

  it('skips a candidate whose providerId collides with an existing tmdbId elsewhere in the table', () => {
    const candidates = [candidate({ seriesId: 's1', providerId: '100' })];
    const plan = planTmdbIdBackfill({ candidates, existingTmdbIds: new Set(['100']) });
    expect(plan[0].action).toBe('skip_collision');
    expect(plan[0].reason).toMatch(/already used by another existing/);
  });

  it('skips duplicate providerIds within the same candidate batch — only flags the second occurrence', () => {
    const candidates = [candidate({ seriesId: 's1', providerId: '100' }), candidate({ seriesId: 's2', providerId: '100' })];
    const plan = planTmdbIdBackfill({ candidates, existingTmdbIds: new Set() });
    expect(plan[0].action).toBe('backfill');
    expect(plan[1].action).toBe('skip_collision');
    expect(plan[1].reason).toMatch(/duplicated by another candidate/);
  });

  it('returns an empty plan for an empty candidate list', () => {
    expect(planTmdbIdBackfill({ candidates: [], existingTmdbIds: new Set() })).toEqual([]);
  });

  it('real-world scale: 29 clean candidates all backfill with zero collisions (matches the live audit)', () => {
    const candidates = Array.from({ length: 29 }, (_, i) => candidate({ seriesId: `s${i}`, providerId: `${1000 + i}` }));
    const plan = planTmdbIdBackfill({ candidates, existingTmdbIds: new Set(Array.from({ length: 200 }, (_, i) => `${2000 + i}`)) });
    expect(plan.every((p) => p.action === 'backfill')).toBe(true);
    expect(plan).toHaveLength(29);
  });
});
