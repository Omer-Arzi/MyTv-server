import { buildEpisodeInsertPlan, previewEpisodeInsertCounts } from '../build-episode-insert-plan';
import { NewEpisodeFound, ProviderEpisodeInput, RefreshClassification } from '../refresh-logic';

const PAST = new Date('2026-01-01');
const FUTURE = new Date('2027-01-01');

function newEp(overrides: Partial<NewEpisodeFound> & Pick<NewEpisodeFound, 'seasonNumber' | 'episodeNumber' | 'released'>): NewEpisodeFound {
  return { title: null, airDate: PAST, ...overrides };
}

function providerEp(overrides: Partial<ProviderEpisodeInput> & Pick<ProviderEpisodeInput, 'seasonNumber' | 'episodeNumber'>): ProviderEpisodeInput {
  return { title: null, overview: null, airDate: PAST, imageUrl: null, runtimeMinutes: null, ...overrides };
}

describe('buildEpisodeInsertPlan', () => {
  const NON_NEW_RELEASE_CLASSIFICATIONS: RefreshClassification[] = [
    'NO_CHANGE',
    'FUTURE_ONLY',
    'NEEDS_MANUAL_REVIEW',
    'RISKY_DO_NOT_APPLY',
    'SUSPICIOUS_BULK_INSERT',
    'SEASON_ZERO_PROPOSED',
    'PROVIDER_ERROR',
  ];

  it.each(NON_NEW_RELEASE_CLASSIFICATIONS)('returns an empty plan for classification %s even when newEpisodes is non-empty', (classification) => {
    const plan = buildEpisodeInsertPlan({
      classification,
      newEpisodes: [newEp({ seasonNumber: 1, episodeNumber: 2, released: true })],
      providerEpisodes: [providerEp({ seasonNumber: 1, episodeNumber: 2 })],
      localSeasonNumbers: [1],
    });
    expect(plan).toEqual({ episodesToInsert: [], seasonNumbersToCreate: [] });
  });

  it('plans only released new episodes, excluding future ones', () => {
    const plan = buildEpisodeInsertPlan({
      classification: 'NEW_RELEASE_AVAILABLE',
      newEpisodes: [
        newEp({ seasonNumber: 1, episodeNumber: 2, released: true, airDate: PAST }),
        newEp({ seasonNumber: 1, episodeNumber: 3, released: false, airDate: FUTURE }),
      ],
      providerEpisodes: [providerEp({ seasonNumber: 1, episodeNumber: 2, airDate: PAST }), providerEp({ seasonNumber: 1, episodeNumber: 3, airDate: FUTURE })],
      localSeasonNumbers: [1],
    });
    expect(plan.episodesToInsert).toHaveLength(1);
    expect(plan.episodesToInsert[0]).toMatchObject({ seasonNumber: 1, episodeNumber: 2 });
  });

  it('carries full episode fields (overview/imageUrl/runtimeMinutes) from providerEpisodes, not just newEpisodes', () => {
    const plan = buildEpisodeInsertPlan({
      classification: 'NEW_RELEASE_AVAILABLE',
      newEpisodes: [newEp({ seasonNumber: 1, episodeNumber: 2, released: true, title: 'Report Title' })],
      providerEpisodes: [
        providerEp({ seasonNumber: 1, episodeNumber: 2, title: 'Full Title', overview: 'A great episode', imageUrl: 'https://img/still.jpg', runtimeMinutes: 42 }),
      ],
      localSeasonNumbers: [1],
    });
    expect(plan.episodesToInsert[0]).toEqual({
      seasonNumber: 1,
      episodeNumber: 2,
      title: 'Full Title',
      overview: 'A great episode',
      airDate: PAST,
      imageUrl: 'https://img/still.jpg',
      runtimeMinutes: 42,
    });
  });

  it('falls back to newEpisodes.title and null metadata when no matching providerEpisodes entry exists', () => {
    const plan = buildEpisodeInsertPlan({
      classification: 'NEW_RELEASE_AVAILABLE',
      newEpisodes: [newEp({ seasonNumber: 1, episodeNumber: 2, released: true, title: 'Fallback Title' })],
      providerEpisodes: [],
      localSeasonNumbers: [1],
    });
    expect(plan.episodesToInsert[0]).toEqual({
      seasonNumber: 1,
      episodeNumber: 2,
      title: 'Fallback Title',
      overview: null,
      airDate: PAST,
      imageUrl: null,
      runtimeMinutes: null,
    });
  });

  it('flags a season not present locally as needing creation', () => {
    const plan = buildEpisodeInsertPlan({
      classification: 'NEW_RELEASE_AVAILABLE',
      newEpisodes: [newEp({ seasonNumber: 4, episodeNumber: 1, released: true })],
      providerEpisodes: [providerEp({ seasonNumber: 4, episodeNumber: 1 })],
      localSeasonNumbers: [1, 2, 3],
    });
    expect(plan.seasonNumbersToCreate).toEqual([4]);
  });

  it('does not flag an already-known local season as needing creation', () => {
    const plan = buildEpisodeInsertPlan({
      classification: 'NEW_RELEASE_AVAILABLE',
      newEpisodes: [newEp({ seasonNumber: 1, episodeNumber: 5, released: true })],
      providerEpisodes: [providerEp({ seasonNumber: 1, episodeNumber: 5 })],
      localSeasonNumbers: [1],
    });
    expect(plan.seasonNumbersToCreate).toEqual([]);
  });

  it('deduplicates and sorts seasonNumbersToCreate across multiple new episodes in the same new season', () => {
    const plan = buildEpisodeInsertPlan({
      classification: 'NEW_RELEASE_AVAILABLE',
      newEpisodes: [
        newEp({ seasonNumber: 5, episodeNumber: 2, released: true }),
        newEp({ seasonNumber: 5, episodeNumber: 1, released: true }),
        newEp({ seasonNumber: 4, episodeNumber: 1, released: true }),
      ],
      providerEpisodes: [
        providerEp({ seasonNumber: 5, episodeNumber: 2 }),
        providerEp({ seasonNumber: 5, episodeNumber: 1 }),
        providerEp({ seasonNumber: 4, episodeNumber: 1 }),
      ],
      localSeasonNumbers: [1, 2, 3],
    });
    expect(plan.seasonNumbersToCreate).toEqual([4, 5]);
  });

  it('returns an empty plan when there are no released new episodes at all', () => {
    const plan = buildEpisodeInsertPlan({
      classification: 'NEW_RELEASE_AVAILABLE',
      newEpisodes: [],
      providerEpisodes: [],
      localSeasonNumbers: [1],
    });
    expect(plan).toEqual({ episodesToInsert: [], seasonNumbersToCreate: [] });
  });

  // Blocks the ENTIRE series for SEASON_ZERO_PROPOSED, not just the
  // season-0 episodes within it — the batch here deliberately mixes a
  // season-0 episode with an ordinary season-1 one to prove the season-1
  // episode is refused too, not silently applied while season 0 is dropped.
  it('returns a fully empty plan for SEASON_ZERO_PROPOSED even when the batch also contains non-season-0 episodes', () => {
    const plan = buildEpisodeInsertPlan({
      classification: 'SEASON_ZERO_PROPOSED',
      newEpisodes: [newEp({ seasonNumber: 0, episodeNumber: 1, released: true }), newEp({ seasonNumber: 1, episodeNumber: 9, released: true })],
      providerEpisodes: [providerEp({ seasonNumber: 0, episodeNumber: 1 }), providerEp({ seasonNumber: 1, episodeNumber: 9 })],
      localSeasonNumbers: [0, 1],
    });
    expect(plan).toEqual({ episodesToInsert: [], seasonNumbersToCreate: [] });
  });
});

