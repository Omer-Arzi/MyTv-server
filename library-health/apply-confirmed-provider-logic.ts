// Pure logic for the general, repeatable "apply every safe, human-confirmed
// provider match" pipeline. No I/O.
//
// This generalizes the backfill-only, never-delete plan shape
// apply-friends-tvmaze-logic.ts pioneered for the single Friends+TVmaze
// case to any confirmed title/provider/providerId — reusing its
// planEpisodeUpdates/planPosterUpdate directly rather than re-implementing
// them, since those two functions were already fully generic (only
// FRIENDS_TARGET and buildFriendsApplyPlan were Friends-specific).
//
// Safety is layered, not just "trust the classification": (1) this module
// is only ever invoked by the orchestration script for a decision a human
// already wrote "confirm" for in provider-confirmation-decisions.json —
// identity confirmation itself is never automated; (2) the caller must
// gate on isSafeApplyClassification before calling buildConfirmedSeriesApplyPlan
// at all; (3) planEpisodeUpdates only ever produces updates for a
// (seasonNumber, episodeNumber) pair that exists on BOTH sides — any local
// episode with no provider counterpart (a season-0 special, a split-episode
// tail orphan) is silently excluded from episodeUpdates, never
// deleted/renumbered, and must be passed through explicitly as
// preservedOrphanEpisodes so a report can say so out loud.

import { EpisodeUpdatePlan, LocalEpisodeForApply, PosterUpdatePlan, planEpisodeUpdates, planPosterUpdate, ProviderEpisodeForApply } from './apply-friends-tvmaze-logic';
import { DryRunClassification, SupportedProvider } from './provider-confirmation-decisions-logic';
import { OrphanedWatchedEpisode } from './season-zero-orphan-logic';

// Which orphan list (if any) must be preserved and reported for a given
// safe classification. SAFE_TO_APPLY_LATER has none by definition (that
// classification only exists when there are zero orphans at all).
// SAFE_WITH_LOCAL_SPECIAL_ORPHAN's orphans are the benign season-0
// specials; SAFE_WITH_SPLIT_EPISODE_TAIL's are the confirmed tail-only
// episodes. Pulled out as its own pure function so the pipeline's
// "which rows get preserved" logic is directly unit-testable, independent
// of the orchestration script's I/O.
export function resolvePreservedOrphanEpisodes(input: {
  classification: DryRunClassification;
  orphanSeasonZeroEpisodes: OrphanedWatchedEpisode[];
  tailOrphanedEpisodes: OrphanedWatchedEpisode[] | null;
}): OrphanedWatchedEpisode[] {
  if (input.classification === 'SAFE_WITH_LOCAL_SPECIAL_ORPHAN') return input.orphanSeasonZeroEpisodes;
  if (input.classification === 'SAFE_WITH_SPLIT_EPISODE_TAIL') return input.tailOrphanedEpisodes ?? [];
  return [];
}

// The ONLY three classifications a fully-automated apply may ever act on.
// Every other classification — BLOCKED_RISK, NEEDS_MANUAL_REVIEW,
// PROVIDER_NOT_FOUND, LOCAL_SERIES_NOT_FOUND, or null (skip/defer/excluded)
// — must never be auto-applied, full stop.
export const SAFE_APPLY_CLASSIFICATIONS: readonly DryRunClassification[] = [
  'SAFE_TO_APPLY_LATER',
  'SAFE_WITH_LOCAL_SPECIAL_ORPHAN',
  'SAFE_WITH_SPLIT_EPISODE_TAIL',
];

export function isSafeApplyClassification(classification: DryRunClassification | null): boolean {
  return classification !== null && (SAFE_APPLY_CLASSIFICATIONS as DryRunClassification[]).includes(classification);
}

