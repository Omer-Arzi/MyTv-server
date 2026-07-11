// Pure logic for MIGRATION-MODE provider confirmation. No I/O.
//
// Problem this solves: the existing pipeline (classifyProviderConfirmationDryRun
// + compareSeriesCatalog's deriveUserStatusFromNextEpisode) recomputes
// userStatus mechanically from the NEW provider's episode/watch-matching —
// it has no concept of "this was already finished under the OLD
// provider, preserve that human viewing state across the migration."
// COMPLETED/CAUGHT_UP are not in decideUserStatusUpdate's protected-status
// list, so a large orphan count can silently regress a finished series
// back to WATCHING. See docs/library-health-provider-confirmation-runbook.md
// for the full investigation this module resolves.
//
// This module is deliberately ADDITIVE, not a modification of the
// existing strict pipeline: classifyProviderConfirmationDryRun,
// checkBenignSeasonZeroOrphan, and checkSplitEpisodeTailOnly are
// untouched and still run first, unconditionally, for every title. This
// module only ever activates — and only ever LOOSENS the orphan-pattern
// tolerance and status derivation, never the identity check — when a
// human has explicitly set migrationIntent: true for that title in
// provider-confirmation-decisions.json. Omitting migrationIntent (or
// setting it false) reproduces today's exact classification, byte for
// byte; there is no code path that reaches a migration classification
// without that explicit flag (tested in
// __tests__/migration-confirmation-logic.test.ts).
//
// What migration mode tolerates: ANY orphan pattern (season-0, trailing
// tail, or scattered/large-scale like Naruto Shippuden's ~472 orphans),
// as long as every orphan is preserved untouched — never deleted, never
// renumbered, never has its EpisodeWatch rows touched. What it NEVER
// tolerates, even with migrationIntent set: a failed title/year sanity
// check. Structural mismatch is a migration's normal cost of doing
// business; identity mismatch is a different problem migration intent
// must never paper over — see BLOCKED_DESTRUCTIVE_RISK below.

import { UserSeriesStatus } from '@prisma/client';
import { DryRunClassification, SupportedProvider } from './provider-confirmation-decisions-logic';
import { OrphanedWatchedEpisode } from './season-zero-orphan-logic';
import { EpisodeUpdatePlan, LocalEpisodeForApply, PosterUpdatePlan, planEpisodeUpdates, planPosterUpdate, ProviderEpisodeForApply } from './apply-friends-tvmaze-logic';
import { ExternalIdsUpdate } from './apply-confirmed-provider-logic';

export type MigrationClassification = 'SAFE_MIGRATION_WITH_PRESERVED_ORPHANS' | 'SAFE_MIGRATION_WITH_STATUS_OVERRIDE' | 'BLOCKED_DESTRUCTIVE_RISK';

// The classification a migration-aware caller ends up with: either one of
// the three new migration tiers, or the untouched base classification
// when migration mode has nothing extra to contribute (e.g. migrationIntent
// is false, or the base result is already safe with nothing to override).
export type ResolvedMigrationClassification = DryRunClassification | MigrationClassification;

// Per this task's explicit requirement 8 — DROPPED and PAUSED are always
// protected, regardless of migration intent or an explicit statusOverride.
// (The real apply transaction's decideUserStatusUpdate also protects
// WATCHLIST as an additional, pre-existing safety net — this module's own
// list is intentionally the narrower, explicitly-required set so its
// behavior is exactly and only what this task specifies.)
export const PROTECTED_MIGRATION_STATUSES: UserSeriesStatus[] = [UserSeriesStatus.DROPPED, UserSeriesStatus.PAUSED];

export function isProtectedMigrationStatus(status: UserSeriesStatus): boolean {
  return PROTECTED_MIGRATION_STATUSES.includes(status);
}

export interface MigrationIntentInput {
  migrationIntent: boolean;
  statusOverride?: UserSeriesStatus;
}

// Shared vocabulary for "why did the resolved userStatus end up this way,"
// used by both an explicit migrationIntent decision (derived/human-override)
// and the newer objective auto-policy (migration-policy-logic.ts's
// resolveObjectiveMigrationStatus, which additionally distinguishes
// preserved-because-not-objectively-derivable from protected-because-DROPPED-or-PAUSED).
// Defined here (not in migration-policy-logic.ts, which already imports
// isProtectedMigrationStatus from this file) to avoid a circular import —
// buildMigrationApplyPlan itself never branches on this value, it only
// ever passes it through to progressUpdate.statusSource for reporting.
export type StatusSource = 'derived' | 'human-override' | 'preserved' | 'protected';

