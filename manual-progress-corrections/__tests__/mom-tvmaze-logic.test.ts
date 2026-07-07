import {
  buildMergedEpisodeRows,
  checkAbortConditions,
  findEpisodeBySeasonEpisode,
  isAtOrBefore,
  LocalEpisodeForPlan,
  MergedEpisodeRow,
  parseTvMazeDate,
  planMomEnrichment,
  stripHtml,
  TvMazeEpisodeForPlan,
  validateTvMazeShowMatch,
} from '../mom-tvmaze-logic';

const EXPECTED = { name: 'Mom', network: 'CBS', premieredYear: 2013, status: 'Ended' };

describe('validateTvMazeShowMatch', () => {
  it('accepts an exact match on all four fields', () => {
    const result = validateTvMazeShowMatch({ name: 'Mom', network: 'CBS', premiered: '2013-09-23', status: 'Ended' }, EXPECTED);
    expect(result.valid).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('is case-insensitive on name/network/status', () => {
    const result = validateTvMazeShowMatch({ name: 'MOM', network: 'cbs', premiered: '2013-01-01', status: 'ENDED' }, EXPECTED);
    expect(result.valid).toBe(true);
  });

  it('rejects a different name', () => {
    const result = validateTvMazeShowMatch({ name: 'Mom (2013 Reboot)', network: 'CBS', premiered: '2013-09-23', status: 'Ended' }, EXPECTED);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes('name'))).toBe(true);
  });

  it('rejects a different network', () => {
    const result = validateTvMazeShowMatch({ name: 'Mom', network: 'NBC', premiered: '2013-09-23', status: 'Ended' }, EXPECTED);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes('network'))).toBe(true);
  });

  it('rejects a different premiered year', () => {
    const result = validateTvMazeShowMatch({ name: 'Mom', network: 'CBS', premiered: '2015-01-01', status: 'Ended' }, EXPECTED);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes('premiered year'))).toBe(true);
  });

  it('rejects a non-ended status', () => {
    const result = validateTvMazeShowMatch({ name: 'Mom', network: 'CBS', premiered: '2013-09-23', status: 'Running' }, EXPECTED);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes('status'))).toBe(true);
  });

  it('rejects a null network', () => {
    const result = validateTvMazeShowMatch({ name: 'Mom', network: null, premiered: '2013-09-23', status: 'Ended' }, EXPECTED);
    expect(result.valid).toBe(false);
  });
});

describe('isAtOrBefore', () => {
  it('treats an earlier season as before', () => {
    expect(isAtOrBefore({ seasonNumber: 4, episodeNumber: 22 }, { seasonNumber: 5, episodeNumber: 13 })).toBe(true);
  });

  it('treats a later season as not before', () => {
    expect(isAtOrBefore({ seasonNumber: 6, episodeNumber: 1 }, { seasonNumber: 5, episodeNumber: 13 })).toBe(false);
  });

  it('treats an earlier episode in the same season as before', () => {
    expect(isAtOrBefore({ seasonNumber: 5, episodeNumber: 12 }, { seasonNumber: 5, episodeNumber: 13 })).toBe(true);
  });

  it('treats the exact cutoff episode as at-or-before (inclusive)', () => {
    expect(isAtOrBefore({ seasonNumber: 5, episodeNumber: 13 }, { seasonNumber: 5, episodeNumber: 13 })).toBe(true);
  });

  it('treats a later episode in the same season as not before', () => {
    expect(isAtOrBefore({ seasonNumber: 5, episodeNumber: 14 }, { seasonNumber: 5, episodeNumber: 13 })).toBe(false);
  });
});

describe('findEpisodeBySeasonEpisode', () => {
  it('finds a matching episode', () => {
    const episodes = [{ seasonNumber: 5, episodeNumber: 14, id: 'x' }];
    expect(findEpisodeBySeasonEpisode(episodes, 5, 14)?.id).toBe('x');
  });

  it('returns null when not found', () => {
    expect(findEpisodeBySeasonEpisode([{ seasonNumber: 5, episodeNumber: 2 }], 5, 14)).toBeNull();
  });
});

describe('stripHtml', () => {
  it('strips simple paragraph tags', () => {
    expect(stripHtml('<p>Bonnie throws a party.</p>')).toBe('Bonnie throws a party.');
  });

  it('collapses internal whitespace', () => {
    expect(stripHtml('<p>Line one.</p>\n<p>Line two.</p>')).toBe('Line one. Line two.');
  });

  it('returns null for null input', () => {
    expect(stripHtml(null)).toBeNull();
  });

  it('returns null for empty/whitespace-only input', () => {
    expect(stripHtml('   ')).toBeNull();
  });
});

describe('parseTvMazeDate', () => {
  it('parses a YYYY-MM-DD date string', () => {
    const date = parseTvMazeDate('2018-01-04');
    expect(date?.toISOString()).toBe('2018-01-04T00:00:00.000Z');
  });

  it('returns null for null input', () => {
    expect(parseTvMazeDate(null)).toBeNull();
  });
});

function tvMazeEp(seasonNumber: number, episodeNumber: number, tvMazeId = seasonNumber * 100 + episodeNumber): TvMazeEpisodeForPlan {
  return { seasonNumber, episodeNumber, tvMazeId, title: `S${seasonNumber}E${episodeNumber}`, overview: null, airDate: null, runtimeMinutes: 22 };
}

