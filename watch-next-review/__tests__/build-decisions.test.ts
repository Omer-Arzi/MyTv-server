import { buildDecisions, ReviewItemForDecision } from '../build-decisions';

function item(overrides: Partial<ReviewItemForDecision> = {}): ReviewItemForDecision {
  return {
    mytvSeriesId: 'series-1',
    seriesTitle: 'Some Series',
    category: 'NEEDS_MANUAL_DECISION',
    userStatus: 'WATCHING',
    currentNextEpisode: { episodeId: 'episode-1' },
    ...overrides,
  };
}

describe('buildDecisions', () => {
  it('prefills mark_caught_up only for TVMAZE_SAYS_CAUGHT_UP', () => {
    const [decision] = buildDecisions([item({ category: 'TVMAZE_SAYS_CAUGHT_UP' })]);
    expect(decision.decision).toBe('mark_caught_up');
  });

  it('prefills keep_in_watch_next for KEEP_IN_WATCH_NEXT_CONFIDENT', () => {
    const [decision] = buildDecisions([item({ category: 'KEEP_IN_WATCH_NEXT_CONFIDENT' })]);
    expect(decision.decision).toBe('keep_in_watch_next');
  });

  it('prefills needs_mapping for REMAKE_COLLISION', () => {
    const [decision] = buildDecisions([item({ category: 'REMAKE_COLLISION' })]);
    expect(decision.decision).toBe('needs_mapping');
  });

  it('prefills needs_mapping for PROVIDER_EPISODE_COUNT_DISAGREEMENT', () => {
    const [decision] = buildDecisions([item({ category: 'PROVIDER_EPISODE_COUNT_DISAGREEMENT' })]);
    expect(decision.decision).toBe('needs_mapping');
  });

  it('prefills ignore_for_now for NO_SECONDARY_PROVIDER_MATCH', () => {
    const [decision] = buildDecisions([item({ category: 'NO_SECONDARY_PROVIDER_MATCH' })]);
    expect(decision.decision).toBe('ignore_for_now');
  });

  it('prefills ignore_for_now for TVMAZE_NEXT_IS_TBA', () => {
    const [decision] = buildDecisions([item({ category: 'TVMAZE_NEXT_IS_TBA' })]);
    expect(decision.decision).toBe('ignore_for_now');
  });

  it('prefills ignore_for_now for NEEDS_MANUAL_DECISION', () => {
    const [decision] = buildDecisions([item({ category: 'NEEDS_MANUAL_DECISION' })]);
    expect(decision.decision).toBe('ignore_for_now');
  });

  it('never prefills mark_caught_up for any category other than TVMAZE_SAYS_CAUGHT_UP', () => {
    const categories: ReviewItemForDecision['category'][] = [
      'KEEP_IN_WATCH_NEXT_CONFIDENT',
      'PROVIDER_EPISODE_COUNT_DISAGREEMENT',
      'TVMAZE_NEXT_IS_TBA',
      'NO_SECONDARY_PROVIDER_MATCH',
      'REMAKE_COLLISION',
      'NEEDS_MANUAL_DECISION',
    ];
    const decisions = buildDecisions(categories.map((category) => item({ category })));
    expect(decisions.every((d) => d.decision !== 'mark_caught_up')).toBe(true);
  });

  it('carries the reviewed userStatus and next-episode id through for later staleness checks', () => {
    const [decision] = buildDecisions([item({ category: 'TVMAZE_SAYS_CAUGHT_UP', userStatus: 'WATCHING', currentNextEpisode: { episodeId: 'ep-42' } })]);
    expect(decision.reviewedUserStatus).toBe('WATCHING');
    expect(decision.reviewedNextEpisodeId).toBe('ep-42');
  });
});
