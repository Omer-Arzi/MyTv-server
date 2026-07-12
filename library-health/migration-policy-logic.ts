// Pure logic for the OBJECTIVE migration policy — the replacement for
// requiring a human to set migrationIntent: true per title. No I/O.
//
// See docs/stable-version-migration-todo.md for the full policy design and
// the evidence behind it. Summary: migrationIntent today bundles three
// unrelated concerns (orphan-pattern tolerance, statusOverride permission,
// and a bare "go" signal). This module makes the first two objective:
//   - orphan tolerance requires no per-title flag once identity + structural
//     safety are confirmed — the write path (season-episode-writer.ts,
//     migration-confirmation-logic.ts's buildMigrationApplyPlan) already
//     preserves any orphan pattern unconditionally, so gating on pattern
//     shape protects nothing once that's trusted.
//   - status resolution derives automatically when the data proves it
//     (every provider-matched episode already watched locally), and falls
//     back to preserving the current status unchanged otherwise — never a
//     silent regression, never a blind mechanical recompute.
// migrationIntent/statusOverride remain fully supported as an explicit
// manual override for cases this objective policy can't resolve (see
// run-provider-confirmation-pipeline.ts) — this module does not remove
// that escape hatch, it removes the requirement to use it for the common
// case.
//
// What this module deliberately does NOT touch: title/year identity
// confirmation itself (still and forever a human decision — see
// provider-confirmation-decisions-logic.ts's checkTitleYearSanity, called
// unconditionally, unaffected by anything here), real season-shrink
// detection (season-zero-orphan-logic.ts's detectRealSeasonShrink, also
// unaffected), and the engine's orphan-preservation invariant (still
// enforced exactly where it always was).

import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { titleSimilarity } from '../trakt-enrichment/scoring';
import { isProtectedMigrationStatus, StatusSource } from './migration-confirmation-logic';

// --- Identity confidence banding --------------------------------------
//
// The one place a continuous/banded signal is justified (per the policy
// review this task follows up on) — titleSimilarity() already returns a
// real 0..1 float; checkTitleYearSanity() already uses it against a hard
// 0.6 pass/fail floor that stays completely unchanged here. This only adds
// a second, higher bar ABOVE that floor so "clearly the right show" can be
// distinguished from "passed, but only barely" without touching the
// existing fail threshold at all.

export type IdentityConfidenceBand = 'HIGH_CONFIDENCE' | 'BORDERLINE' | 'FAILED';

const HIGH_CONFIDENCE_SIMILARITY_THRESHOLD = 0.85;

export interface ClassifyIdentityConfidenceInput {
  titleYearSanityPassed: boolean;
  // The exact same similarity value checkTitleYearSanity's own fuzzy-match
  // branch computes (titleSimilarity(hint.bareTitle, candidateTitle)) — an
  // exact-title match trivially yields 1.0 (titleSimilarity's own
  // short-circuit), so HIGH_CONFIDENCE always covers exact matches too.
  similarity: number;
}

export function classifyIdentityConfidence(input: ClassifyIdentityConfidenceInput): IdentityConfidenceBand {
  if (!input.titleYearSanityPassed) return 'FAILED';
  if (input.similarity >= HIGH_CONFIDENCE_SIMILARITY_THRESHOLD) return 'HIGH_CONFIDENCE';
  return 'BORDERLINE';
}

// --- Objective status resolution ----------------------------------------

export interface ResolveObjectiveMigrationStatusInput {
  // Every locally-watched episode that DOES match a provider (seasonNumber,
  // episodeNumber) slot — i.e. NOT counting orphans, which by definition
  // have no provider match to be "caught up" against.
  matchedWatchedCount: number;
  // Every provider-matched local episode, watched or not.
  matchedTotalCount: number;
  currentUserStatus: UserSeriesStatus;
  providerReleaseStatus: ReleaseStatus;
}

export interface ResolveObjectiveMigrationStatusResult {
  resolvedUserStatus: UserSeriesStatus;
  statusSource: StatusSource;
  reason: string;
}

