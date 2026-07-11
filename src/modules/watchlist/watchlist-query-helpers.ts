// Pure helpers for WatchlistService — no Prisma calls, no I/O — same
// pattern as series-query-helpers.ts/me-query-helpers.ts.

import { Prisma, UserSeriesStatus } from '@prisma/client';
import { hasConfirmedExternalId, ExternalIdsForConfirmationCheck } from '../../common/has-confirmed-external-id';

// The Watchlist tab's product definition: the user's ACTIVE, TRUSTWORTHY
// tracking list — currently watching, actively following while waiting for
// new episodes, or planning to start. Explicitly NOT the user's entire
// collection (PAUSED/DROPPED/COMPLETED/UNKNOWN stay in the Library tab
// only). Order here is also the fixed section-render order the mobile
// client groups into (see mobile/src/utils/groupWatchlistItems.ts) —
// Watching, then Caught Up, then Watchlist.
export const WATCHLIST_TAB_STATUSES: UserSeriesStatus[] = [
  UserSeriesStatus.WATCHING,
  UserSeriesStatus.CAUGHT_UP,
  UserSeriesStatus.WATCHLIST,
];

// Statuses whose derivation MUST be trustworthy to appear on the Watchlist
// tab — both are a claim about the (possibly incomplete) local episode
// catalog: "there IS a next episode" (WATCHING) or "there ISN'T one yet"
// (CAUGHT_UP). WATCHLIST makes no such claim ("not started yet" is true
// regardless of catalog completeness), so it's deliberately excluded from
// this list and never gated. See docs/watchlist-redesign-todo.md §1/§4/§6
// for the real-DB audit that found 81/105 (77%) of stored WATCHING rows had
// no confirmed provider match — an unconfirmed import-time default being
// displayed as if it were live derived truth, not an actual bug in
// deriveActiveProgress itself (which was independently verified correct
// for every confirmed-match series).
const STATUSES_REQUIRING_CONFIRMED_MATCH: UserSeriesStatus[] = [UserSeriesStatus.WATCHING, UserSeriesStatus.CAUGHT_UP];

// The Watchlist tab's query: every UserSeriesProgress row for this user
// whose status is one of WATCHLIST_TAB_STATUSES. Deliberately keyed off
// UserSeriesProgress (the authoritative "what's my status" source, per
// docs/status-model-plan.md) rather than WatchlistItem — a series that was
// once explicitly added to the watchlist but has since moved to PAUSED/
// DROPPED/COMPLETED must NOT appear here anymore, which a WatchlistItem-
// based query could never express (WatchlistItem rows are permanent
// provenance records, never removed just because status moved on).
//
// This is a status-only prefilter — the confirmed-provider-match trust gate
// (isWatchlistTabEligible below) is applied in application code after the
// query, reusing hasConfirmedExternalId (the exact same predicate
// needs-attention-logic.ts uses) rather than re-expressing "confirmed
// match" a second time as a raw Prisma relation filter, which would let the
// two definitions silently drift apart.
export function buildWatchlistTabWhere(userId: string): Prisma.UserSeriesProgressWhereInput {
  return { userId, userStatus: { in: WATCHLIST_TAB_STATUSES } };
}

export interface WatchlistTabEligibilityInput {
  userStatus: UserSeriesStatus;
  externalIds: ExternalIdsForConfirmationCheck | null;
}

// The trust gate: a WATCHING/CAUGHT_UP row only belongs on the Watchlist
// tab if its series has a confirmed provider match — otherwise the status
// is an unverified import-time artifact, not something MyTV can actually
// stand behind as "currently watching" or "caught up." WATCHLIST rows are
// always eligible (see STATUSES_REQUIRING_CONFIRMED_MATCH above).
export function isWatchlistTabEligible(input: WatchlistTabEligibilityInput): boolean {
  if (!STATUSES_REQUIRING_CONFIRMED_MATCH.includes(input.userStatus)) {
    return true;
  }
  return hasConfirmedExternalId(input.externalIds);
}
