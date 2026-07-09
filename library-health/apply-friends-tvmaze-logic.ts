// Pure decision logic for the single, narrowly-scoped Friends+TVmaze-431
// apply. No I/O, no Prisma, no provider calls — this only ever reasons
// about data already handed to it. Deliberately NOT a general apply
// pipeline: every constant below is hardcoded to this one confirmed case
// (see docs on FRIENDS_TARGET), and the guard refuses to proceed if
// reality has drifted even slightly from what was true when this was
// approved. See run-apply-provider-confirmation-friends.ts's header for
// why a general apply mode does not exist yet.

import { isUntrustedNextEpisodeTitle } from '../src/common/stale-series-trust';

// The exact, hardcoded target this script is allowed to touch — nothing
// else, ever. Sourced from library-health:provider-confirmation-dry-run's
// SAFE_TO_APPLY_LATER result for Friends (TVmaze id 431): 10 seasons / 236
// episodes on both sides, 0 orphaned watches, 0 new episodes, 0 risk
// warnings.
export const FRIENDS_TARGET = {
  title: 'Friends',
  provider: 'tvmaze' as const,
  providerId: '431',
  seasonCount: 10,
  episodeCount: 236,
} as const;

export interface FriendsApplyGuardInput {
  localTitle: string;
  provider: string;
  providerId: string;
  dryRunClassification: string;
  localSeasonCount: number;
  providerSeasonCount: number;
  localEpisodeCount: number;
  providerEpisodeCount: number;
  orphanedWatchedEpisodeCount: number;
}

export interface FriendsApplyGuardResult {
  allowed: boolean;
  violations: string[];
}

// Every one of the task's 8 hard-safety checks, each independent so a
// caller gets a complete list of everything that's wrong, not just the
// first failure. This is deliberately re-checked at run time (not trusted
// from a stale prior report) — see run-apply-provider-confirmation-friends.ts,
// which always re-fetches and re-classifies before calling this.
export function validateFriendsTvmazeApply(input: FriendsApplyGuardInput): FriendsApplyGuardResult {
  const violations: string[] = [];

  if (input.localTitle !== FRIENDS_TARGET.title) {
    violations.push(`local title must be exactly "${FRIENDS_TARGET.title}", got "${input.localTitle}"`);
  }
  if (input.provider !== FRIENDS_TARGET.provider) {
    violations.push(`provider must be exactly "${FRIENDS_TARGET.provider}", got "${input.provider}"`);
  }
  if (input.providerId !== FRIENDS_TARGET.providerId) {
    violations.push(`providerId must be exactly "${FRIENDS_TARGET.providerId}", got "${input.providerId}"`);
  }
  if (input.dryRunClassification !== 'SAFE_TO_APPLY_LATER') {
    violations.push(`dry-run classification must be SAFE_TO_APPLY_LATER, got "${input.dryRunClassification}"`);
  }
  if (input.localSeasonCount !== FRIENDS_TARGET.seasonCount || input.providerSeasonCount !== FRIENDS_TARGET.seasonCount) {
    violations.push(`season count must be exactly ${FRIENDS_TARGET.seasonCount}/${FRIENDS_TARGET.seasonCount} (local/provider), got ${input.localSeasonCount}/${input.providerSeasonCount}`);
  }
  if (input.localEpisodeCount !== FRIENDS_TARGET.episodeCount || input.providerEpisodeCount !== FRIENDS_TARGET.episodeCount) {
    violations.push(`episode count must be exactly ${FRIENDS_TARGET.episodeCount}/${FRIENDS_TARGET.episodeCount} (local/provider), got ${input.localEpisodeCount}/${input.providerEpisodeCount}`);
  }
  if (input.orphanedWatchedEpisodeCount !== 0) {
    violations.push(`orphaned watched episode count must be 0, got ${input.orphanedWatchedEpisodeCount}`);
  }
  if (isUntrustedNextEpisodeTitle(input.localTitle)) {
    violations.push(`"${input.localTitle}" is on an existing provider-structure risk list`);
  }

  return { allowed: violations.length === 0, violations };
}

// TVmaze episode summaries are HTML-formatted (e.g. "<p>...</p>") — MyTv's
// Episode.overview column stores plain text everywhere else (TMDb's own
// overview field is already plain text), so this strips markup rather than
// storing raw HTML in a text column no UI expects to render as HTML.
export function stripHtml(html: string | null): string | null {
  if (!html) return null;
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : null;
}

export interface LocalEpisodeForApply {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  overview: string | null;
  airDate: string | null;
  runtimeMinutes: number | null;
}

export interface ProviderEpisodeForApply {
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  overviewHtml: string | null;
  airDate: string | null;
  runtimeMinutes: number | null;
}