const FINISHED_RELEASE_STATUSES: ReleaseStatus[] = [ReleaseStatus.ENDED, ReleaseStatus.CANCELLED];

// If every provider-recognized episode is already watched, there is
// nothing left to derive — COMPLETED/CAUGHT_UP follows mechanically from
// the same rule used everywhere else in the app (deriveUserStatusFromNextEpisode).
// Otherwise, the data alone can't distinguish "still actively watching",
// "quietly dropped it", or "apparent progress is itself an artifact of the
// provider mismatch" — genuinely a fact only the user can know, so the
// safe, non-regressing default is to leave the current status exactly as
// it is. This is not new behavior invented for auto-migration: it's
// exactly what migration-confirmation-logic.ts's no-override path already
// does today — this function just makes it apply automatically instead of
// requiring migrationIntent to reach it.
export function resolveObjectiveMigrationStatus(input: ResolveObjectiveMigrationStatusInput): ResolveObjectiveMigrationStatusResult {
  if (isProtectedMigrationStatus(input.currentUserStatus)) {
    return {
      resolvedUserStatus: input.currentUserStatus,
      statusSource: 'protected',
      reason: `current status is ${input.currentUserStatus} (protected) — catalog reconciliation never overrides DROPPED/PAUSED, regardless of watched-episode counts`,
    };
  }

  if (input.matchedTotalCount > 0 && input.matchedWatchedCount >= input.matchedTotalCount) {
    const isFinished = FINISHED_RELEASE_STATUSES.includes(input.providerReleaseStatus);
    const resolvedUserStatus = isFinished ? UserSeriesStatus.COMPLETED : UserSeriesStatus.CAUGHT_UP;
    return {
      resolvedUserStatus,
      statusSource: 'derived',
      reason: `all ${input.matchedTotalCount} provider-matched episode(s) are already watched locally — objectively derived ${resolvedUserStatus} from provider lifecycle (${input.providerReleaseStatus}), independent of any orphan count`,
    };
  }

  return {
    resolvedUserStatus: input.currentUserStatus,
    statusSource: 'preserved',
    reason:
      input.matchedTotalCount === 0
        ? 'zero provider-matched episodes — nothing to derive from, current status preserved unchanged'
        : `${input.matchedWatchedCount}/${input.matchedTotalCount} provider-matched episodes watched — not objectively complete, current status (${input.currentUserStatus}) preserved unchanged rather than guessed`,
  };
}

// --- Auto-migration eligibility (replaces migrationIntent as a required
// per-title flag) ---------------------------------------------------------

export interface EvaluateAutoMigrationEligibilityInput {
  titleYearSanityPassed: boolean;
  identityBand: IdentityConfidenceBand;
  realSeasonShrinkDetected: boolean;
}

export interface AutoMigrationEligibilityResult {
  eligible: boolean;
  reason: string;
}

// Deliberately does NOT look at orphan count/pattern or watched-episode
// mapping completeness at all — those are handled unconditionally by
// buildMigrationApplyPlan's preservation invariant and
// resolveObjectiveMigrationStatus above, not by this gate. This function
// only answers "is provider identity trustworthy and is the catalog shape
// safe to write against" — the two genuine safety gates identified in the
// policy review, re-verified against code in this task's baseline audit.
export function evaluateAutoMigrationEligibility(input: EvaluateAutoMigrationEligibilityInput): AutoMigrationEligibilityResult {
  if (!input.titleYearSanityPassed || input.identityBand === 'FAILED') {
    return { eligible: false, reason: 'provider identity not confirmed (title/year sanity failed or similarity below the auto-migration floor) — requires manual review' };
  }
  if (input.realSeasonShrinkDetected) {
    return { eligible: false, reason: 'a real (non-zero) season shrank or disappeared relative to the provider — numbering collision risk, requires manual review' };
  }
  return {
    eligible: true,
    reason:
      input.identityBand === 'BORDERLINE'
        ? 'identity confidence is borderline but passed title/year sanity, and catalog structure is safe — eligible, flagged for visibility'
        : 'identity confirmed with high confidence and catalog structure is safe — eligible for automatic migration',
  };
}

