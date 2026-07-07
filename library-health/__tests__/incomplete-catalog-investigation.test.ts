import { UserSeriesStatus } from '@prisma/client';
import { CompareSeriesCatalogResult } from '../../episode-release-refresh/refresh-logic';
import { investigateIncompleteCatalog, ProviderComparisonOutcome } from '../incomplete-catalog-investigation';

function fakeComparison(overrides: Partial<CompareSeriesCatalogResult> = {}): CompareSeriesCatalogResult {
  return {
    classification: 'NO_CHANGE',
    warnings: [],
    newEpisodes: [],
    releasedNewEpisodeCount: 0,
    futureNewEpisodeCount: 0,
    fieldChanges: [],
    releaseStatusChange: null,
    proposedNextEpisodeId: null,
    proposedNextEpisodeLabel: null,
    proposedNextEpisodeIsNew: false,
    nextEpisodeWouldChange: false,
    proposedUserStatus: UserSeriesStatus.CAUGHT_UP,
    userStatusWouldChangeToWatching: false,
    ...overrides,
  };
}

describe('investigateIncompleteCatalog — no provider match', () => {
  it('classifies NEEDS_PROVIDER_MATCH and recommends a TVmaze comparison, never auto-matching', () => {
    const result = investigateIncompleteCatalog({
      hasTmdbId: false,
      healthRiskFlags: ['NO_PROVIDER_MATCH'],
      localSeasonCount: 2,
      providerComparison: null,
    });
    expect(result.issueClassification).toBe('NEEDS_PROVIDER_MATCH');
    expect(result.recommendedNextAction).toBe('RUN_TVMAZE_COMPARISON');
    expect(result.reason).toMatch(/not auto-matching/);
  });

  it('ignores any providerComparison value when hasTmdbId is false', () => {
    const result = investigateIncompleteCatalog({
      hasTmdbId: false,
      healthRiskFlags: [],
      localSeasonCount: 1,
      providerComparison: { succeeded: true, comparison: fakeComparison({ classification: 'RISKY_DO_NOT_APPLY' }), providerSeasonCount: 1 },
    });
    expect(result.issueClassification).toBe('NEEDS_PROVIDER_MATCH');
  });
});

describe('investigateIncompleteCatalog — provider fetch outcome missing/failed', () => {
  it('classifies LIKELY_ALREADY_COMPLETE_BUT_UNTRUSTED and recommends retrying the refresh when no comparison was attempted', () => {
    const result = investigateIncompleteCatalog({
      hasTmdbId: true,
      healthRiskFlags: ['NEXT_EPISODE_INCONSISTENT'],
      localSeasonCount: 2,
      providerComparison: null,
    });
    expect(result.issueClassification).toBe('LIKELY_ALREADY_COMPLETE_BUT_UNTRUSTED');
    expect(result.recommendedNextAction).toBe('RUN_TARGETED_TMDB_REFRESH_DRY_RUN');
  });

  it('reports the fetch error and still recommends retrying when the TMDb fetch fails', () => {
    const outcome: ProviderComparisonOutcome = { succeeded: false, error: 'rate limited (429) after exhausting retries' };
    const result = investigateIncompleteCatalog({ hasTmdbId: true, healthRiskFlags: [], localSeasonCount: 1, providerComparison: outcome });
    expect(result.issueClassification).toBe('LIKELY_ALREADY_COMPLETE_BUT_UNTRUSTED');
    expect(result.recommendedNextAction).toBe('RUN_TARGETED_TMDB_REFRESH_DRY_RUN');
    expect(result.reason).toMatch(/rate limited/);
  });
});

describe('investigateIncompleteCatalog — RISKY_DO_NOT_APPLY from live comparison', () => {
  it('classifies NEEDS_ABSOLUTE_NUMBERING_PROVIDER when TMDb consolidates many local seasons into one', () => {
    const outcome: ProviderComparisonOutcome = {
      succeeded: true,
      comparison: fakeComparison({ classification: 'RISKY_DO_NOT_APPLY', warnings: ['season 2 is missing entirely from the provider response'] }),
      providerSeasonCount: 1,
    };
    const result = investigateIncompleteCatalog({ hasTmdbId: true, healthRiskFlags: [], localSeasonCount: 3, providerComparison: outcome });
    expect(result.issueClassification).toBe('NEEDS_ABSOLUTE_NUMBERING_PROVIDER');
    expect(result.recommendedNextAction).toBe('USE_ABSOLUTE_NUMBERING_PROVIDER_LATER');
    expect(result.reason).toMatch(/absolute-numbering/);
  });

  it('classifies PROVIDER_STRUCTURE_RISK for a shrink that is not a full consolidation to one season', () => {
    const outcome: ProviderComparisonOutcome = {
      succeeded: true,
      comparison: fakeComparison({ classification: 'RISKY_DO_NOT_APPLY', warnings: ['season 3 shrank: 12 local episode(s) vs. 8 from the provider'] }),
      providerSeasonCount: 3,
    };
    const result = investigateIncompleteCatalog({ hasTmdbId: true, healthRiskFlags: [], localSeasonCount: 3, providerComparison: outcome });
    expect(result.issueClassification).toBe('PROVIDER_STRUCTURE_RISK');
    expect(result.recommendedNextAction).toBe('ADD_TO_PROVIDER_STRUCTURE_RISK_LIST');
  });

  it('does not treat providerSeasonCount<=1 as absolute-numbering when local also only has one season', () => {
    const outcome: ProviderComparisonOutcome = {
      succeeded: true,
      comparison: fakeComparison({ classification: 'RISKY_DO_NOT_APPLY', warnings: ['watched episode S1E4 has no matching slot'] }),
      providerSeasonCount: 1,
    };
    const result = investigateIncompleteCatalog({ hasTmdbId: true, healthRiskFlags: [], localSeasonCount: 1, providerComparison: outcome });
    expect(result.issueClassification).toBe('PROVIDER_STRUCTURE_RISK');
  });
});

