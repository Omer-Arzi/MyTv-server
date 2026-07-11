import { UserSeriesStatus } from '@prisma/client';
import { filterToOnlySeries } from '../only-series-filter';
import { checkSeriesEligibility } from '../refresh-logic';

interface FakeSeries {
  id: string;
  title: string;
  userStatus: UserSeriesStatus;
  tmdbId: string | null;
}

function series(overrides: Partial<FakeSeries> & Pick<FakeSeries, 'id'>): FakeSeries {
  return { title: `Series ${overrides.id}`, userStatus: UserSeriesStatus.WATCHING, tmdbId: 'tmdb-1', ...overrides };
}

describe('filterToOnlySeries', () => {
  const ALL = [series({ id: 'a' }), series({ id: 'b' }), series({ id: 'c' })];

  it('returns the full candidate list unchanged when no --only id is given', () => {
    const result = filterToOnlySeries(ALL, undefined);
    expect(result).toEqual({ candidateSeries: ALL, found: true });
  });

  // "Only the selected series reaches provider fetch/planning" and
  // "unrelated eligible series receive zero fetches and zero writes" are
  // both true because run-apply-refresh.ts's entire pipeline (eligibility
  // check, TMDb fetch, compareSeriesCatalog, apply) only ever iterates
  // whatever candidateSeries this function returns — proven here as an
  // exact single-element array, not a filtered-but-still-large one.
  it('narrows to exactly the one matching series when --only matches', () => {
    const result = filterToOnlySeries(ALL, 'b');
    expect(result.found).toBe(true);
    expect(result.candidateSeries).toEqual([series({ id: 'b' })]);
    expect(result.candidateSeries).toHaveLength(1);
  });

  // The core safety guarantee: a non-matching id must NEVER fall back to
  // the original list — an empty array is the only acceptable "not found"
  // output, so nothing downstream can accidentally process every eligible
  // series just because the requested one wasn't found.
  it('returns an empty candidate list — never the full set — when the id does not match any series', () => {
    const result = filterToOnlySeries(ALL, 'does-not-exist');
    expect(result).toEqual({ candidateSeries: [], found: false });
    expect(result.candidateSeries).not.toBe(ALL);
    expect(result.candidateSeries.length).toBe(0);
  });

  it('returns an empty candidate list when the candidate set itself is empty', () => {
    const result = filterToOnlySeries([], 'anything');
    expect(result).toEqual({ candidateSeries: [], found: false });
  });
});

describe('filterToOnlySeries composed with checkSeriesEligibility (the full pre-fetch decision chain)', () => {
  const ALL = [
    series({ id: 'dropped-series', userStatus: UserSeriesStatus.DROPPED }),
    series({ id: 'watching-series', userStatus: UserSeriesStatus.WATCHING }),
  ];

  // A protected-status series found by --only must still end up with zero
  // downstream processing — found:true, but excluded before any TMDb
  // fetch, exactly like the ordinary (non---only) eligibility loop already
  // does for every other DROPPED/PAUSED/WATCHLIST/UNKNOWN series.
  it('finds a protected-status series but excludes it from the eligible set — zero writes downstream', () => {
    const filtered = filterToOnlySeries(ALL, 'dropped-series');
    expect(filtered.found).toBe(true);
    expect(filtered.candidateSeries).toHaveLength(1);

    const eligibility = checkSeriesEligibility(filtered.candidateSeries[0]);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe('user-status-not-tracked');
  });

  it('finds and passes eligibility for a genuinely trackable series', () => {
    const filtered = filterToOnlySeries(ALL, 'watching-series');
    expect(filtered.found).toBe(true);

    const eligibility = checkSeriesEligibility(filtered.candidateSeries[0]);
    expect(eligibility.eligible).toBe(true);
  });

  it('an invalid id never reaches checkSeriesEligibility at all — the candidate list is empty', () => {
    const filtered = filterToOnlySeries(ALL, 'nonexistent');
    expect(filtered.found).toBe(false);
    expect(filtered.candidateSeries).toEqual([]);
    // Nothing to even call checkSeriesEligibility on — this is the "zero
    // writes for an invalid id" guarantee at the structural level.
  });
});
