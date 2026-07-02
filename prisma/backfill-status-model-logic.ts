// Pure decision logic for prisma/backfill-status-model.ts, extracted so the
// per-series branching (docs/status-model-plan.md §5) is unit-testable
// without a database. No I/O here.

import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';

export interface BackfillDecisionInput {
  hasExistingProgressRow: boolean;
  onWatchlist: boolean;
  watchedCount: number;
  isArchived: boolean;
  isForLater: boolean;
  hasTvTimeSignal: boolean;
  isImported: boolean;
  hasKnownNextEpisode: boolean;
  releaseStatus: ReleaseStatus;
}

export type BackfillDecision =
  | { action: 'skip' }
  | { action: 'set'; userStatus: UserSeriesStatus; missingTvTimeSignal: boolean };

export function decideBackfillUserStatus(input: BackfillDecisionInput): BackfillDecision {
  if (!input.hasExistingProgressRow && !input.onWatchlist) {
    // No relationship of any kind — nothing to backfill, no row needed.
    return { action: 'skip' };
  }

  if (input.isArchived) {
    return { action: 'set', userStatus: UserSeriesStatus.DROPPED, missingTvTimeSignal: false };
  }

  if (input.hasKnownNextEpisode) {
    return { action: 'set', userStatus: UserSeriesStatus.WATCHING, missingTvTimeSignal: false };
  }

  if (input.watchedCount > 0 && input.isImported) {
    // Non-committal placeholder — the importer never resolved a full
    // episode catalog for this series, so CAUGHT_UP/COMPLETED would be a
    // guess. See docs/status-model-plan.md §5.
    return { action: 'set', userStatus: UserSeriesStatus.WATCHING, missingTvTimeSignal: !input.hasTvTimeSignal };
  }

  if (input.watchedCount > 0 && !input.isImported) {
    // Organic (seed/manually-created) data has a real, bounded catalog —
    // safe to fully derive.
    const isFinished = input.releaseStatus === ReleaseStatus.ENDED || input.releaseStatus === ReleaseStatus.CANCELLED;
    return {
      action: 'set',
      userStatus: isFinished ? UserSeriesStatus.COMPLETED : UserSeriesStatus.CAUGHT_UP,
      missingTvTimeSignal: false,
    };
  }

  if (input.isForLater || input.onWatchlist) {
    return { action: 'set', userStatus: UserSeriesStatus.WATCHLIST, missingTvTimeSignal: false };
  }

  return { action: 'set', userStatus: UserSeriesStatus.UNKNOWN, missingTvTimeSignal: false };
}