describe('previewEpisodeInsertCounts', () => {
  // The whole point of this function: unlike buildEpisodeInsertPlan (which
  // correctly returns zero for a blocked classification), the preview must
  // show the true would-be counts regardless of classification — this is
  // what lets a SUSPICIOUS_BULK_INSERT report entry show "90 proposed"
  // instead of a misleading "0 proposed".
  it('reports true counts even for a classification buildEpisodeInsertPlan would refuse (e.g. SUSPICIOUS_BULK_INSERT)', () => {
    const newEpisodes = Array.from({ length: 12 }, (_, i) => newEp({ seasonNumber: 5, episodeNumber: i + 1, released: true }));
    const providerEpisodes = Array.from({ length: 12 }, (_, i) => providerEp({ seasonNumber: 5, episodeNumber: i + 1 }));

    const blockedPlan = buildEpisodeInsertPlan({ classification: 'SUSPICIOUS_BULK_INSERT', newEpisodes, providerEpisodes, localSeasonNumbers: [1, 2, 3, 4] });
    expect(blockedPlan).toEqual({ episodesToInsert: [], seasonNumbersToCreate: [] });

    const preview = previewEpisodeInsertCounts({ newEpisodes, providerEpisodes, localSeasonNumbers: [1, 2, 3, 4] });
    expect(preview.episodeCount).toBe(12);
    expect(preview.seasonNumbers).toEqual([5]);
  });

  it('matches buildEpisodeInsertPlan exactly for NEW_RELEASE_AVAILABLE (no divergence for the actually-writable case)', () => {
    const newEpisodes = [newEp({ seasonNumber: 1, episodeNumber: 2, released: true })];
    const providerEpisodes = [providerEp({ seasonNumber: 1, episodeNumber: 2 })];

    const plan = buildEpisodeInsertPlan({ classification: 'NEW_RELEASE_AVAILABLE', newEpisodes, providerEpisodes, localSeasonNumbers: [1] });
    const preview = previewEpisodeInsertCounts({ newEpisodes, providerEpisodes, localSeasonNumbers: [1] });

    expect(preview.episodeCount).toBe(plan.episodesToInsert.length);
    expect(preview.seasonNumbers).toEqual(plan.seasonNumbersToCreate);
  });

  it('excludes future (unreleased) episodes from the preview, same as buildEpisodeInsertPlan', () => {
    const newEpisodes = [newEp({ seasonNumber: 1, episodeNumber: 2, released: false, airDate: FUTURE })];
    const providerEpisodes = [providerEp({ seasonNumber: 1, episodeNumber: 2, airDate: FUTURE })];

    const preview = previewEpisodeInsertCounts({ newEpisodes, providerEpisodes, localSeasonNumbers: [1] });
    expect(preview.episodeCount).toBe(0);
    expect(preview.seasonNumbers).toEqual([]);
  });
});
