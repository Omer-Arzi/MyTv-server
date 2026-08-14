// Pure logic for a deliberately non-generalized, one-shot correction: MyTV's
// "Re: ZERO, Starting Life in Another World" (seriesId
// bc33d4b3-c3fe-4040-b28c-0723adaf1c23) has duplicate Episode rows for the
// same real broadcast episodes -- an actively-synced, TMDb-absolute-numbered
// Season 1 (78 episodes, real titles/dates, growing with every new release)
// alongside a stale, never-enriched legacy Season 2/3/4 (52 blank rows from
// the original TV Time import, using the franchise's real-world per-arc
// season split). Both sides carry real EpisodeWatch rows for the same
// content. See docs/episode-numbering-and-season-shift-risk.md and the
// architecture plan for the full investigation.
//
// This is NOT a reusable classifier -- same posture as
// manual-progress-corrections/: a hand-verified, single-series plan. The
// legacy-season -> Season-1-absolute-episode-number offset below was
// confirmed by matching EpisodeWatch.watchedAt timestamps across both
// representations (not guessed, not derived from tmdbEpisodeId, since the
// legacy rows have none): legacy Season 2's episodes 1-25 and Season 1's
// absolute episodes 26-50 were BOTH watched, with Season 1's side all
// stamped with the exact same batch-reconciliation timestamp
// (2026-07-12T09:33:15.536Z, from the Pipeline A migration that confirmed
// this series onto TMDb id 65942 the same day it set
// ProviderIdentityDecision.seasonShrinkReviewed=true) -- while the legacy
// side carries the user's real, individually-dated original watch history.
// Same signature repeats exactly for Season 3 (offset 50, absolute 51-66)
// and Season 4 (offset 66, absolute 67-77).
export const REZERO_SERIES_ID = 'bc33d4b3-c3fe-4040-b28c-0723adaf1c23';
export const REZERO_LEGACY_SEASON_OFFSETS: { legacySeasonNumber: number; absoluteOffset: number }[] = [
  { legacySeasonNumber: 2, absoluteOffset: 25 },
  { legacySeasonNumber: 3, absoluteOffset: 50 },
  { legacySeasonNumber: 4, absoluteOffset: 66 },
];

export interface WatchInfo {
  id: string;
  watchedAt: string; // ISO
  rewatchCount: number;
  watchDateApproximate: boolean;
  watchSource: string;
  importBatchId: string | null;
  rawMetadata: unknown;
}

export interface LegacyEpisodeInput {
  id: string;
  seasonId: string;
  seasonNumber: number;
  episodeNumber: number;
  watch: WatchInfo | null;
}

export interface SurvivorEpisodeInput {
  id: string;
  episodeNumber: number; // Season 1's absolute number
  watch: WatchInfo | null;
}

export type EpisodeMergeActionKind = 'move_watch_no_conflict' | 'replace_survivor_watch_with_legacy' | 'delete_legacy_only_no_watch';

export interface EpisodeMergeAction {
  kind: EpisodeMergeActionKind;
  legacyEpisodeId: string;
  legacyLabel: string;
  survivorEpisodeId: string;
  survivorLabel: string;
  legacyWatch: WatchInfo | null;
  survivorWatchToDelete: WatchInfo | null;
}

export interface SeasonRemoval {
  seasonId: string;
  seasonNumber: number;
  legacyEpisodeIds: string[];
}

export interface ReZeroMergePlan {
  actions: EpisodeMergeAction[];
  seasonsToRemove: SeasonRemoval[];
  warnings: string[];
}

function label(seasonNumber: number, episodeNumber: number): string {
  return `S${seasonNumber}E${episodeNumber}`;
}

// Deliberately refuses to proceed (returns warnings only, empty
// actions/seasonsToRemove) rather than partially merging, if the live data
// doesn't match what this one-off plan expects -- safeguard #8 ("stop on
// unexpected data") from the architecture plan.
export function buildReZeroMergePlan(input: {
  legacyEpisodes: LegacyEpisodeInput[];
  survivorEpisodesByNumber: Map<number, SurvivorEpisodeInput>;
}): ReZeroMergePlan {
  const warnings: string[] = [];
  const actions: EpisodeMergeAction[] = [];
  const seasonsToRemove = new Map<string, SeasonRemoval>();

  for (const legacy of input.legacyEpisodes) {
    const offsetEntry = REZERO_LEGACY_SEASON_OFFSETS.find((o) => o.legacySeasonNumber === legacy.seasonNumber);
    if (!offsetEntry) {
      warnings.push(`legacy episode ${label(legacy.seasonNumber, legacy.episodeNumber)} (id ${legacy.id}) is in an unexpected season (no known offset for season ${legacy.seasonNumber}) -- skipped entirely, not merged`);
      continue;
    }
    const survivorNumber = legacy.episodeNumber + offsetEntry.absoluteOffset;
    const survivor = input.survivorEpisodesByNumber.get(survivorNumber);
    if (!survivor) {
      warnings.push(`legacy episode ${label(legacy.seasonNumber, legacy.episodeNumber)} (id ${legacy.id}) has no Season 1 counterpart at absolute episode ${survivorNumber} -- skipped entirely, not merged`);
      continue;
    }

    const survivorLabel = label(1, survivor.episodeNumber);
    const legacyLabel = label(legacy.seasonNumber, legacy.episodeNumber);

    let kind: EpisodeMergeActionKind;
    if (legacy.watch && survivor.watch) {
      kind = 'replace_survivor_watch_with_legacy';
    } else if (legacy.watch && !survivor.watch) {
      kind = 'move_watch_no_conflict';
    } else {
      kind = 'delete_legacy_only_no_watch';
    }

    actions.push({
      kind,
      legacyEpisodeId: legacy.id,
      legacyLabel,
      survivorEpisodeId: survivor.id,
      survivorLabel,
      legacyWatch: legacy.watch,
      survivorWatchToDelete: kind === 'replace_survivor_watch_with_legacy' ? survivor.watch : null,
    });

    const removal = seasonsToRemove.get(legacy.seasonId) ?? { seasonId: legacy.seasonId, seasonNumber: legacy.seasonNumber, legacyEpisodeIds: [] };
    removal.legacyEpisodeIds.push(legacy.id);
    seasonsToRemove.set(legacy.seasonId, removal);
  }

  return { actions, seasonsToRemove: [...seasonsToRemove.values()], warnings };
}
