import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { classifySeriesHealth, LocalEpisodeHealthInput, SeriesHealthInput } from '../health-logic';

const NOW = new Date('2026-07-07T12:00:00.000Z');
const PAST = new Date('2026-01-01');
const FUTURE = new Date('2027-01-01');

function ep(overrides: Partial<LocalEpisodeHealthInput> & Pick<LocalEpisodeHealthInput, 'seasonNumber' | 'episodeNumber'>): LocalEpisodeHealthInput {
  return {
    id: `ep-${overrides.seasonNumber}-${overrides.episodeNumber}`,
    title: 'Some Episode',
    airDate: PAST,
    watched: false,
    ...overrides,
  };
}

function baseInput(overrides: Partial<SeriesHealthInput> = {}): SeriesHealthInput {
  return {
    seriesId: 'series-1',
    title: 'Some Show',
    releaseStatus: ReleaseStatus.RETURNING,
    posterUrl: 'https://example.com/poster.jpg',
    backdropUrl: 'https://example.com/backdrop.jpg',
    externalIds: { tmdbId: 'tmdb-123', provider: null, providerId: null, matchConfidence: null, matchSource: null },
    episodes: [],
    progress: null,
    now: NOW,
    ...overrides,
  };
}

describe('classifySeriesHealth — untracked / low priority', () => {
  it('classifies a series with no progress row as UNTRACKED_OR_LOW_PRIORITY', () => {
    const result = classifySeriesHealth(baseInput({ progress: null }));
    expect(result.classification).toBe('UNTRACKED_OR_LOW_PRIORITY');
    expect(result.recommendedNextAction).toBe('NO_ACTION');
  });

  it.each([UserSeriesStatus.DROPPED, UserSeriesStatus.PAUSED, UserSeriesStatus.WATCHLIST, UserSeriesStatus.UNKNOWN])(
    'classifies userStatus %s as UNTRACKED_OR_LOW_PRIORITY even with otherwise-healthy data',
    (userStatus) => {
      const result = classifySeriesHealth(
        baseInput({
          episodes: [ep({ seasonNumber: 1, episodeNumber: 1, watched: true })],
          progress: { userStatus, nextEpisodeId: null, lastWatchedAt: PAST },
        }),
      );
      expect(result.classification).toBe('UNTRACKED_OR_LOW_PRIORITY');
    },
  );

  it('still reports userStatus/lastWatchedAt fields even when untracked', () => {
    const result = classifySeriesHealth(baseInput({ progress: { userStatus: UserSeriesStatus.PAUSED, nextEpisodeId: null, lastWatchedAt: PAST } }));
    expect(result.userStatus).toBe(UserSeriesStatus.PAUSED);
    expect(result.lastWatchedAt).toBe(PAST);
  });
});

describe('classifySeriesHealth — provider match', () => {
  const activeProgress = { userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null, lastWatchedAt: PAST };

  it('classifies MISSING_PROVIDER_MATCH when there is no externalIds row at all', () => {
    const result = classifySeriesHealth(baseInput({ externalIds: null, progress: activeProgress }));
    expect(result.classification).toBe('MISSING_PROVIDER_MATCH');
    expect(result.recommendedNextAction).toBe('RUN_TARGETED_PROVIDER_AUDIT');
    expect(result.riskFlags).toContain('NO_PROVIDER_MATCH');
  });

  it('classifies MISSING_PROVIDER_MATCH when externalIds exists but nothing has ever been attempted', () => {
    const result = classifySeriesHealth(
      baseInput({ externalIds: { tmdbId: null, provider: null, providerId: null, matchConfidence: null, matchSource: null }, progress: activeProgress }),
    );
    expect(result.classification).toBe('MISSING_PROVIDER_MATCH');
  });

  it('classifies NEEDS_MANUAL_CONFIRMATION when a match attempt left a trace but was never confirmed', () => {
    const result = classifySeriesHealth(
      baseInput({
        externalIds: { tmdbId: null, provider: 'tmdb', providerId: '999', matchConfidence: 0.4, matchSource: 'search' },
        progress: activeProgress,
      }),
    );
    expect(result.classification).toBe('NEEDS_MANUAL_CONFIRMATION');
    expect(result.recommendedNextAction).toBe('CONFIRM_PROVIDER_MATCH');
    expect(result.riskFlags).toContain('PENDING_PROVIDER_CANDIDATE');
  });

  it('extracts tvmazeId from provider/providerId when provider is tvmaze', () => {
    const result = classifySeriesHealth(
      baseInput({ externalIds: { tmdbId: null, provider: 'tvmaze', providerId: '4321', matchConfidence: null, matchSource: null }, progress: activeProgress }),
    );
    expect(result.tvmazeId).toBe('4321');
  });

  it('tvmazeId is null when provider is not tvmaze', () => {
    const result = classifySeriesHealth(baseInput({ progress: activeProgress }));
    expect(result.tvmazeId).toBeNull();
  });
});

