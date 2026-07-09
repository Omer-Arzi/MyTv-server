// Pure logic for detecting a CONFIRMED tail-only split/merged-episode
// numbering difference. No I/O.
//
// Distinguishes "local numbering has extra trailing episodes in one or more
// real (non-zero) seasons because the import source and the provider use
// different split-vs-merged conventions for double-length episodes" (see
// The Office (US) S4/S6/S7 investigation: local numbering splits each
// aired double-length hour into two parts, TMDb merges each into one) from
// genuine provider-structure risk: a mid-season gap/scatter, or a provider
// episode with no local counterpart at all (real missing content, not a
// numbering-convention difference).
//
// Confirmed real case this SHOULD catch: The Office (US) — season 4 has
// local episodes 1-19 vs. TMDb's 1-14 (5 trailing local-only episodes),
// season 6 has local 1-26 vs. TMDb's 1-24 (2 trailing), season 7 has local
// 1-26 vs. TMDb's 1-24 (2 trailing) — every TMDb episode in each of these
// seasons has a local counterpart, and every orphan sits strictly after
// TMDb's last episode number in that season.
//
// Confirmed real case this must NOT catch: any series where an orphaned
// watched episode falls at or before the provider's last episode number in
// a season (a real gap, not a clean tail) or where a provider episode has
// no local counterpart at all.

import { isUntrustedNextEpisodeTitle } from '../src/common/stale-series-trust';
import { EpisodeSeasonPosition, OrphanedWatchedEpisode } from './season-zero-orphan-logic';

export interface SplitEpisodeTailCheckInput {
  localTitle: string;
  localEpisodes: EpisodeSeasonPosition[];
  providerEpisodes: EpisodeSeasonPosition[];
  orphanedWatchedEpisodes: OrphanedWatchedEpisode[];
}

export interface SplitEpisodeTailSeasonSummary {
  seasonNumber: number;
  providerEpisodeCount: number;
  localEpisodeCount: number;
  tailOrphanEpisodeNumbers: number[];
}

export interface SplitEpisodeTailCheckResult {
  isSplitEpisodeTailOnly: boolean;
  affectedSeasons: SplitEpisodeTailSeasonSummary[];
  // Every real-season orphaned watched episode that must be PRESERVED
  // as-is (no delete, no renumber, no overwrite) by any future apply step —
  // only ever non-empty when isSplitEpisodeTailOnly is true.
  tailOrphanedEpisodes: OrphanedWatchedEpisode[];
  reason: string;
}

function emptyResult(reason: string): SplitEpisodeTailCheckResult {
  return { isSplitEpisodeTailOnly: false, affectedSeasons: [], tailOrphanedEpisodes: [], reason };
}

export function checkSplitEpisodeTailOnly(input: SplitEpisodeTailCheckInput): SplitEpisodeTailCheckResult {
  const realOrphans = input.orphanedWatchedEpisodes.filter((e) => e.seasonNumber !== 0);

  if (isUntrustedNextEpisodeTitle(input.localTitle)) {
    return emptyResult(`"${input.localTitle}" is on an existing provider-structure risk list — never treated as a benign tail regardless of pattern.`);
  }

  if (realOrphans.length === 0) {
    return emptyResult('no orphaned watched episodes in real (non-zero) seasons — nothing to classify as a split-episode tail.');
  }

  // A provider episode with no local counterpart at all is real missing
  // content, not a numbering-convention difference — disqualifies the
  // whole series, not just the affected season, since it means the
  // provider catalog itself can't be trusted to be a superset of local.
  const localKeys = new Set(input.localEpisodes.map((e) => `${e.seasonNumber}:${e.episodeNumber}`));
  const unmatchedProviderEpisode = input.providerEpisodes.find((e) => e.seasonNumber !== 0 && !localKeys.has(`${e.seasonNumber}:${e.episodeNumber}`));
  if (unmatchedProviderEpisode) {
    return emptyResult(
      `provider episode S${unmatchedProviderEpisode.seasonNumber}E${unmatchedProviderEpisode.episodeNumber} has no local counterpart — real missing content, not a numbering difference.`,
    );
  }

  const providerMaxBySeason = new Map<number, number>();
  const providerCountBySeason = new Map<number, number>();
  for (const e of input.providerEpisodes) {
    if (e.seasonNumber === 0) continue;
    providerMaxBySeason.set(e.seasonNumber, Math.max(providerMaxBySeason.get(e.seasonNumber) ?? 0, e.episodeNumber));
    providerCountBySeason.set(e.seasonNumber, (providerCountBySeason.get(e.seasonNumber) ?? 0) + 1);
  }
  const localCountBySeason = new Map<number, number>();
  for (const e of input.localEpisodes) {
    if (e.seasonNumber === 0) continue;
    localCountBySeason.set(e.seasonNumber, (localCountBySeason.get(e.seasonNumber) ?? 0) + 1);
  }

  const orphansBySeason = new Map<number, OrphanedWatchedEpisode[]>();
  for (const o of realOrphans) {
    const list = orphansBySeason.get(o.seasonNumber) ?? [];
    list.push(o);
    orphansBySeason.set(o.seasonNumber, list);
  }

  const affectedSeasons: SplitEpisodeTailSeasonSummary[] = [];
  for (const [seasonNumber, orphans] of orphansBySeason) {
    const providerMax = providerMaxBySeason.get(seasonNumber) ?? 0;
    const midSeasonOrphan = orphans.find((o) => o.episodeNumber <= providerMax);
    if (midSeasonOrphan) {
      return emptyResult(
        `season ${seasonNumber} has an orphaned watched episode (S${seasonNumber}E${midSeasonOrphan.episodeNumber}) at or before the provider's last episode (E${providerMax}) in that season — a real gap, not a clean tail.`,
      );
    }
    affectedSeasons.push({
      seasonNumber,
      providerEpisodeCount: providerCountBySeason.get(seasonNumber) ?? 0,
      localEpisodeCount: localCountBySeason.get(seasonNumber) ?? 0,
      tailOrphanEpisodeNumbers: orphans.map((o) => o.episodeNumber).sort((a, b) => a - b),
    });
  }

  affectedSeasons.sort((a, b) => a.seasonNumber - b.seasonNumber);

  return {
    isSplitEpisodeTailOnly: true,
    affectedSeasons,
    tailOrphanedEpisodes: realOrphans,
    reason: `${realOrphans.length} orphaned watched episode(s) across ${affectedSeasons.length} season(s) are all trailing-tail episodes past the provider's last episode number in that season, every provider episode has a local counterpart, and the title carries no known risk — consistent with a split/merged double-length-episode numbering difference, not real content loss.`,
  };
}
