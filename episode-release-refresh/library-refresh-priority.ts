// Pure ordering policy for manual full-library refresh (Part 6.2): "which
// series get checked first." No I/O — the caller (LibraryRefreshJobService)
// loads the raw per-series facts; this only decides order. Kept separate
// from smart-scheduling-policy.ts (which decides WHEN a series becomes due
// again) — this is a different, one-off question ("given a batch that's
// all being refreshed right now anyway, what order is most useful"), not
// an interval.

import { UserSeriesStatus } from '@prisma/client';
import { EpisodeUrgency } from '../src/common/release-date-policy';

export interface LibraryRefreshCandidate {
  seriesId: string;
  userStatus: UserSeriesStatus;
  urgency: EpisodeUrgency;
}

const URGENCY_RANK: Record<EpisodeUrgency, number> = {
  OVERDUE_OR_DUE_TODAY: 0,
  DUE_WITHIN_48H: 1,
  ACTIVE_NO_NEAR_EPISODE: 2,
  BETWEEN_SEASONS_OR_UNKNOWN: 3,
};

// WATCHING/CAUGHT_UP first (the user is actively engaged or specifically
// waiting on a next episode), then everything else — mirrors the same
// "CAUGHT_UP is not lower priority than WATCHING" principle
// smart-scheduling-policy.ts already applies to intervals, applied here to
// ordering instead.
function statusRank(status: UserSeriesStatus): number {
  return status === UserSeriesStatus.WATCHING || status === UserSeriesStatus.CAUGHT_UP ? 0 : 1;
}

// Stable sort: within identical (statusRank, urgencyRank), original order
// is preserved — deterministic given the same input, no hidden randomness.
export function prioritizeSeriesForLibraryRefresh(candidates: LibraryRefreshCandidate[]): string[] {
  return [...candidates]
    .map((c, index) => ({ c, index }))
    .sort((a, b) => {
      const statusDiff = statusRank(a.c.userStatus) - statusRank(b.c.userStatus);
      if (statusDiff !== 0) return statusDiff;
      const urgencyDiff = URGENCY_RANK[a.c.urgency] - URGENCY_RANK[b.c.urgency];
      if (urgencyDiff !== 0) return urgencyDiff;
      return a.index - b.index;
    })
    .map(({ c }) => c.seriesId);
}
