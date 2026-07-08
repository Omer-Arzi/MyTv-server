// Pure logic for detecting a BENIGN local season-0 orphan pattern. No I/O.
//
// Distinguishes "this series has a small number of watched season-0
// special episode(s) that the provider catalog doesn't track" (harmless,
// common — e.g. a bonus/pilot webisode TV Time imported that TMDb/TVmaze
// never catalogued) from genuine provider-structure risk: a real season
// shrinking or disappearing, multiple orphaned watches sitting in real
// seasons, or a title already known to be risky.
//
// Confirmed real cases this SHOULD catch (all blocked by
// provider-confirmation-decisions-logic.ts or
// library-health/incomplete-catalog-investigation.ts for exactly this
// reason before this module existed): The Big Bang Theory, Modern Family,
// How I Met Your Mother, The Flash (2014), Superstore.
//
// Confirmed real case this must NOT catch: The Office (US), whose seasons
// 4, 6, and 7 each genuinely shrank on the provider side, orphaning 9
// watched episodes across real (non-zero) seasons — that stays blocked.

import { isUntrustedNextEpisodeTitle } from '../src/common/stale-series-trust';

export interface EpisodeSeasonPosition {
  seasonNumber: number;
  episodeNumber: number;
}

export interface OrphanedWatchedEpisode extends EpisodeSeasonPosition {
  id: string;
}

// A season OTHER than season 0 shrinking or disappearing entirely relative
// to the provider is real structural risk — season 0 is deliberately
// excluded here, since separating it out from that risk is this module's
// whole purpose.
export function detectRealSeasonShrink(localEpisodes: EpisodeSeasonPosition[], providerEpisodes: EpisodeSeasonPosition[]): boolean {
  const localCounts = new Map<number, number>();
  for (const e of localEpisodes) {
    if (e.seasonNumber === 0) continue;
    localCounts.set(e.seasonNumber, (localCounts.get(e.seasonNumber) ?? 0) + 1);
  }
  const providerCounts = new Map<number, number>();
  for (const e of providerEpisodes) {
    if (e.seasonNumber === 0) continue;
    providerCounts.set(e.seasonNumber, (providerCounts.get(e.seasonNumber) ?? 0) + 1);
  }
  for (const [seasonNumber, localCount] of localCounts) {
    if ((providerCounts.get(seasonNumber) ?? 0) < localCount) return true;
  }
  return false;
}

// Every locally-watched episode with no matching (seasonNumber,
// episodeNumber) slot in the provider's catalog — the same key-based
// matching episode-release-refresh/refresh-logic.ts's compareSeriesCatalog
// uses internally, recomputed here directly (rather than string-parsed out
// of its warnings) so this module's input is fully structured and testable.
export function findOrphanedWatchedEpisodes(
  localEpisodes: Array<EpisodeSeasonPosition & { id: string; watched: boolean }>,
  providerEpisodes: EpisodeSeasonPosition[],
): OrphanedWatchedEpisode[] {
  const providerKeys = new Set(providerEpisodes.map((e) => `${e.seasonNumber}:${e.episodeNumber}`));
  return localEpisodes
    .filter((e) => e.watched && !providerKeys.has(`${e.seasonNumber}:${e.episodeNumber}`))
    .map((e) => ({ id: e.id, seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber }));
}

export interface SeasonZeroOrphanCheckInput {
  localTitle: string;
  orphanedWatchedEpisodes: OrphanedWatchedEpisode[];
  realSeasonShrinkDetected: boolean;
  // Configurable per the task's "small, e.g. <= 1 or configurable" —
  // defaults to 1 (a single bonus/pilot special is the common case; two or
  // more starts to look less like an isolated import artifact).
  maxOrphanCount?: number;
}

export interface SeasonZeroOrphanCheckResult {
  isBenignSeasonZeroOrphan: boolean;
  orphanSeasonZeroEpisodeCount: number;
  orphanSeasonZeroEpisodes: OrphanedWatchedEpisode[];
  realSeasonShapeMatchesProvider: boolean;
  reason: string;
}

const DEFAULT_MAX_SEASON_ZERO_ORPHAN_COUNT = 1;

export function checkBenignSeasonZeroOrphan(input: SeasonZeroOrphanCheckInput): SeasonZeroOrphanCheckResult {
  const maxOrphanCount = input.maxOrphanCount ?? DEFAULT_MAX_SEASON_ZERO_ORPHAN_COUNT;
  const seasonZeroOrphans = input.orphanedWatchedEpisodes.filter((e) => e.seasonNumber === 0);
  const realSeasonOrphans = input.orphanedWatchedEpisodes.filter((e) => e.seasonNumber !== 0);
  const realSeasonShapeMatchesProvider = !input.realSeasonShrinkDetected;

  const base = {
    orphanSeasonZeroEpisodeCount: seasonZeroOrphans.length,
    orphanSeasonZeroEpisodes: seasonZeroOrphans,
    realSeasonShapeMatchesProvider,
  };

  // Checked first and independently of every other signal — a risk-listed
  // title is never treated as benign, full stop.
  if (isUntrustedNextEpisodeTitle(input.localTitle)) {
    return {
      ...base,
      isBenignSeasonZeroOrphan: false,
      reason: `"${input.localTitle}" is on an existing provider-structure risk list — never treated as a benign orphan regardless of pattern.`,
    };
  }
  if (input.realSeasonShrinkDetected) {
    return {
      ...base,
      isBenignSeasonZeroOrphan: false,
      reason: 'a real (non-zero) season shrank or disappeared relative to the provider — not a benign season-0-only pattern.',
    };
  }
  if (realSeasonOrphans.length > 0) {
    return {
      ...base,
      isBenignSeasonZeroOrphan: false,
      reason: `${realSeasonOrphans.length} orphaned watched episode(s) are in real (non-zero) seasons — not benign.`,
    };
  }
  if (seasonZeroOrphans.length === 0) {
    return {
      ...base,
      isBenignSeasonZeroOrphan: false,
      reason: 'no season-0 orphaned watched episodes found — nothing to classify as a benign orphan.',
    };
  }
  if (seasonZeroOrphans.length > maxOrphanCount) {
    return {
      ...base,
      isBenignSeasonZeroOrphan: false,
      reason: `${seasonZeroOrphans.length} season-0 orphaned episode(s) exceeds the configured maximum of ${maxOrphanCount}.`,
    };
  }

  return {
    ...base,
    isBenignSeasonZeroOrphan: true,
    reason: `all ${seasonZeroOrphans.length} orphaned watched episode(s) are in season 0 (specials), every real season matches the provider, and the title carries no known risk — safe to treat as a benign local-only special.`,
  };
}
