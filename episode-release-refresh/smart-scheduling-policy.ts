// The centralized, pure "how often should this series' provider catalog be
// re-checked" policy — replaces sync-frequency-policy.ts's flat
// per-userStatus interval table (REFRESH_INTERVAL_MS) for the SUCCESS path
// only. sync-frequency-policy.ts still owns the separate "is this status
// ever on a schedule at all" gate and the failure-backoff math — this file
// only answers "given we're on a schedule and the last attempt succeeded,
// how long until the next one," now informed by episode urgency
// (computeEpisodeUrgency, src/common/release-date-policy.ts) as well as
// userStatus. No I/O — pure function of already-known local data, same
// convention as every other *-logic.ts/*-policy.ts file in this project.
//
// Values below are deliberately named constants (not magic numbers inline)
// so the interval table reads as policy, matching this task's explicit
// "policy defaults, not hardcoded behavior scattered through services"
// requirement.

import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { computeEpisodeUrgency, EpisodeUrgency } from '../src/common/release-date-policy';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const ACTIVE_RELEASE_STATUSES: ReleaseStatus[] = [ReleaseStatus.RETURNING, ReleaseStatus.IN_PRODUCTION];

export interface SmartSchedulingInput {
  userStatus: UserSeriesStatus;
  releaseStatus: ReleaseStatus;
  nextKnownUpcomingAirDate: Date | null;
  now?: Date;
}

export interface SmartSchedulingResult {
  intervalMs: number;
  urgency: EpisodeUrgency;
  // A short, human/log-friendly explanation of which policy rule fired —
  // surfaced in structured logs (Part 15) as the "due reason".
  reason: string;
}

// WATCHING and CAUGHT_UP share the same near-episode acceleration tiers —
// a caught-up series is NOT lower priority than a watching one (explicit
// requirement: the user is specifically waiting for the next episode
// either way, and this must hold in EVERY tier, not just the urgent ones).
// They differ only in the "active, no near episode known" tier, where
// CAUGHT_UP can afford to wait slightly longer (WATCHING implies there's
// already unwatched backlog worth checking on more eagerly even without a
// known near-episode date) — WATCHING's own "no known active release
// window" tier deliberately uses the TOP of its stated 12-24h range (not
// the midpoint) specifically so it never becomes MORE frequent than
// CAUGHT_UP's equivalent tier, which would silently violate the
// never-lower-priority rule this file's own tests enforce.
const WATCHING_TIERS: Record<EpisodeUrgency, number> = {
  OVERDUE_OR_DUE_TODAY: 1 * HOUR_MS,
  DUE_WITHIN_48H: 2 * HOUR_MS,
  ACTIVE_NO_NEAR_EPISODE: 8 * HOUR_MS,
  BETWEEN_SEASONS_OR_UNKNOWN: 24 * HOUR_MS, // top of the 12-24h range — see comment above.
};

const CAUGHT_UP_TIERS: Record<EpisodeUrgency, number> = {
  OVERDUE_OR_DUE_TODAY: 1 * HOUR_MS,
  DUE_WITHIN_48H: 2 * HOUR_MS,
  ACTIVE_NO_NEAR_EPISODE: 7 * HOUR_MS, // midpoint of the 6-8h range
  BETWEEN_SEASONS_OR_UNKNOWN: 24 * HOUR_MS,
};

const PAUSED_ACTIVE_MS = 2 * DAY_MS; // midpoint of the 1-3 day range
const PAUSED_BETWEEN_SEASONS_MS = 7 * DAY_MS;

// "Approximately every 2-4 weeks" — 21 days (3 weeks), the midpoint. This
// replaces sync-frequency-policy.ts's prior flat 60-day DROPPED interval —
// an explicit, deliberate change (the task's own DROPPED policy asks for a
// real periodic check, not the previous, far more conservative default);
// see the final report for this call-out.
const DROPPED_INTERVAL_MS = 21 * DAY_MS;

const COMPLETED_PROVIDER_ENDED_MS = 30 * DAY_MS; // metadata-only, very low frequency — unchanged from before.

const WATCHLIST_ACTIVE_MS = 1 * DAY_MS;
const WATCHLIST_BETWEEN_SEASONS_MS = 7 * DAY_MS; // unchanged from before.

export function computeSmartRefreshIntervalMs(input: SmartSchedulingInput): SmartSchedulingResult {
  const now = input.now ?? new Date();
  const urgency = computeEpisodeUrgency({ releaseStatus: input.releaseStatus, nextKnownUpcomingAirDate: input.nextKnownUpcomingAirDate, now });
  const isProviderActive = ACTIVE_RELEASE_STATUSES.includes(input.releaseStatus);

  switch (input.userStatus) {
    case UserSeriesStatus.WATCHING:
      return { intervalMs: WATCHING_TIERS[urgency], urgency, reason: `WATCHING, urgency=${urgency}` };

    case UserSeriesStatus.CAUGHT_UP:
      return { intervalMs: CAUGHT_UP_TIERS[urgency], urgency, reason: `CAUGHT_UP (high priority — user is waiting for the next episode), urgency=${urgency}` };

    case UserSeriesStatus.PAUSED: {
      const intervalMs = isProviderActive ? PAUSED_ACTIVE_MS : PAUSED_BETWEEN_SEASONS_MS;
      return { intervalMs, urgency, reason: `PAUSED (ON_HOLD), providerActive=${isProviderActive}` };
    }

    case UserSeriesStatus.DROPPED:
      return { intervalMs: DROPPED_INTERVAL_MS, urgency, reason: 'DROPPED — very low priority, flat interval regardless of urgency' };

    case UserSeriesStatus.COMPLETED: {
      // User finished, but the provider show is still airing/renewed —
      // functionally identical to CAUGHT_UP (waiting on a next episode
      // that hasn't been watched yet because it doesn't exist locally
      // yet), so it gets the exact same near-episode-aware tiers rather
      // than a second, parallel table.
      if (isProviderActive) {
        return { intervalMs: CAUGHT_UP_TIERS[urgency], urgency, reason: `COMPLETED but provider still active — treated like CAUGHT_UP, urgency=${urgency}` };
      }
      return { intervalMs: COMPLETED_PROVIDER_ENDED_MS, urgency, reason: 'COMPLETED and provider show has ended — metadata-only, very low frequency' };
    }

    case UserSeriesStatus.WATCHLIST: {
      const intervalMs = isProviderActive ? WATCHLIST_ACTIVE_MS : WATCHLIST_BETWEEN_SEASONS_MS;
      return { intervalMs, urgency, reason: `WATCHLIST (not yet started), providerActive=${isProviderActive}` };
    }

    // UNKNOWN is excluded from scheduling entirely upstream
    // (isCatalogEligibleStatus / getRefreshIntervalMs both already return
    // "never" for it) — this function should never actually be called for
    // it, but a safe, very-infrequent fallback is returned rather than
    // throwing, matching this codebase's existing defensive posture at
    // policy-table boundaries.
    default:
      return { intervalMs: DROPPED_INTERVAL_MS, urgency, reason: `unrecognized/untracked status ${input.userStatus} — defensive fallback interval` };
  }
}