export interface EpisodeFieldChanges {
  title?: string;
  overview?: string;
  airDate?: string;
  runtimeMinutes?: number;
}

export interface EpisodeUpdatePlan {
  episodeId: string;
  seasonNumber: number;
  episodeNumber: number;
  changes: EpisodeFieldChanges;
}

// Backfill-only, never overwrite-with-null: a field is only ever included
// in `changes` when the provider has a non-null value that differs from
// what's stored locally. imageUrl is deliberately never touched here —
// TVmaze's per-episode data (as exposed by this codebase's existing
// TvMazeEpisode type/client) carries no still/thumbnail image field at
// all, so there is nothing "supported safely" to backfill it from (task's
// own qualifier on that field).
export function planEpisodeUpdate(local: LocalEpisodeForApply, provider: ProviderEpisodeForApply): EpisodeUpdatePlan {
  const changes: EpisodeFieldChanges = {};

  if (provider.title !== null && provider.title !== local.title) changes.title = provider.title;

  const overview = stripHtml(provider.overviewHtml);
  if (overview !== null && overview !== local.overview) changes.overview = overview;

  if (provider.airDate !== null && provider.airDate !== local.airDate) changes.airDate = provider.airDate;

  if (provider.runtimeMinutes !== null && provider.runtimeMinutes !== local.runtimeMinutes) changes.runtimeMinutes = provider.runtimeMinutes;

  return { episodeId: local.id, seasonNumber: local.seasonNumber, episodeNumber: local.episodeNumber, changes };
}

export function planEpisodeUpdates(localEpisodes: LocalEpisodeForApply[], providerEpisodes: ProviderEpisodeForApply[]): EpisodeUpdatePlan[] {
  const providerByKey = new Map(providerEpisodes.map((e) => [`${e.seasonNumber}:${e.episodeNumber}`, e]));
  const plans: EpisodeUpdatePlan[] = [];
  for (const local of localEpisodes) {
    const provider = providerByKey.get(`${local.seasonNumber}:${local.episodeNumber}`);
    // Should never happen once validateFriendsTvmazeApply has passed (it
    // requires exactly matching totals), but skip rather than guess if a
    // local episode genuinely has no provider counterpart — this script
    // never creates or remaps episodes.
    if (!provider) continue;
    plans.push(planEpisodeUpdate(local, provider));
  }
  return plans;
}

export interface PosterUpdatePlan {
  from: string | null;
  to: string;
  wouldChange: boolean;
}

// Only ever fills in a MISSING poster — never replaces an existing one
// (task: "Set posterUrl from TVmaze if currently missing").
export function planPosterUpdate(currentPosterUrl: string | null, providerPosterUrl: string | null): PosterUpdatePlan | null {
  if (currentPosterUrl !== null) return null;
  if (!providerPosterUrl) return null;
  return { from: currentPosterUrl, to: providerPosterUrl, wouldChange: true };
}

export interface FriendsApplyPlan {
  seriesId: string;
  externalIdsUpdate: { seriesId: string; provider: 'tvmaze'; providerId: string };
  posterUpdate: PosterUpdatePlan | null;
  episodeUpdates: EpisodeUpdatePlan[];
  episodeUpdateCount: number; // episodeUpdates.length, with at least one non-empty change
  progressUpdate: {
    userId: string;
    seriesId: string;
    userStatus: string;
    nextEpisodeId: string | null;
    lastWatchedAtUnchanged: true; // documents that lastWatchedAt is deliberately never touched by this plan
  };
}

export function buildFriendsApplyPlan(input: {
  userId: string;
  seriesId: string;
  currentPosterUrl: string | null;
  providerPosterUrl: string | null;
  localEpisodes: LocalEpisodeForApply[];
  providerEpisodes: ProviderEpisodeForApply[];
  proposedUserStatus: string;
  proposedNextEpisodeId: string | null;
}): FriendsApplyPlan {
  const episodeUpdates = planEpisodeUpdates(input.localEpisodes, input.providerEpisodes).filter((u) => Object.keys(u.changes).length > 0);

  return {
    seriesId: input.seriesId,
    externalIdsUpdate: { seriesId: input.seriesId, provider: FRIENDS_TARGET.provider, providerId: FRIENDS_TARGET.providerId },
    posterUpdate: planPosterUpdate(input.currentPosterUrl, input.providerPosterUrl),
    episodeUpdates,
    episodeUpdateCount: episodeUpdates.length,
    progressUpdate: {
      userId: input.userId,
      seriesId: input.seriesId,
      userStatus: input.proposedUserStatus,
      nextEpisodeId: input.proposedNextEpisodeId,
      lastWatchedAtUnchanged: true,
    },
  };
}