// --- Post-catalog-creation progress correction --------------------------
//
// migration-catalog-plan-logic.ts's catalogInsertPlan can create brand new,
// unwatched, RELEASED Season/Episode rows as part of the SAME apply that
// resolves userStatus/nextEpisodeId. Every status/next-episode resolution
// path in this pipeline (classifyMigrationConfirmation's carry-forward,
// resolveObjectiveMigrationStatus's matched-count derivation above, and the
// base (non-migration) pipeline's ordinary compareSeriesCatalog-driven
// resolution) predates that capability and has no way to know new rows are
// about to appear — each only ever reasons about episodes that ALREADY
// exist locally at decision time. Left uncorrected, a title with e.g. 90
// new unwatched episodes about to be created can still end up with
// userStatus/nextEpisodeId exactly as if nothing changed (e.g. CAUGHT_UP /
// null), because every one of those functions legitimately had no
// visibility into the new rows when it ran.
//
// This is a single, narrow, always-safe correction: it only ever fires
// when there verifiably IS a next episode to point to (existing locally
// already, or about to be created by catalogInsertPlan in this same
// apply) and nothing more privileged — a protected DROPPED/PAUSED status,
// or an explicit human statusOverride — says otherwise. It never fires
// when there's nothing new to watch, which leaves every other nuance
// above (derive vs. preserve vs. carry-forward when there's genuinely
// nothing new) completely untouched. Resolving the REAL episode id for a
// brand-new proposed-next episode is the caller's job (a live DB lookup,
// only possible once the row actually exists) — this function only
// decides whether the override should happen at all.
export interface ShouldForceWatchingForPendingNextEpisodeInput {
  // compareSeriesCatalog's proposedNextEpisodeLabel !== null — true
  // whenever there's a next unwatched, released episode, whether it
  // already exists locally or is about to be created by catalogInsertPlan.
  hasProposedNextEpisode: boolean;
  // Read live (inside the apply transaction, or from the pre-transaction
  // snapshot for a dry-run preview) — never trusted from an earlier
  // classification-time snapshot, matching every other protected-status
  // re-check in this pipeline.
  liveUserStatus: UserSeriesStatus;
  // True only for the explicit migrationIntent + statusOverride case — an
  // informed human decision that must win even if it means a large new
  // batch of episodes sits "hidden" under e.g. an explicit COMPLETED.
  explicitStatusOverrideGiven: boolean;
  // Whether this series has ANY locally-watched episode at all (matched or
  // orphaned — any watch history counts). This correction exists to fix a
  // series the user was already engaged with (WATCHING/CAUGHT_UP/COMPLETED)
  // whose "something new to watch" fact got lost because catalog creation
  // post-dates status resolution — see the file-level comment above. A
  // series with zero watch history (WATCHLIST's "haven't started yet", or a
  // fresh UNKNOWN) is never "something new to watch" — it's the ordinary,
  // still-unstarted state, and having a next episode is true of virtually
  // every such series by definition. Forcing WATCHING here would silently
  // promote every unstarted WATCHLIST series to "watching" the moment its
  // identity gets confirmed, which is exactly the same class of mistake
  // proposeUserStatusAfterEnrichment (derive-user-status.ts) already guards
  // against for the sibling Trakt/TMDb enrichment flow — same rule, applied
  // here too.
  hasAnyWatchedEpisode: boolean;
}

export function shouldForceWatchingForPendingNextEpisode(input: ShouldForceWatchingForPendingNextEpisodeInput): boolean {
  if (!input.hasProposedNextEpisode) return false;
  if (isProtectedMigrationStatus(input.liveUserStatus)) return false;
  if (input.explicitStatusOverrideGiven) return false;
  if (!input.hasAnyWatchedEpisode) return false;
  return true;
}
