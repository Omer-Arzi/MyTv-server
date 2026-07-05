import { remapDecisions, CurrentEpisodeInfo, CurrentSeriesInfo, DecisionToRemap, ReviewedEpisodePosition } from '../remap-decisions';

function decision(overrides: Partial<DecisionToRemap> = {}): DecisionToRemap {
  return {
    mytvSeriesId: 'old-series-1',
    seriesTitle: 'Frieren: Beyond Journey\'s End',
    category: 'TVMAZE_SAYS_CAUGHT_UP',
    decision: 'mark_caught_up',
    reason: 'user confirmed everything actually released has been watched',
    reviewedUserStatus: 'WATCHING',
    reviewedNextEpisodeId: 'old-episode-1',
    ...overrides,
  };
}

describe('remapDecisions', () => {
  it('remaps mytvSeriesId and reviewedNextEpisodeId when series and episode position both resolve', () => {
    const currentSeries: CurrentSeriesInfo[] = [{ title: 'Frieren: Beyond Journey\'s End', seriesId: 'new-series-1' }];
    const currentEpisodes: CurrentEpisodeInfo[] = [{ seriesId: 'new-series-1', seasonNumber: 1, episodeNumber: 29, episodeId: 'new-episode-1' }];
    const positions: ReviewedEpisodePosition[] = [{ seriesTitle: 'Frieren: Beyond Journey\'s End', seasonNumber: 1, episodeNumber: 29 }];

    const result = remapDecisions([decision()], currentSeries, currentEpisodes, positions);

    expect(result.decisions[0].mytvSeriesId).toBe('new-series-1');
    expect(result.decisions[0].reviewedNextEpisodeId).toBe('new-episode-1');
    expect(result.remappedSeriesIds).toEqual([{ title: 'Frieren: Beyond Journey\'s End', oldSeriesId: 'old-series-1', newSeriesId: 'new-series-1' }]);
    expect(result.remappedEpisodeIds).toEqual([{ title: 'Frieren: Beyond Journey\'s End', oldEpisodeId: 'old-episode-1', newEpisodeId: 'new-episode-1' }]);
    expect(result.unmatchedSeriesTitles).toEqual([]);
    expect(result.unmatchedEpisodesForMarkCaughtUp).toEqual([]);
  });

  it('never changes decision, category, or reason fields', () => {
    const currentSeries: CurrentSeriesInfo[] = [{ title: 'Frieren: Beyond Journey\'s End', seriesId: 'new-series-1' }];
    const currentEpisodes: CurrentEpisodeInfo[] = [{ seriesId: 'new-series-1', seasonNumber: 1, episodeNumber: 29, episodeId: 'new-episode-1' }];
    const positions: ReviewedEpisodePosition[] = [{ seriesTitle: 'Frieren: Beyond Journey\'s End', seasonNumber: 1, episodeNumber: 29 }];

    const original = decision();
    const result = remapDecisions([original], currentSeries, currentEpisodes, positions);

    expect(result.decisions[0].decision).toBe(original.decision);
    expect(result.decisions[0].category).toBe(original.category);
    expect(result.decisions[0].reason).toBe(original.reason);
  });

  it('reports an unmatched series title and leaves that decision unchanged', () => {
    const result = remapDecisions([decision({ seriesTitle: 'Nonexistent Show' })], [], [], []);
    expect(result.unmatchedSeriesTitles).toEqual(['Nonexistent Show']);
    expect(result.decisions[0].mytvSeriesId).toBe('old-series-1');
  });

  it('reports an ambiguous series title (duplicate) and leaves that decision unchanged', () => {
    const currentSeries: CurrentSeriesInfo[] = [
      { title: 'Frieren: Beyond Journey\'s End', seriesId: 'dup-1' },
      { title: 'Frieren: Beyond Journey\'s End', seriesId: 'dup-2' },
    ];
    const result = remapDecisions([decision()], currentSeries, [], []);
    expect(result.ambiguousSeriesTitles).toEqual(['Frieren: Beyond Journey\'s End']);
    expect(result.decisions[0].mytvSeriesId).toBe('old-series-1');
  });

  it('flags a mark_caught_up decision whose episode position cannot be found', () => {
    const currentSeries: CurrentSeriesInfo[] = [{ title: 'Frieren: Beyond Journey\'s End', seriesId: 'new-series-1' }];
    const result = remapDecisions([decision()], currentSeries, [], [{ seriesTitle: 'Frieren: Beyond Journey\'s End', seasonNumber: 1, episodeNumber: 29 }]);
    expect(result.unmatchedEpisodesForMarkCaughtUp).toEqual(['Frieren: Beyond Journey\'s End']);
    // series id still remaps even though the episode could not be resolved
    expect(result.decisions[0].mytvSeriesId).toBe('new-series-1');
    expect(result.decisions[0].reviewedNextEpisodeId).toBe('old-episode-1');
  });

  it('does not require an episode match for a non-mark_caught_up decision', () => {
    const currentSeries: CurrentSeriesInfo[] = [{ title: 'Rurouni Kenshin', seriesId: 'new-series-2' }];
    const result = remapDecisions(
      [decision({ seriesTitle: 'Rurouni Kenshin', decision: 'needs_mapping', category: 'REMAKE_COLLISION' })],
      currentSeries,
      [],
      [],
    );
    expect(result.unmatchedEpisodesForMarkCaughtUp).toEqual([]);
    expect(result.decisions[0].mytvSeriesId).toBe('new-series-2');
  });

  it('handles a mix of resolvable and unresolvable decisions independently', () => {
    const decisions = [
      decision({ mytvSeriesId: 'old-1', seriesTitle: 'Show A' }),
      decision({ mytvSeriesId: 'old-2', seriesTitle: 'Show B (missing)' }),
    ];
    const currentSeries: CurrentSeriesInfo[] = [{ title: 'Show A', seriesId: 'new-1' }];
    const currentEpisodes: CurrentEpisodeInfo[] = [{ seriesId: 'new-1', seasonNumber: 1, episodeNumber: 29, episodeId: 'new-ep-1' }];
    const positions: ReviewedEpisodePosition[] = [{ seriesTitle: 'Show A', seasonNumber: 1, episodeNumber: 29 }];

    const result = remapDecisions(decisions, currentSeries, currentEpisodes, positions);
    expect(result.decisions[0].mytvSeriesId).toBe('new-1');
    expect(result.decisions[0].reviewedNextEpisodeId).toBe('new-ep-1');
    expect(result.unmatchedSeriesTitles).toEqual(['Show B (missing)']);
  });
});
