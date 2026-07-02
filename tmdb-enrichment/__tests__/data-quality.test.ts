import { detectDuplicateTitleGroups, detectPlaceholderTitle, detectRemakeCollision } from '../data-quality';

describe('detectPlaceholderTitle', () => {
  it('flags a TV Time error/placeholder string wrapped in asterisks', () => {
    const issue = detectPlaceholderTitle('***Movies are not allowed***');
    expect(issue).not.toBeNull();
    expect(issue?.type).toBe('PLACEHOLDER_TITLE');
  });

  it('does not flag a real series title', () => {
    expect(detectPlaceholderTitle('Breaking Bad')).toBeNull();
  });

  it('does not flag a real series title that merely contains an asterisk-like character elsewhere', () => {
    expect(detectPlaceholderTitle('A Man on the Inside')).toBeNull();
  });
});

describe('detectRemakeCollision', () => {
  const base = {
    mytvSeriesTitle: 'Avatar: The Last Airbender',
    chosenTmdbTitle: 'Avatar: The Last Airbender',
    chosenTmdbYear: 2024,
    animeNumberingRiskDetected: false,
    closeCompetitorKind: null,
  };

  it('flags a meaningfully over-watched match as a likely remake collision (the real Avatar case)', () => {
    const issue = detectRemakeCollision({ ...base, watchedEpisodeCount: 61, tmdbTotalEpisodeCount: 15 });
    expect(issue).not.toBeNull();
    expect(issue?.type).toBe('REMAKE_COLLISION');
  });

  it('does not flag a small off-by-one overage (likely a special/OVA, not a wrong match)', () => {
    const issue = detectRemakeCollision({ ...base, watchedEpisodeCount: 171, tmdbTotalEpisodeCount: 170 });
    expect(issue).toBeNull();
  });

  it('does not flag an overage already explained by anime numbering risk', () => {
    const issue = detectRemakeCollision({ ...base, watchedEpisodeCount: 130, tmdbTotalEpisodeCount: 87, animeNumberingRiskDetected: true });
    expect(issue).toBeNull();
  });

  it('does not flag a normal in-progress match (watched <= total)', () => {
    const issue = detectRemakeCollision({ ...base, watchedEpisodeCount: 5, tmdbTotalEpisodeCount: 12 });
    expect(issue).toBeNull();
  });

  it('flags when a same-title/different-year competitor was found, even without a big overage', () => {
    const issue = detectRemakeCollision({ ...base, watchedEpisodeCount: 8, tmdbTotalEpisodeCount: 8, closeCompetitorKind: 'same_title_different_year' });
    expect(issue).not.toBeNull();
    expect(issue?.type).toBe('REMAKE_COLLISION');
  });
});

describe('detectDuplicateTitleGroups', () => {
  it('groups MyTv series that share a bare title but differ on year suffix', () => {
    const groups = detectDuplicateTitleGroups([
      { id: 's1', title: 'Avatar: The Last Airbender' },
      { id: 's2', title: 'Avatar: The Last Airbender (2021)' },
      { id: 's3', title: 'Breaking Bad' },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.id).sort()).toEqual(['s1', 's2']);
  });

  it('returns no groups when every title is unique', () => {
    const groups = detectDuplicateTitleGroups([
      { id: 's1', title: 'Breaking Bad' },
      { id: 's2', title: 'Better Call Saul' },
    ]);

    expect(groups).toHaveLength(0);
  });

  it('is case- and whitespace-insensitive when grouping', () => {
    const groups = detectDuplicateTitleGroups([
      { id: 's1', title: 'breaking   bad' },
      { id: 's2', title: 'Breaking Bad (2008)' },
    ]);

    expect(groups).toHaveLength(1);
  });
});
