import { planSeriesShowIdBackfill } from '../backfill-tvtime-show-id';

describe('planSeriesShowIdBackfill', () => {
  it('sets tvtimeShowId when a series has exactly one distinct id across its episodes', () => {
    const plan = planSeriesShowIdBackfill(
      ['series-a'],
      [
        { seriesId: 'series-a', tvtimeShowId: 'show-1' },
        { seriesId: 'series-a', tvtimeShowId: 'show-1' },
        { seriesId: 'series-a', tvtimeShowId: 'show-1' },
      ],
      new Map(),
    );

    expect(plan.updates).toEqual([{ seriesId: 'series-a', tvtimeShowId: 'show-1' }]);
    expect(plan.alreadyUpToDate).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it('does not guess when a series has conflicting tvtimeShowIds', () => {
    const plan = planSeriesShowIdBackfill(
      ['series-a'],
      [
        { seriesId: 'series-a', tvtimeShowId: 'show-1' },
        { seriesId: 'series-a', tvtimeShowId: 'show-2' },
      ],
      new Map(),
    );

    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([{ seriesId: 'series-a', distinctTvtimeShowIds: ['show-1', 'show-2'] }]);
  });

  it('skips series with no tvtimeShowId-bearing episodes at all (e.g. seed-only series)', () => {
    const plan = planSeriesShowIdBackfill(['series-a', 'series-b'], [{ seriesId: 'series-a', tvtimeShowId: 'show-1' }], new Map());

    expect(plan.skipped).toEqual(['series-b']);
    expect(plan.updates).toEqual([{ seriesId: 'series-a', tvtimeShowId: 'show-1' }]);
  });

  it('treats null tvtimeShowId episode rows as no evidence, not a conflict', () => {
    const plan = planSeriesShowIdBackfill(
      ['series-a'],
      [
        { seriesId: 'series-a', tvtimeShowId: null },
        { seriesId: 'series-a', tvtimeShowId: 'show-1' },
      ],
      new Map(),
    );

    expect(plan.updates).toEqual([{ seriesId: 'series-a', tvtimeShowId: 'show-1' }]);
    expect(plan.conflicts).toEqual([]);
  });

  it('is idempotent: a series already correctly backfilled is reported as up-to-date, not re-updated', () => {
    const plan = planSeriesShowIdBackfill(
      ['series-a'],
      [{ seriesId: 'series-a', tvtimeShowId: 'show-1' }],
      new Map([['series-a', 'show-1']]),
    );

    expect(plan.updates).toEqual([]);
    expect(plan.alreadyUpToDate).toEqual(['series-a']);
  });

  it('re-updates a series whose stored value no longer matches the (single) derived value', () => {
    const plan = planSeriesShowIdBackfill(
      ['series-a'],
      [{ seriesId: 'series-a', tvtimeShowId: 'show-2' }],
      new Map([['series-a', 'show-1']]),
    );

    expect(plan.updates).toEqual([{ seriesId: 'series-a', tvtimeShowId: 'show-2' }]);
  });

  it('handles a realistic mixed batch in one pass', () => {
    const plan = planSeriesShowIdBackfill(
      ['clean', 'conflicted', 'no-episodes', 'already-set'],
      [
        { seriesId: 'clean', tvtimeShowId: 'show-1' },
        { seriesId: 'clean', tvtimeShowId: 'show-1' },
        { seriesId: 'conflicted', tvtimeShowId: 'show-2' },
        { seriesId: 'conflicted', tvtimeShowId: 'show-3' },
        { seriesId: 'already-set', tvtimeShowId: 'show-4' },
      ],
      new Map([['already-set', 'show-4']]),
    );

    expect(plan.updates).toEqual([{ seriesId: 'clean', tvtimeShowId: 'show-1' }]);
    expect(plan.alreadyUpToDate).toEqual(['already-set']);
    expect(plan.skipped).toEqual(['no-episodes']);
    expect(plan.conflicts).toEqual([{ seriesId: 'conflicted', distinctTvtimeShowIds: ['show-2', 'show-3'] }]);
  });
});
