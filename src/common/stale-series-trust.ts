// Series titles whose next-episode/catalog mapping should not be trusted
// for recommending as "stale and ready to watch" yet. Kept as explicit,
// documented arrays (not derived from audit artifacts at request time) so a
// live request handler never has to read files off disk — see
// docs/episode-numbering-and-season-shift-risk.md for the underlying
// investigation behind both lists.

// Single source of truth for "haven't watched for a while," reused by
// StaleSeriesQueryDto's default, HomeService, and MeService.getWatchNext's
// exclusion of stale candidates — so the threshold that makes a series
// "stale" can never drift between the endpoints that need to agree on it.
export const DEFAULT_STALE_AFTER_DAYS = 90;

// §5's explicit "do not trust" list — provider match/numbering is unconfirmed.
export const EPISODE_NUMBERING_RISK_LIST_TITLES: string[] = [
  'Jujutsu Kaisen',
  'JUJUTSU KAISEN',
  'Rurouni Kenshin',
  'One Piece',
  'ONE PIECE (2023)',
  'InuYasha',
  "InuYasha: The Final Act",
];

// Confirmed via stale-series-audit/output/stale-series-accuracy-report.json's
// POSSIBLE_SEASON_SHIFT category (2026-07-05): a targeted single-series
// enrichment apply left some existing watched episodes unmatched against
// the provider's numbering, so the provider's "next episode" may actually
// duplicate already-watched content.
export const KNOWN_SEASON_SHIFT_ORPHAN_TITLES: string[] = ['That Time I Got Reincarnated as a Slime', 'Solar Opposites', 'Ascendance of a Bookworm'];

// Detected automatically (not manually curated, unlike the two lists
// above) by episode-release-refresh/refresh-logic.ts's dry-run season-shift
// guard: TMDb's current live catalog *shape* — season count and/or
// per-season episode count — no longer lines up with what MyTv has stored
// locally for these series, and at least one already-watched episode has
// no matching slot in TMDb's response at all. Unlike
// KNOWN_SEASON_SHIFT_ORPHAN_TITLES (confirmed via an actual enrichment
// apply that already ran and left orphaned watches), no apply was ever
// attempted for any of these — this is a pre-apply structural comparison
// only, kept as its own list so each title's provenance/detection method
// stays traceable. See docs/episode-numbering-and-season-shift-risk.md's
// "Newly detected by episode-release-refresh dry run" section for the
// per-title detail (e.g. Kaiju No. 8: 2 local seasons/34 episodes vs.
// TMDb's 1 season/23 episodes).
export const PROVIDER_STRUCTURE_MISMATCH_TITLES: string[] = [
  'Kaiju No. 8',
  'DAN DA DAN',
  'Shangri-La Frontier',
  "Frieren: Beyond Journey's End",
  'Sket Dance',
  'Tokyo Revengers',
];

export function isUntrustedNextEpisodeTitle(title: string): boolean {
  return (
    EPISODE_NUMBERING_RISK_LIST_TITLES.includes(title) ||
    KNOWN_SEASON_SHIFT_ORPHAN_TITLES.includes(title) ||
    PROVIDER_STRUCTURE_MISMATCH_TITLES.includes(title)
  );
}