describe('classifySeriesHealth — provider structure risk', () => {
  const activeProgress = { userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: null, lastWatchedAt: PAST };

  it('classifies a manually-curated risk-list title as PROVIDER_STRUCTURE_RISK with the anime-numbering action', () => {
    const result = classifySeriesHealth(baseInput({ title: 'Jujutsu Kaisen', progress: activeProgress }));
    expect(result.classification).toBe('PROVIDER_STRUCTURE_RISK');
    expect(result.recommendedNextAction).toBe('NEEDS_ABSOLUTE_NUMBERING_PROVIDER');
    expect(result.riskFlags).toContain('RISK_LISTED_EPISODE_NUMBERING');
  });

  it('classifies a newly-detected provider-structure-mismatch title the same way', () => {
    const result = classifySeriesHealth(baseInput({ title: 'Kaiju No. 8', progress: activeProgress }));
    expect(result.classification).toBe('PROVIDER_STRUCTURE_RISK');
    expect(result.recommendedNextAction).toBe('NEEDS_ABSOLUTE_NUMBERING_PROVIDER');
  });

  it('classifies a known season-shift-orphan title as PROVIDER_STRUCTURE_RISK with the generic MARK_AS_RISK action', () => {
    const result = classifySeriesHealth(baseInput({ title: 'Solar Opposites', progress: activeProgress }));
    expect(result.classification).toBe('PROVIDER_STRUCTURE_RISK');
    expect(result.recommendedNextAction).toBe('MARK_AS_RISK');
    expect(result.riskFlags).toContain('RISK_LISTED_SEASON_SHIFT_ORPHAN');
  });

  it('takes priority over a missing provider match', () => {
    const result = classifySeriesHealth(baseInput({ title: 'One Piece', externalIds: null, progress: activeProgress }));
    expect(result.classification).toBe('PROVIDER_STRUCTURE_RISK');
  });
});

describe('classifySeriesHealth — incomplete catalog', () => {
  const activeProgress = { userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null, lastWatchedAt: PAST };

  it('classifies INCOMPLETE_CATALOG when an actively-tracked series has zero local episodes', () => {
    const result = classifySeriesHealth(baseInput({ episodes: [], progress: activeProgress }));
    expect(result.classification).toBe('INCOMPLETE_CATALOG');
    expect(result.recommendedNextAction).toBe('APPLY_SAFE_PROVIDER_CATALOG_DRY_RUN');
    expect(result.riskFlags).toContain('NO_LOCAL_EPISODES');
  });

  it('classifies INCOMPLETE_CATALOG when watched episodes exist but almost all local episodes are unenriched TV-Time-only placeholders', () => {
    const episodes = Array.from({ length: 10 }, (_, i) => ep({ seasonNumber: 1, episodeNumber: i + 1, title: null, airDate: null, watched: i < 5 }));
    const result = classifySeriesHealth(baseInput({ episodes, progress: activeProgress }));
    expect(result.classification).toBe('INCOMPLETE_CATALOG');
    expect(result.riskFlags).toContain('MOSTLY_UNENRICHED_EPISODES');
  });

  it('does not flag MOSTLY_UNENRICHED_EPISODES when nothing has been watched yet (no signal the catalog matters yet)', () => {
    const episodes = Array.from({ length: 10 }, (_, i) => ep({ seasonNumber: 1, episodeNumber: i + 1, title: null, airDate: null, watched: false }));
    const result = classifySeriesHealth(baseInput({ episodes, progress: activeProgress }));
    expect(result.classification).not.toBe('INCOMPLETE_CATALOG');
  });

  it('does not flag a mostly-enriched catalog with only a couple of missing-metadata episodes', () => {
    const episodes = [
      ...Array.from({ length: 9 }, (_, i) => ep({ seasonNumber: 1, episodeNumber: i + 1, watched: true })),
      ep({ seasonNumber: 1, episodeNumber: 10, title: null, airDate: null, watched: true }),
    ];
    const result = classifySeriesHealth(baseInput({ episodes, progress: activeProgress }));
    expect(result.riskFlags).not.toContain('MOSTLY_UNENRICHED_EPISODES');
  });

  it('classifies INCOMPLETE_CATALOG when the stored nextEpisodeId no longer matches what the local catalog computes', () => {
    const episodes = [ep({ seasonNumber: 1, episodeNumber: 1, watched: true }), ep({ seasonNumber: 1, episodeNumber: 2, watched: false, airDate: PAST })];
    const result = classifySeriesHealth(
      baseInput({ episodes, progress: { userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: 'some-stale-id', lastWatchedAt: PAST } }),
    );
    expect(result.classification).toBe('INCOMPLETE_CATALOG');
    expect(result.riskFlags).toContain('NEXT_EPISODE_INCONSISTENT');
  });
});