export interface ClassifyMigrationConfirmationInput {
  baseClassification: DryRunClassification;
  baseReason: string;
  titleYearSanityPassed: boolean;
  // Second hard floor, alongside titleYearSanityPassed — added during the
  // stable-version migration policy work after an audit found this
  // function never checked it at all. A real (non-zero) season shrinking
  // or disappearing relative to the provider is a numbering-collision
  // signal, not an orphan-tolerance question: migrationIntent existed to
  // relax orphan-PATTERN restrictions, never to bless writing against a
  // catalog shape that doesn't actually line up. Without this check, an
  // explicit migrationIntent: true could previously have masked a genuine
  // structural risk the non-migration pipeline would correctly block on.
  realSeasonShrinkDetected: boolean;
  // The FULL, unfiltered orphan list — season-0 specials, split/merge
  // tails, and any real-season scattered orphans alike. Migration mode
  // preserves all of them regardless of pattern; only the non-migration
  // pipeline restricts itself to the two narrow benign patterns.
  orphanedWatchedEpisodes: OrphanedWatchedEpisode[];
  currentUserStatus: UserSeriesStatus;
  migration: MigrationIntentInput;
}

export interface ClassifyMigrationConfirmationResult {
  classification: ResolvedMigrationClassification;
  reason: string;
  statusSource: StatusSource;
  // The userStatus a migration-mode apply would actually write — never
  // the mechanically-recomputed provider-count-derived value. Either the
  // human's explicit override, or the CURRENT local status carried
  // forward unchanged (never silently regressed).
  resolvedUserStatus: UserSeriesStatus;
  // Every orphan migration mode commits to preserving untouched. Always
  // exactly equal to the input orphanedWatchedEpisodes when a migration
  // classification is returned; empty for BLOCKED_DESTRUCTIVE_RISK (no
  // apply happens at all) and for pass-through (non-migration) results.
  preservedOrphanEpisodes: OrphanedWatchedEpisode[];
}

function passthrough(input: ClassifyMigrationConfirmationInput, reason: string): ClassifyMigrationConfirmationResult {
  return {
    classification: input.baseClassification,
    reason,
    statusSource: 'derived',
    resolvedUserStatus: input.currentUserStatus,
    preservedOrphanEpisodes: [],
  };
}

export function classifyMigrationConfirmation(input: ClassifyMigrationConfirmationInput): ClassifyMigrationConfirmationResult {
  // --- Reachability gate (task requirement 6): no migration tier is ever
  // returned without an explicit, human-set migrationIntent === true. ----
  if (!input.migration.migrationIntent) {
    return passthrough(input, input.baseReason);
  }

  // --- Hard floor (task requirement 7's "allow structural mismatch only
  // when provider identity is confirmed"): migration intent NEVER
  // rescues a failed title/year sanity check. An identity mismatch means
  // "migrating" would attach real watch history to the wrong show
  // entirely — a different, more serious problem than a numbering
  // difference, and one no amount of human-approved migration intent
  // should be allowed to paper over. -------------------------------------
  if (!input.titleYearSanityPassed) {
    return {
      classification: 'BLOCKED_DESTRUCTIVE_RISK',
      reason: `migrationIntent is set, but the title/year sanity check failed (${input.baseReason}) — provider identity is not confirmed, so migration mode refuses to proceed regardless of intent.`,
      statusSource: 'derived',
      resolvedUserStatus: input.currentUserStatus,
      preservedOrphanEpisodes: [],
    };
  }

  // Second hard floor — never bypassed by migrationIntent, mirroring the
  // title/year sanity check immediately above. See the field comment on
  // realSeasonShrinkDetected for why this was missing and why it matters.
  if (input.realSeasonShrinkDetected) {
    return {
      classification: 'BLOCKED_DESTRUCTIVE_RISK',
      reason: `migrationIntent is set, but a real (non-zero) season shrank or disappeared relative to the provider (${input.baseReason}) — numbering-collision risk, not an orphan-pattern question; migration mode refuses to proceed regardless of intent.`,
      statusSource: 'derived',
      resolvedUserStatus: input.currentUserStatus,
      preservedOrphanEpisodes: [],
    };
  }

  const isProtected = isProtectedMigrationStatus(input.currentUserStatus);
  const hasOverride = input.migration.statusOverride !== undefined;

  let resolvedUserStatus: UserSeriesStatus;
  let statusSource: StatusSource;
  let statusNote: string;

  if (isProtected) {
    // Task requirement 8 — DROPPED/PAUSED win, full stop, even if a
    // statusOverride was also provided in the same decision entry.
    resolvedUserStatus = input.currentUserStatus;
    statusSource = 'derived';
    statusNote = `current status is ${input.currentUserStatus} (protected) — migration never overrides DROPPED/PAUSED, even with an explicit statusOverride`;
  } else if (hasOverride) {
    resolvedUserStatus = input.migration.statusOverride as UserSeriesStatus;
    statusSource = 'human-override';
    statusNote = `userStatus explicitly set to ${resolvedUserStatus} by human-provided statusOverride, not recomputed from the new provider's episode counts`;
  } else {
    resolvedUserStatus = input.currentUserStatus;
    statusSource = 'derived';
    statusNote = `no statusOverride provided — current status (${input.currentUserStatus}) is carried forward unchanged rather than recomputed from the new provider's episode/watch matching`;
  }

  const preservedOrphanEpisodes = input.orphanedWatchedEpisodes;

  // hasOverride (and not protected) is the signal that distinguishes the
  // two positive migration tiers: an explicit override means the human
  // has judged the mechanical derivation untrustworthy enough to replace
  // outright (typically because the mismatch is large — e.g. Naruto
  // Shippuden's ~472 orphans), whereas relying on "carry the current
  // status forward" alone is the lighter-touch tier for smaller
  // mismatches (e.g. Doctor Who's 1 orphan, The Flash's 2).
  if (hasOverride && !isProtected) {
    return {
      classification: 'SAFE_MIGRATION_WITH_STATUS_OVERRIDE',
      reason: `provider identity confirmed; ${preservedOrphanEpisodes.length} orphaned watched episode(s) will be preserved untouched; ${statusNote}.`,
      statusSource,
      resolvedUserStatus,
      preservedOrphanEpisodes,
    };
  }

  return {
    classification: 'SAFE_MIGRATION_WITH_PRESERVED_ORPHANS',
    reason: `provider identity confirmed; ${preservedOrphanEpisodes.length} orphaned watched episode(s) will be preserved untouched; ${statusNote}.`,
    statusSource,
    resolvedUserStatus,
    preservedOrphanEpisodes,
  };
}

