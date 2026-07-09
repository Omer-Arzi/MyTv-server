import {
  EPISODE_NUMBERING_RISK_LIST_TITLES,
  isUntrustedNextEpisodeTitle,
  KNOWN_SEASON_SHIFT_ORPHAN_TITLES,
  PROVIDER_STRUCTURE_MISMATCH_TITLES,
} from '../stale-series-trust';

describe('isUntrustedNextEpisodeTitle', () => {
  it.each(EPISODE_NUMBERING_RISK_LIST_TITLES)('flags manually-curated risk-list title "%s"', (title) => {
    expect(isUntrustedNextEpisodeTitle(title)).toBe(true);
  });

  it.each(KNOWN_SEASON_SHIFT_ORPHAN_TITLES)('flags known season-shift-orphan title "%s"', (title) => {
    expect(isUntrustedNextEpisodeTitle(title)).toBe(true);
  });

  // These were found automatically by a live TMDb structural comparison —
  // either episode-release-refresh's dry-run season-shift guard, or
  // library-health/incomplete-catalog-investigation.ts's targeted per-series
  // check (docs/episode-numbering-and-season-shift-risk.md's "Newly detected
  // by episode-release-refresh dry run" and "Detected by incomplete-catalog
  // investigation" sections) — not manually declared beforehand, unlike the
  // two lists above.
  it.each(PROVIDER_STRUCTURE_MISMATCH_TITLES)('flags newly-detected provider-structure-mismatch title "%s"', (title) => {
    expect(isUntrustedNextEpisodeTitle(title)).toBe(true);
  });

  it('lists exactly the ten newly detected provider-structure-mismatch titles', () => {
    expect(PROVIDER_STRUCTURE_MISMATCH_TITLES).toEqual([
      'Kaiju No. 8',
      'DAN DA DAN',
      'Shangri-La Frontier',
      "Frieren: Beyond Journey's End",
      'Sket Dance',
      'Tokyo Revengers',
      'Dragon Ball GT',
      'The Seven Deadly Sins: Four Knights of the Apocalypse',
      'Seraph of the End',
      'Tales of Zestiria the X',
    ]);
  });

  it('does not flag Superstore — a specials/season-0 mismatch, deliberately not risk-listed (see docs)', () => {
    expect(isUntrustedNextEpisodeTitle('Superstore')).toBe(false);
  });

  it('does not flag an ordinary, unrelated title', () => {
    expect(isUntrustedNextEpisodeTitle('The Bear')).toBe(false);
  });

  it('is exact-match, not case-insensitive (deliberate — see EPISODE_NUMBERING_RISK_LIST_TITLES\'s separate cased entries)', () => {
    expect(isUntrustedNextEpisodeTitle('kaiju no. 8')).toBe(false);
  });
});
