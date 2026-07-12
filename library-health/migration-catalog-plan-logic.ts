// Pure logic for Pipeline A's (catalog reconciliation) missing-episode
// creation capability. No I/O.
//
// Confirmed via this task's baseline audit: run-provider-confirmation-pipeline.ts
// currently creates NO Season/Episode rows at all — it only backfills
// metadata on already-matched pairs and preserves orphans untouched. The
// only season/episode-CREATION code in the repository lives in
// episode-release-refresh/build-episode-insert-plan.ts +
// season-episode-writer.ts (Phase 1 / ongoing refresh), gated by
// RefreshClassification and (for large gaps) blocked entirely by
// SUSPICIOUS_BULK_INSERT. This module reuses that exact same
// candidate-building logic (buildEpisodeInsertCandidates — no
// RefreshClassification gate baked in) so a large catalog-completion gap
// has somewhere to actually go: an initial migration pass, gated by
// migration-policy-logic.ts's objective identity/structural checks instead
// of Phase 1's release-refresh-shaped thresholds.

import { NewEpisodeFound, ProviderEpisodeInput } from '../episode-release-refresh/refresh-logic';
import { buildEpisodeInsertCandidates, EpisodeInsertPlan } from '../episode-release-refresh/build-episode-insert-plan';
import { isCanonicalSeason } from '../src/modules/series/series-query-helpers';

// Provenance marker for every Season/Episode row this capability creates.
// Lives here (a pure, side-effect-free module) rather than in
// run-provider-confirmation-pipeline.ts itself — that script runs main()
// at module scope, so importing anything from it (even just a constant)
// would execute the real pipeline as a side effect. Re-exported from the
// script for its own use, so there's still exactly one source of truth.
export const CATALOG_RECONCILIATION_IMPORT_BATCH_ID = 'library-health:provider-confirmation-pipeline:catalog-reconciliation';

export interface BuildMigrationCatalogInsertPlanInput {
  newEpisodes: NewEpisodeFound[];
  providerEpisodes: ProviderEpisodeInput[];
  localSeasonNumbers: number[];
}

// Deliberately no classification gate here — the caller (run-provider-confirmation-pipeline.ts)
// only calls this once migration-policy-logic.ts's evaluateAutoMigrationEligibility
// (or an explicit migrationIntent override) has already said this title is
// safe to write against. Released episodes only, same as Phase 1 — a
// not-yet-aired episode has nothing to "reconcile" yet, it'll appear
// naturally via ongoing refresh once it airs.
export function buildMigrationCatalogInsertPlan(input: BuildMigrationCatalogInsertPlanInput): EpisodeInsertPlan {
  return buildEpisodeInsertCandidates(input);
}

// --- Matched-episode watched/total counts, for resolveObjectiveMigrationStatus ---

export interface MatchedEpisodeCountInput {
  seasonNumber: number;
  episodeNumber: number;
  watched: boolean;
}

export interface ProviderEpisodeKey {
  seasonNumber: number;
  episodeNumber: number;
}

export interface MatchedEpisodeCounts {
  matchedWatchedCount: number;
  matchedTotalCount: number;
}

function episodeKey(seasonNumber: number, episodeNumber: number): string {
  return `${seasonNumber}:${episodeNumber}`;
}

// Counts only LOCAL, CANONICAL-season episodes that have a provider
// counterpart — orphans (watched or not) are intentionally excluded, since
// resolveObjectiveMigrationStatus's whole point is "is the
// provider-recognized portion of the MAIN catalog fully watched,"
// independent of whatever orphans exist alongside it. Season 0
// ("Specials") is excluded the same way (isCanonicalSeason,
// series-query-helpers.ts) — an unwatched Special must never keep a
// migration proposal from deriving COMPLETED/CAUGHT_UP, same product rule
// as every other progress-derivation path in this app.
export function computeMatchedEpisodeCounts(localEpisodes: MatchedEpisodeCountInput[], providerEpisodes: ProviderEpisodeKey[]): MatchedEpisodeCounts {
  const providerKeys = new Set(providerEpisodes.filter((e) => isCanonicalSeason(e.seasonNumber)).map((e) => episodeKey(e.seasonNumber, e.episodeNumber)));
  let matchedTotalCount = 0;
  let matchedWatchedCount = 0;
  for (const ep of localEpisodes) {
    if (!isCanonicalSeason(ep.seasonNumber)) continue;
    if (!providerKeys.has(episodeKey(ep.seasonNumber, ep.episodeNumber))) continue;
    matchedTotalCount += 1;
    if (ep.watched) matchedWatchedCount += 1;
  }
  return { matchedWatchedCount, matchedTotalCount };
}
