// Pure, dry-run-only data-quality detectors surfaced by the --limit=50
// inspection (see docs/tmdb-matching-tuning-notes.md): TV Time export
// artifacts and title collisions that no amount of scoring-threshold tuning
// can fix, because the problem is upstream of TMDb matching entirely. These
// only ever produce report entries / ImportIssue rows — nothing here
// deletes or modifies a Series.

import { normalizeTitle } from '../trakt-enrichment/scoring';
import { CloseCompetitorKind, extractTitleYearHint } from './scoring';

export type DataQualityIssueType = 'PLACEHOLDER_TITLE' | 'REMAKE_COLLISION' | 'DUPLICATE_TITLE_DIFFERENT_YEAR_SUFFIX';

export interface DataQualityIssue {
  type: DataQualityIssueType;
  message: string;
}

// Conservative on purpose: only flags titles that are themselves
// error/placeholder strings (e.g. TV Time's "***Movies are not allowed***"),
// not just unusual titles. False negatives here are fine — a missed
// placeholder still shows up as NO_MATCH or a bad match downstream; false
// positives would be worse, since they'd wrongly flag a real show title.
const PLACEHOLDER_TITLE_PATTERN = /^\*+.+\*+$/;

export function detectPlaceholderTitle(title: string): DataQualityIssue | null {
  if (PLACEHOLDER_TITLE_PATTERN.test(title.trim())) {
    return {
      type: 'PLACEHOLDER_TITLE',
      message: `"${title}" looks like a placeholder/error string from the TV Time export, not a real series title — review before ever matching or importing it`,
    };
  }
  return null;
}

export interface RemakeCollisionInput {
  mytvSeriesTitle: string;
  chosenTmdbTitle: string;
  chosenTmdbYear: number | null;
  watchedEpisodeCount: number;
  tmdbTotalEpisodeCount: number;
  animeNumberingRiskDetected: boolean;
  closeCompetitorKind: CloseCompetitorKind | null;
}

// A meaningfully-over-watched episode count (not just off-by-one, which is
// usually a special/OVA or TMDb lagging a newly-aired episode) combined with
// an exact-title match is the signature of a remake/reboot collision — the
// title matched, but to the wrong entry, because MyTv had no year to
// disambiguate with. animeNumberingRiskDetected is excluded here because
// that's a *different*, already-explained cause (absolute vs season
// numbering), not a title collision. Also fires on the direct signal from
// detectCloseCompetitor when it actually found a same-title/different-year
// candidate in the search results.
const REMAKE_COLLISION_OVERWATCH_RATIO = 1.3;

export function detectRemakeCollision(input: RemakeCollisionInput): DataQualityIssue | null {
  const meaningfullyOverWatched =
    input.tmdbTotalEpisodeCount > 0 &&
    input.watchedEpisodeCount > input.tmdbTotalEpisodeCount * REMAKE_COLLISION_OVERWATCH_RATIO &&
    !input.animeNumberingRiskDetected;

  const sameTitleDifferentYearCompetitor = input.closeCompetitorKind === 'same_title_different_year';

  if (!meaningfullyOverWatched && !sameTitleDifferentYearCompetitor) return null;

  const yearLabel = input.chosenTmdbYear ?? 'unknown year';
  return {
    type: 'REMAKE_COLLISION',
    message:
      `"${input.mytvSeriesTitle}" matched TMDb's "${input.chosenTmdbTitle}" (${yearLabel}), which has ${input.tmdbTotalEpisodeCount} known episodes, ` +
      `but MyTv shows ${input.watchedEpisodeCount} watched episodes` +
      (sameTitleDifferentYearCompetitor ? ' — a same-titled candidate with a different year was also in the search results' : '') +
      ' — likely a remake/reboot mismatch, not a numbering-convention difference. Do not auto-apply; review manually.',
  };
}

export interface DuplicateTitleGroup {
  normalizedTitle: string;
  members: Array<{ id: string; title: string }>;
}

// Cross-series check (not per-series like the two detectors above): finds
// MyTv Series rows that share the same bare title (year suffix stripped)
// but differ on the suffix itself — e.g. "Avatar: The Last Airbender" and
// "Avatar: The Last Airbender (2021)" as two separate Series rows. This is
// exactly the shape that produced the Avatar mismatch in the --limit=50
// report: one entry's (wrong) year hint filtered TMDb's search down to zero
// results, while the other, year-less entry matched the wrong same-titled
// show. Flags the group; does not merge or delete either row.
export function detectDuplicateTitleGroups(seriesList: Array<{ id: string; title: string }>): DuplicateTitleGroup[] {
  const groups = new Map<string, Array<{ id: string; title: string }>>();

  for (const s of seriesList) {
    const key = normalizeTitle(extractTitleYearHint(s.title).bareTitle);
    const members = groups.get(key) ?? [];
    members.push(s);
    groups.set(key, members);
  }

  return Array.from(groups.entries())
    .filter(([, members]) => members.length > 1)
    .map(([normalizedTitle, members]) => ({ normalizedTitle, members }));
}