export interface MigrationApplyPlan {
  seriesId: string;
  title: string;
  provider: SupportedProvider;
  providerId: string;
  externalIdsUpdate: ExternalIdsUpdate;
  posterUpdate: PosterUpdatePlan | null;
  episodeUpdates: EpisodeUpdatePlan[];
  episodeUpdateCount: number;
  // Every orphan this plan commits to leaving untouched — ALWAYS exactly
  // equal (same ids, same count) to the orphanedWatchedEpisodes passed
  // in; buildMigrationApplyPlan throws rather than silently dropping one,
  // even at Naruto-Shippuden-orphan-count scale.
  preservedOrphanEpisodes: OrphanedWatchedEpisode[];
  progressUpdate: {
    userId: string;
    seriesId: string;
    userStatus: UserSeriesStatus;
    // Never recomputed from provider episode-matching in migration mode:
    // null whenever resolvedUserStatus is a finished state (COMPLETED/
    // CAUGHT_UP), otherwise the CURRENT local nextEpisodeId carried
    // forward unchanged — never a newly-computed "next" episode from the
    // (potentially unreliable, given the mismatch) provider catalog.
    nextEpisodeId: string | null;
    lastWatchedAtUnchanged: true;
    statusSource: StatusSource;
  };
}

const FINISHED_STATUSES: UserSeriesStatus[] = [UserSeriesStatus.COMPLETED, UserSeriesStatus.CAUGHT_UP];

export function buildMigrationApplyPlan(input: {
  seriesId: string;
  title: string;
  provider: SupportedProvider;
  providerId: string;
  userId: string;
  currentPosterUrl: string | null;
  providerPosterUrl: string | null;
  localEpisodes: LocalEpisodeForApply[];
  providerEpisodes: ProviderEpisodeForApply[];
  orphanedWatchedEpisodes: OrphanedWatchedEpisode[];
  resolvedUserStatus: UserSeriesStatus;
  statusSource: StatusSource;
  currentNextEpisodeId: string | null;
}): MigrationApplyPlan {
  const episodeUpdates = planEpisodeUpdates(input.localEpisodes, input.providerEpisodes).filter((u) => Object.keys(u.changes).length > 0);

  // Hard invariant, not a soft check: migration mode's entire safety case
  // rests on "every orphan is preserved, none silently dropped." Since
  // planEpisodeUpdates only ever produces updates for MATCHED
  // (season, episode) pairs, an orphan (by definition unmatched) can
  // never legitimately appear here — if one did, that would mean an
  // orphan was about to be written to, which must never happen.
  const orphanIds = new Set(input.orphanedWatchedEpisodes.map((o) => o.id));
  const collision = episodeUpdates.find((u) => orphanIds.has(u.episodeId));
  if (collision) {
    throw new Error(`migration apply plan invariant violated: orphaned episode ${collision.episodeId} appears in episodeUpdates — refusing to build an unsafe plan.`);
  }

  const nextEpisodeId = FINISHED_STATUSES.includes(input.resolvedUserStatus) ? null : input.currentNextEpisodeId;

  return {
    seriesId: input.seriesId,
    title: input.title,
    provider: input.provider,
    providerId: input.providerId,
    externalIdsUpdate: { seriesId: input.seriesId, provider: input.provider, providerId: input.providerId, tmdbId: input.provider === 'tmdb' ? input.providerId : undefined },
    posterUpdate: planPosterUpdate(input.currentPosterUrl, input.providerPosterUrl),
    episodeUpdates,
    episodeUpdateCount: episodeUpdates.length,
    // Preserved list is the orphan list itself, verbatim — this IS the
    // preservation guarantee, not a derived subset of it.
    preservedOrphanEpisodes: input.orphanedWatchedEpisodes,
    progressUpdate: {
      userId: input.userId,
      seriesId: input.seriesId,
      userStatus: input.resolvedUserStatus,
      nextEpisodeId,
      lastWatchedAtUnchanged: true,
      statusSource: input.statusSource,
    },
  };
}
