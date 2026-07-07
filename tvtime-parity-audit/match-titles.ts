// Pure title-matching logic for the TV Time parity audit. No I/O —
// testable without a database. Reuses normalizeTitle from
// trakt-enrichment/scoring.ts (provider-agnostic, already used by every
// other matching module in this repo) rather than duplicating it.

import { normalizeTitle } from '../trakt-enrichment/scoring';

export interface DbSeriesForMatching {
  id: string;
  title: string;
}

export type MatchKind = 'exact' | 'normalized' | 'cosmetic' | 'substring';

export interface TitleMatch {
  series: DbSeriesForMatching;
  matchKind: MatchKind;
  matchedAgainst: string; // which of the target title / aliases produced the match
}

// Strips punctuation/dashes/apostrophes and all whitespace on top of
// normalizeTitle — the same "cosmetic-only differences" idea used by
// secondary-provider-audit/tvmaze-scoring.ts's scoreTitle fix (e.g.
// "Star Wars: Maul – Shadow Lord" vs "Star Wars: Maul - Shadow Lord", an
// en-dash vs a hyphen). Deliberately its own function, not shared with the
// TVmaze scorer, so this audit's matching can't silently drift if that
// scorer's rules ever change for unrelated reasons.
function normalizeCosmetic(title: string): string {
  return normalizeTitle(title)
    .replace(/['’‘´`]/g, '')
    .replace(/[:\-–—.,!?]/g, '')
    .replace(/\s+/g, '');
}

// Finds every current DB series that could plausibly correspond to one TV
// Time title (the primary title plus any known aliases). Returns ALL
// matches, not just the first — ambiguity (multiple matches) is exactly one
// of the things this audit needs to surface (TITLE_MISMATCH), not hide.
export function findMatchesForTitle(searchTerms: string[], series: DbSeriesForMatching[]): TitleMatch[] {
  const matches: TitleMatch[] = [];
  const matchedSeriesIds = new Set<string>();

  for (const term of searchTerms) {
    const exactTerm = term;
    const normalizedTerm = normalizeTitle(term);
    const cosmeticTerm = normalizeCosmetic(term);

    for (const s of series) {
      if (matchedSeriesIds.has(s.id)) continue;

      if (s.title === exactTerm) {
        matches.push({ series: s, matchKind: 'exact', matchedAgainst: term });
        matchedSeriesIds.add(s.id);
        continue;
      }
      if (normalizeTitle(s.title) === normalizedTerm) {
        matches.push({ series: s, matchKind: 'normalized', matchedAgainst: term });
        matchedSeriesIds.add(s.id);
        continue;
      }
      if (normalizeCosmetic(s.title) === cosmeticTerm) {
        matches.push({ series: s, matchKind: 'cosmetic', matchedAgainst: term });
        matchedSeriesIds.add(s.id);
        continue;
      }
    }
  }

  // Substring pass runs only if nothing matched yet at a stricter level —
  // e.g. "InuYasha" as a prefix of "InuYasha: The Final Act". Deliberately
  // last and lowest-priority: substring matching alone is prone to false
  // positives (see the earlier "Man Hunt"/"Manhunt" caveat from the TVmaze
  // scoring work), so it's only trusted once exact/normalized/cosmetic have
  // all failed to find anything at all.
  if (matches.length === 0) {
    for (const term of searchTerms) {
      const normalizedTerm = normalizeTitle(term);
      for (const s of series) {
        if (matchedSeriesIds.has(s.id)) continue;
        const normalizedSeriesTitle = normalizeTitle(s.title);
        if (normalizedSeriesTitle.includes(normalizedTerm) || normalizedTerm.includes(normalizedSeriesTitle)) {
          matches.push({ series: s, matchKind: 'substring', matchedAgainst: term });
          matchedSeriesIds.add(s.id);
        }
      }
    }
  }

  return matches;
}