describe('buildMergedEpisodeRows', () => {
  it('marks an episode with a local match and existing watch as watched', () => {
    const local: LocalEpisodeForPlan[] = [{ seasonNumber: 1, episodeNumber: 1, id: 'local-1' }];
    const rows = buildMergedEpisodeRows([tvMazeEp(1, 1)], local, new Set(['local-1']));
    expect(rows[0].localEpisodeId).toBe('local-1');
    expect(rows[0].isWatched).toBe(true);
  });

  it('marks an episode with a local match but no watch as not watched', () => {
    const local: LocalEpisodeForPlan[] = [{ seasonNumber: 1, episodeNumber: 1, id: 'local-1' }];
    const rows = buildMergedEpisodeRows([tvMazeEp(1, 1)], local, new Set());
    expect(rows[0].isWatched).toBe(false);
  });

  it('marks an episode with no local match as not existing and not watched', () => {
    const rows = buildMergedEpisodeRows([tvMazeEp(5, 14)], [], new Set());
    expect(rows[0].localEpisodeId).toBeNull();
    expect(rows[0].isWatched).toBe(false);
  });
});

describe('planMomEnrichment', () => {
  const cutoff = { seasonNumber: 5, episodeNumber: 13 };

  function row(overrides: Partial<MergedEpisodeRow>): MergedEpisodeRow {
    return {
      seasonNumber: 1,
      episodeNumber: 1,
      tvMazeId: 1,
      title: null,
      overview: null,
      airDate: null,
      runtimeMinutes: null,
      localEpisodeId: 'existing',
      isWatched: true,
      ...overrides,
    };
  }

  it('classifies an existing, already-watched, at-cutoff episode as alreadyExists + alreadyWatchedAtOrBeforeCutoff', () => {
    const rows = [row({ seasonNumber: 5, episodeNumber: 2, localEpisodeId: 'e', isWatched: true })];
    const plan = planMomEnrichment(rows, cutoff);
    expect(plan.alreadyExists).toHaveLength(1);
    expect(plan.alreadyWatchedAtOrBeforeCutoff).toHaveLength(1);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toMarkWatched).toHaveLength(0);
  });

  it('classifies a missing, at-cutoff episode as toCreate + toMarkWatched', () => {
    const rows = [row({ seasonNumber: 5, episodeNumber: 3, localEpisodeId: null, isWatched: false })];
    const plan = planMomEnrichment(rows, cutoff);
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.toMarkWatched).toHaveLength(1);
    expect(plan.alreadyExists).toHaveLength(0);
  });

  it('classifies the desired next episode (just after cutoff) as toCreate but never toMarkWatched', () => {
    const rows = [row({ seasonNumber: 5, episodeNumber: 14, localEpisodeId: null, isWatched: false })];
    const plan = planMomEnrichment(rows, cutoff);
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.toMarkWatched).toHaveLength(0);
    expect(plan.afterCutoffUnwatched).toHaveLength(1);
  });

  it('never marks an after-cutoff episode watched even if it already exists locally', () => {
    const rows = [row({ seasonNumber: 5, episodeNumber: 15, localEpisodeId: 'e', isWatched: false })];
    const plan = planMomEnrichment(rows, cutoff);
    expect(plan.toMarkWatched).toHaveLength(0);
    expect(plan.afterCutoffUnwatched).toHaveLength(1);
  });
});

describe('checkAbortConditions', () => {
  const validShowMatch = { valid: true, reasons: [] };

  it('does not abort when everything checks out', () => {
    const result = checkAbortConditions({ localSeriesMatchCount: 1, showMatchValidation: validShowMatch, nextEpisodeFoundInTvMaze: true });
    expect(result.shouldAbort).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('aborts when the local series match is ambiguous', () => {
    const result = checkAbortConditions({ localSeriesMatchCount: 2, showMatchValidation: validShowMatch, nextEpisodeFoundInTvMaze: true });
    expect(result.shouldAbort).toBe(true);
    expect(result.reasons.some((r) => r.includes('ambiguous'))).toBe(true);
  });

  it('aborts when the local series is missing entirely', () => {
    const result = checkAbortConditions({ localSeriesMatchCount: 0, showMatchValidation: validShowMatch, nextEpisodeFoundInTvMaze: true });
    expect(result.shouldAbort).toBe(true);
  });

  it('aborts when the TVmaze show match failed', () => {
    const result = checkAbortConditions({
      localSeriesMatchCount: 1,
      showMatchValidation: { valid: false, reasons: ['network "NBC" does not exactly match expected "CBS"'] },
      nextEpisodeFoundInTvMaze: true,
    });
    expect(result.shouldAbort).toBe(true);
    expect(result.reasons.some((r) => r.includes('NBC'))).toBe(true);
  });

  it('aborts when the desired next episode was not found', () => {
    const result = checkAbortConditions({ localSeriesMatchCount: 1, showMatchValidation: validShowMatch, nextEpisodeFoundInTvMaze: false });
    expect(result.shouldAbort).toBe(true);
    expect(result.reasons.some((r) => r.includes('S5E14'))).toBe(true);
  });

  it('collects reasons from multiple simultaneous failures', () => {
    const result = checkAbortConditions({
      localSeriesMatchCount: 0,
      showMatchValidation: { valid: false, reasons: ['bad'] },
      nextEpisodeFoundInTvMaze: false,
    });
    expect(result.reasons).toHaveLength(3);
  });
});