describe('classifySeriesHealth — trusted buckets', () => {
  it('classifies WATCH_NEXT_TRUSTED when WATCHING with a consistent, released next episode', () => {
    const episodes = [ep({ seasonNumber: 1, episodeNumber: 1, watched: true }), ep({ seasonNumber: 1, episodeNumber: 2, watched: false, airDate: PAST })];
    const result = classifySeriesHealth(
      baseInput({ episodes, progress: { userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: 'ep-1-2', lastWatchedAt: PAST } }),
    );
    expect(result.classification).toBe('WATCH_NEXT_TRUSTED');
    expect(result.recommendedNextAction).toBe('NO_ACTION');
  });

  it('classifies READY when WATCHING but structurally has no next episode (e.g. only future episodes remain)', () => {
    const episodes = [ep({ seasonNumber: 1, episodeNumber: 1, watched: true }), ep({ seasonNumber: 1, episodeNumber: 2, watched: false, airDate: FUTURE })];
    const result = classifySeriesHealth(
      baseInput({ episodes, progress: { userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: null, lastWatchedAt: PAST } }),
    );
    expect(result.classification).toBe('READY');
    expect(result.recommendedNextAction).toBe('NO_ACTION');
  });

  it('classifies CAUGHT_UP_TRUSTED when CAUGHT_UP with everything known watched', () => {
    const episodes = [ep({ seasonNumber: 1, episodeNumber: 1, watched: true }), ep({ seasonNumber: 1, episodeNumber: 2, watched: true })];
    const result = classifySeriesHealth(
      baseInput({ episodes, progress: { userStatus: UserSeriesStatus.CAUGHT_UP, nextEpisodeId: null, lastWatchedAt: PAST } }),
    );
    expect(result.classification).toBe('CAUGHT_UP_TRUSTED');
  });

  it('classifies COMPLETED the same as CAUGHT_UP_TRUSTED', () => {
    const episodes = [ep({ seasonNumber: 1, episodeNumber: 1, watched: true })];
    const result = classifySeriesHealth(
      baseInput({ releaseStatus: ReleaseStatus.ENDED, episodes, progress: { userStatus: UserSeriesStatus.COMPLETED, nextEpisodeId: null, lastWatchedAt: PAST } }),
    );
    expect(result.classification).toBe('CAUGHT_UP_TRUSTED');
  });
});

describe('classifySeriesHealth — per-series fields', () => {
  it('reports hasPoster/hasBackdrop false when the URLs are null', () => {
    const result = classifySeriesHealth(baseInput({ posterUrl: null, backdropUrl: null, progress: null }));
    expect(result.hasPoster).toBe(false);
    expect(result.hasBackdrop).toBe(false);
  });

  it('reports localEpisodeCount and watchedEpisodeCount accurately', () => {
    const episodes = [ep({ seasonNumber: 1, episodeNumber: 1, watched: true }), ep({ seasonNumber: 1, episodeNumber: 2, watched: false, airDate: FUTURE })];
    const result = classifySeriesHealth(
      baseInput({ episodes, progress: { userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: null, lastWatchedAt: PAST } }),
    );
    expect(result.localEpisodeCount).toBe(2);
    expect(result.watchedEpisodeCount).toBe(1);
  });

  it('carries seriesId/title/releaseStatus through unchanged', () => {
    const result = classifySeriesHealth(baseInput({ seriesId: 'abc-123', title: 'My Show', releaseStatus: ReleaseStatus.ENDED, progress: null }));
    expect(result.seriesId).toBe('abc-123');
    expect(result.title).toBe('My Show');
    expect(result.releaseStatus).toBe(ReleaseStatus.ENDED);
  });
});