// tmdbId is set only when provider === 'tmdb' — mirrors the dedicated,
// uniquely-constrained ExternalIds.tmdbId column that health-logic.ts,
// episode-release-refresh, and the app's series.service.ts all actually
// read (unlike provider/providerId, which only this pipeline's own
// classification logic consumes). undefined (not null) for a TVmaze
// match, so the upsert never touches the column for a provider that has
// no dedicated column of its own — see docs/library-health-provider-confirmation-runbook.md.
export interface ExternalIdsUpdate {
  seriesId: string;
  provider: SupportedProvider;
  providerId: string;
  tmdbId: string | undefined;
}

export interface ConfirmedSeriesApplyPlan {
  seriesId: string;
  title: string;
  provider: SupportedProvider;
  providerId: string;
  externalIdsUpdate: ExternalIdsUpdate;
  posterUpdate: PosterUpdatePlan | null;
  episodeUpdates: EpisodeUpdatePlan[];
  episodeUpdateCount: number;
  // Every orphaned/tail watched episode this plan intentionally leaves
  // untouched. Never appears in episodeUpdates, never deleted, never
  // renumbered, never has its EpisodeWatch rows touched — reported
  // explicitly so nothing silently disappears from view.
  preservedOrphanEpisodes: OrphanedWatchedEpisode[];
  progressUpdate: {
    userId: string;
    seriesId: string;
    userStatus: string;
    nextEpisodeId: string | null;
    lastWatchedAtUnchanged: true;
  };
}

// Detects "there is nothing new here" — the series' ExternalIds already
// points at this exact provider/providerId AND the plan would write
// nothing (no episode field changes, no poster change, no progress
// change). Used by the pipeline to (a) stop reporting an already-applied
// series under the same "safe, pending apply" bucket run after run, and
// (b) skip opening a transaction at all for it, so a repeat run doesn't
// pointlessly rewrite ExternalIds.matchedAt or touch anything else.
//
// Deliberately does NOT skip when there IS real new work (a metadata
// backfill the provider gained since last time, a userStatus/nextEpisode
// change from newly-watched episodes, etc.) — only a true no-op is
// swallowed into "already applied."
export function isNoOpReapply(input: {
  alreadyMatchedProvider: boolean;
  plan: ConfirmedSeriesApplyPlan;
  wouldChangeProgress: boolean;
}): boolean {
  return input.alreadyMatchedProvider && input.plan.episodeUpdateCount === 0 && input.plan.posterUpdate === null && !input.wouldChangeProgress;
}

export function buildConfirmedSeriesApplyPlan(input: {
  seriesId: string;
  title: string;
  provider: SupportedProvider;
  providerId: string;
  userId: string;
  currentPosterUrl: string | null;
  providerPosterUrl: string | null;
  localEpisodes: LocalEpisodeForApply[];
  providerEpisodes: ProviderEpisodeForApply[];
  preservedOrphanEpisodes: OrphanedWatchedEpisode[];
  proposedUserStatus: string;
  proposedNextEpisodeId: string | null;
}): ConfirmedSeriesApplyPlan {
  const episodeUpdates = planEpisodeUpdates(input.localEpisodes, input.providerEpisodes).filter((u) => Object.keys(u.changes).length > 0);

  return {
    seriesId: input.seriesId,
    title: input.title,
    provider: input.provider,
    providerId: input.providerId,
    externalIdsUpdate: { seriesId: input.seriesId, provider: input.provider, providerId: input.providerId, tmdbId: input.provider === 'tmdb' ? input.providerId : undefined },
    posterUpdate: planPosterUpdate(input.currentPosterUrl, input.providerPosterUrl),
    episodeUpdates,
    episodeUpdateCount: episodeUpdates.length,
    preservedOrphanEpisodes: input.preservedOrphanEpisodes,
    progressUpdate: {
      userId: input.userId,
      seriesId: input.seriesId,
      userStatus: input.proposedUserStatus,
      nextEpisodeId: input.proposedNextEpisodeId,
      lastWatchedAtUnchanged: true,
    },
  };
}
