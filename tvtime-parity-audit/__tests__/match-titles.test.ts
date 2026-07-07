import { findMatchesForTitle, DbSeriesForMatching } from '../match-titles';

function series(id: string, title: string): DbSeriesForMatching {
  return { id, title };
}

describe('findMatchesForTitle', () => {
  it('finds an exact match', () => {
    const matches = findMatchesForTitle(['One Piece'], [series('1', 'One Piece'), series('2', 'Other Show')]);
    expect(matches).toHaveLength(1);
    expect(matches[0].series.id).toBe('1');
    expect(matches[0].matchKind).toBe('exact');
  });

  it('finds a normalized (case-insensitive) match', () => {
    const matches = findMatchesForTitle(['Black Torch'], [series('1', 'BLACK TORCH')]);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchKind).toBe('normalized');
  });

  it('finds a cosmetic match (en-dash vs hyphen)', () => {
    const matches = findMatchesForTitle(['Star Wars: Maul – Shadow Lord'], [series('1', 'Star Wars: Maul - Shadow Lord')]);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchKind).toBe('cosmetic');
  });

  it('finds a cosmetic match for an apostrophe difference', () => {
    const matches = findMatchesForTitle(["X-Men '97"], [series('1', 'X-Men 97')]);
    expect(matches).toHaveLength(1);
  });

  it('matches against any alias in the search terms list', () => {
    const matches = findMatchesForTitle(['InuYasha', 'Inuyasha', 'InuYasha: The Final Act'], [series('1', 'InuYasha: The Final Act')]);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchedAgainst).toBe('InuYasha: The Final Act');
  });

  it('returns multiple matches when more than one series corresponds to the title/aliases', () => {
    const matches = findMatchesForTitle(
      ['One Piece', 'ONE PIECE (2023)'],
      [series('1', 'One Piece'), series('2', 'ONE PIECE (2023)'), series('3', 'Unrelated Show')],
    );
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.series.id).sort()).toEqual(['1', '2']);
  });

  it('falls back to substring matching only when no stricter match exists', () => {
    const matches = findMatchesForTitle(['InuYasha'], [series('1', 'InuYasha: The Final Act')]);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchKind).toBe('substring');
  });

  it('does not fall back to substring matching when a stricter match already exists', () => {
    const matches = findMatchesForTitle(
      ['InuYasha'],
      [series('1', 'InuYasha'), series('2', 'InuYasha: The Final Act')],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].series.id).toBe('1');
    expect(matches[0].matchKind).toBe('exact');
  });

  it('returns an empty array when nothing matches at all', () => {
    const matches = findMatchesForTitle(['Totally Unrelated Title'], [series('1', 'Something Else')]);
    expect(matches).toEqual([]);
  });
});
