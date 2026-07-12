import { UserSeriesStatus } from '@prisma/client';
import { LibrarySnapshotEntry, matchCandidateAgainstLibrary } from '../search-matching-logic';
import { FanoutCandidate } from '../search-provider-fanout';

function candidate(overrides: Partial<FanoutCandidate> = {}): FanoutCandidate {
  return { provider: 'tmdb', providerId: '100', title: 'Frieren', year: 2023, posterUrl: null, ...overrides };
}

function libraryEntry(overrides: Partial<LibrarySnapshotEntry> = {}): LibrarySnapshotEntry {
  return {
    seriesId: 's1',
    title: 'Frieren',
    userStatus: UserSeriesStatus.WATCHING,
    tmdbId: null,
    provider: null,
    providerId: null,
    hasConfirmedProviderMatch: false,
    nextEpisode: null,
    ...overrides,
  };
}

describe('matchCandidateAgainstLibrary', () => {
  it('returns NONE when no library series clears even the BORDERLINE floor — genuinely new series', () => {
    const result = matchCandidateAgainstLibrary(candidate({ title: 'The Bear' }), [libraryEntry({ title: 'Frieren' })]);
    expect(result.type).toBe('NONE');
  });

  it('returns EXACT via a strong tmdbId match, regardless of title spelling drift', () => {
    const result = matchCandidateAgainstLibrary(
      candidate({ provider: 'tmdb', providerId: '100', title: 'Frieren: Beyond Journey\'s End' }),
      [libraryEntry({ title: 'Frieren', tmdbId: '100', hasConfirmedProviderMatch: true, userStatus: UserSeriesStatus.WATCHING })],
    );
    expect(result).toMatchObject({ type: 'EXACT', seriesId: 's1', userStatus: UserSeriesStatus.WATCHING, needsAttention: false });
  });

  it('returns EXACT via a strong tvmaze provider/providerId match', () => {
    const result = matchCandidateAgainstLibrary(
      candidate({ provider: 'tvmaze', providerId: '42', title: 'Frieren' }),
      [libraryEntry({ provider: 'tvmaze', providerId: '42', hasConfirmedProviderMatch: true })],
    );
    expect(result).toMatchObject({ type: 'EXACT', seriesId: 's1' });
  });

  it('flags EXACT + needsAttention when the confirmed series is on the known risk list, even with a strong id match', () => {
    const result = matchCandidateAgainstLibrary(
      candidate({ providerId: '100' }),
      [libraryEntry({ title: 'One Piece', tmdbId: '100', hasConfirmedProviderMatch: true })],
    );
    expect(result).toMatchObject({ type: 'EXACT', needsAttention: true });
  });

  it('treats a HIGH_CONFIDENCE (exact-title) match against an unconfirmed local series as EXACT + needsAttention — Needs Review', () => {
    const result = matchCandidateAgainstLibrary(
      candidate({ title: 'Naruto', providerId: '999' }),
      [libraryEntry({ title: 'Naruto', hasConfirmedProviderMatch: false, userStatus: UserSeriesStatus.WATCHLIST })],
    );
    expect(result).toMatchObject({ type: 'EXACT', seriesId: 's1', needsAttention: true, userStatus: UserSeriesStatus.WATCHLIST });
  });

  it('never treats an EXACT-title-but-unconfirmed match as fully trusted — nextEpisode is always null for the needsAttention path', () => {
    const result = matchCandidateAgainstLibrary(candidate({ title: 'Naruto' }), [libraryEntry({ title: 'Naruto', hasConfirmedProviderMatch: false, nextEpisode: { id: 'e1', seasonNumber: 1, episodeNumber: 1, title: null } })]);
    expect(result).toMatchObject({ type: 'EXACT', nextEpisode: null });
  });

  it('treats a BORDERLINE fuzzy match against an unconfirmed local series as POSSIBLE, not EXACT — title similarity alone is not identity proof', () => {
    const result = matchCandidateAgainstLibrary(
      candidate({ title: 'Fullmetal Alchemist Brotherhood' }),
      [libraryEntry({ title: 'Fullmetal Alchemist', hasConfirmedProviderMatch: false })],
    );
    expect(result.type).toBe('POSSIBLE');
  });

  it('treats a fuzzy match against an ALREADY-confirmed local series (different provider identity) as POSSIBLE, never silently EXACT — reboot/remake caution', () => {
    const result = matchCandidateAgainstLibrary(
      candidate({ provider: 'tvmaze', providerId: '999', title: 'Frieren' }),
      [libraryEntry({ title: 'Frieren', tmdbId: '100', hasConfirmedProviderMatch: true })],
    );
    expect(result.type).toBe('POSSIBLE');
  });

  it('never merges two distinct same-title/different-year local library entries into the wrong one — picks the closer year', () => {
    const result = matchCandidateAgainstLibrary(
      candidate({ title: 'Battlestar Galactica', year: 2004 }),
      [
        libraryEntry({ seriesId: 'old', title: 'Battlestar Galactica', hasConfirmedProviderMatch: false }),
        libraryEntry({ seriesId: 'new', title: 'Battlestar Galactica (2004)', hasConfirmedProviderMatch: false }),
      ],
    );
    expect(result).toMatchObject({ type: 'EXACT', seriesId: 'new' });
  });

  it('user isolation: only ever matches against entries actually present in the provided library snapshot', () => {
    const result = matchCandidateAgainstLibrary(candidate({ title: 'Frieren' }), []);
    expect(result.type).toBe('NONE');
  });
});
