// Pure decision logic for Phase 1 apply's ONLY write operation: which new
// Episode rows to insert, and which Season rows must exist first. No I/O —
// takes compareSeriesCatalog's already-computed output (reused unchanged,
// per docs/episode-release-refresh-strategy.md) and turns it into a
// concrete, minimal create plan. Never touches an existing row: everything
// here is additive-only by construction.

import { NewEpisodeFound, ProviderEpisodeInput, RefreshClassification } from './refresh-logic';

export interface EpisodeInsertCandidate {
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  overview: string | null;
  airDate: Date | null;
  imageUrl: string | null;
  runtimeMinutes: number | null;
}

export interface EpisodeInsertPlan {
  episodesToInsert: EpisodeInsertCandidate[];
  seasonNumbersToCreate: number[];
}

export interface BuildEpisodeInsertPlanInput {
  classification: RefreshClassification;
  newEpisodes: NewEpisodeFound[];
  providerEpisodes: ProviderEpisodeInput[];
  localSeasonNumbers: number[];
}

function episodeKey(seasonNumber: number, episodeNumber: number): string {
  return `${seasonNumber}:${episodeNumber}`;
}

// Computes the actual episode/season candidate data for insertion — filtered
// to released-only — from a newEpisodes/providerEpisodes diff, independent
// of any RefreshClassification gate. Exported (not just used internally) so
// a second caller with its own safety gating can build the same candidate
// data without going through episode-release-refresh's classification enum
// at all: library-health's catalog-reconciliation pipeline uses this
// directly, gated by its own migration-policy-logic.ts checks (title/year
// identity, real-season-shrink) instead of RefreshClassification, since
// "belongs to Pipeline A, not Pipeline B" is exactly the case
// SUSPICIOUS_BULK_INSERT flags — see docs/stable-version-migration-todo.md.
// buildEpisodeInsertPlan below still gates this behind
// classification === NEW_RELEASE_AVAILABLE for its own (Pipeline B) callers;
// this function itself performs no gating of its own — a caller is always
// responsible for having already decided it's safe to call it.
export function buildEpisodeInsertCandidates(input: Omit<BuildEpisodeInsertPlanInput, 'classification'>): EpisodeInsertPlan {
  const providerByKey = new Map<string, ProviderEpisodeInput>();
  for (const ep of input.providerEpisodes) {
    providerByKey.set(episodeKey(ep.seasonNumber, ep.episodeNumber), ep);
  }

  const episodesToInsert: EpisodeInsertCandidate[] = input.newEpisodes
    .filter((ep) => ep.released)
    .map((ep) => {
      const full = providerByKey.get(episodeKey(ep.seasonNumber, ep.episodeNumber));
      return {
        seasonNumber: ep.seasonNumber,
        episodeNumber: ep.episodeNumber,
        title: full?.title ?? ep.title,
        overview: full?.overview ?? null,
        airDate: ep.airDate,
        imageUrl: full?.imageUrl ?? null,
        runtimeMinutes: full?.runtimeMinutes ?? null,
      };
    });

  const localSeasonSet = new Set(input.localSeasonNumbers);
  const seasonNumbersToCreate = [...new Set(episodesToInsert.map((ep) => ep.seasonNumber).filter((n) => !localSeasonSet.has(n)))].sort((a, b) => a - b);

  return { episodesToInsert, seasonNumbersToCreate };
}

// The one place Phase 1's "never write for a risky series" rule is
// enforced in code rather than by caller discipline alone: even if
// newEpisodes is non-empty, any classification other than
// NEW_RELEASE_AVAILABLE (RISKY_DO_NOT_APPLY, NEEDS_MANUAL_REVIEW,
// SUSPICIOUS_BULK_INSERT, FUTURE_ONLY, NO_CHANGE, PROVIDER_ERROR) always
// produces an empty plan.
//
// Only released episodes are planned — a not-yet-aired new episode stays
// deferred to whichever future run is active once it actually airs, so
// Phase 1 never has to reason about placeholder air dates going stale.
//
// newEpisodes (from compareSeriesCatalog) carries only the fields its
// report needs (season/episode number, title, airDate, released) — full
// episode data for the actual insert is looked up from providerEpisodes,
// the same already-fetched list compareSeriesCatalog was given, so this
// file never re-derives "what's new" itself (that stays compareSeriesCatalog's
// job alone) and can't drift from it.
export function buildEpisodeInsertPlan(input: BuildEpisodeInsertPlanInput): EpisodeInsertPlan {
  if (input.classification !== 'NEW_RELEASE_AVAILABLE') {
    return { episodesToInsert: [], seasonNumbersToCreate: [] };
  }
  return buildEpisodeInsertCandidates(input);
}

export interface EpisodeInsertCountPreview {
  episodeCount: number;
  seasonNumbers: number[];
}

// Report-only: what buildEpisodeInsertPlan WOULD have proposed, regardless
// of classification — used to show a truthful "proposed released insert
// count" / "proposed new season count" for a series the safety gate
// blocked (e.g. SUSPICIOUS_BULK_INSERT), instead of the misleading zero
// buildEpisodeInsertPlan correctly returns for anything actually writable.
// Deliberately returns only counts/numbers, never the full episode data
// buildEpisodeInsertPlan returns, so this can never be mistaken for
// something safe to pass to an insert.
export function previewEpisodeInsertCounts(input: Omit<BuildEpisodeInsertPlanInput, 'classification'>): EpisodeInsertCountPreview {
  const preview = buildEpisodeInsertCandidates(input);
  return { episodeCount: preview.episodesToInsert.length, seasonNumbers: preview.seasonNumbersToCreate };
}