describe('investigateIncompleteCatalog — NEEDS_MANUAL_REVIEW from live comparison', () => {
  it('classifies NEEDS_MANUAL_USER_CONFIRMATION and asks the user to confirm progress', () => {
    const outcome: ProviderComparisonOutcome = {
      succeeded: true,
      comparison: fakeComparison({ classification: 'NEEDS_MANUAL_REVIEW', warnings: ['watched episode S1E1 has no matching slot in the provider'] }),
      providerSeasonCount: 2,
    };
    const result = investigateIncompleteCatalog({ hasTmdbId: true, healthRiskFlags: [], localSeasonCount: 2, providerComparison: outcome });
    expect(result.issueClassification).toBe('NEEDS_MANUAL_USER_CONFIRMATION');
    expect(result.recommendedNextAction).toBe('ASK_USER_TO_CONFIRM_PROGRESS');
  });
});

describe('investigateIncompleteCatalog — no structural risk', () => {
  it('classifies SAFE_PROVIDER_REFRESH_CANDIDATE when new released episodes are found', () => {
    const outcome: ProviderComparisonOutcome = {
      succeeded: true,
      comparison: fakeComparison({
        classification: 'NEW_RELEASE_AVAILABLE',
        newEpisodes: [{ seasonNumber: 1, episodeNumber: 5, title: 'New', airDate: new Date('2026-01-01'), released: true }],
        releasedNewEpisodeCount: 1,
      }),
      providerSeasonCount: 1,
    };
    const result = investigateIncompleteCatalog({ hasTmdbId: true, healthRiskFlags: [], localSeasonCount: 1, providerComparison: outcome });
    expect(result.issueClassification).toBe('SAFE_PROVIDER_REFRESH_CANDIDATE');
    expect(result.recommendedNextAction).toBe('RUN_TARGETED_TMDB_REFRESH_DRY_RUN');
  });

  it('classifies SAFE_PROVIDER_REFRESH_CANDIDATE when only future episodes are found', () => {
    const outcome: ProviderComparisonOutcome = {
      succeeded: true,
      comparison: fakeComparison({
        classification: 'FUTURE_ONLY',
        newEpisodes: [{ seasonNumber: 1, episodeNumber: 5, title: null, airDate: new Date('2099-01-01'), released: false }],
        futureNewEpisodeCount: 1,
      }),
      providerSeasonCount: 1,
    };
    const result = investigateIncompleteCatalog({ hasTmdbId: true, healthRiskFlags: [], localSeasonCount: 1, providerComparison: outcome });
    expect(result.issueClassification).toBe('SAFE_PROVIDER_REFRESH_CANDIDATE');
  });

  it('classifies LIKELY_ALREADY_COMPLETE_BUT_UNTRUSTED when the comparison finds NO_CHANGE (structurally fine, no new episodes)', () => {
    const outcome: ProviderComparisonOutcome = {
      succeeded: true,
      comparison: fakeComparison({ classification: 'NO_CHANGE' }),
      providerSeasonCount: 2,
    };
    const result = investigateIncompleteCatalog({
      hasTmdbId: true,
      healthRiskFlags: ['NEXT_EPISODE_INCONSISTENT'],
      localSeasonCount: 2,
      providerComparison: outcome,
    });
    expect(result.issueClassification).toBe('LIKELY_ALREADY_COMPLETE_BUT_UNTRUSTED');
    expect(result.recommendedNextAction).toBe('RUN_TARGETED_TMDB_REFRESH_DRY_RUN');
    expect(result.reason).toMatch(/nextEpisodeId does not match/);
  });
});

describe('investigateIncompleteCatalog — reason text incorporates health risk flags', () => {
  it('mentions NO_LOCAL_EPISODES in the reason', () => {
    const result = investigateIncompleteCatalog({ hasTmdbId: false, healthRiskFlags: ['NO_LOCAL_EPISODES'], localSeasonCount: 0, providerComparison: null });
    expect(result.reason).toMatch(/no local episodes/);
  });

  it('mentions MOSTLY_UNENRICHED_EPISODES in the reason', () => {
    const result = investigateIncompleteCatalog({ hasTmdbId: false, healthRiskFlags: ['MOSTLY_UNENRICHED_EPISODES'], localSeasonCount: 1, providerComparison: null });
    expect(result.reason).toMatch(/unenriched TV Time import/);
  });

  it('falls back to a generic reason when no specific health risk flag is recognized', () => {
    const result = investigateIncompleteCatalog({ hasTmdbId: false, healthRiskFlags: [], localSeasonCount: 1, providerComparison: null });
    expect(result.reason).toMatch(/flagged by the Library Health report/);
  });
});
