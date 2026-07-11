# Watch Next Released-Episode Semantics — TODO

Status legend: `TODO` `IN_PROGRESS` `DONE` `BLOCKED` `DEFERRED`

Scope: Watch Next must only ever expose released, unwatched episodes — as the main episode, in
any count, and as a mark-watchable target — while future episodes stay fully in the catalog.
Systemic fix, not an X-Men '97 patch.

## Phase status overview

| Phase | Status |
|---|---|
| 1 Trace real flow | DONE |
| 2 Canonical released predicate | DONE (no change — reused as-is) |
| 3 Backend Watch Next contract | DONE |
| 4 Preserve catalog knowledge | DONE (verified, no change needed) |
| 5 Feed navigation / mark-watched safety | DONE |
| 6 Date-based activation | DONE (verified, no change needed) |
| 7 Count/display rules | DONE |
| 8 Full-library read-only audit | DONE |
| 9 Tests | DONE |
| 10 Real validation | DONE |

---

## Phase 1 — Trace of the real current flow

1. **Main episode field**: `WatchNextItemDto.nextEpisode`, sourced from `UserSeriesProgress.nextEpisodeId`
   (`me.service.ts::getWatchNext`). Written at every legitimate site via
   `findFirstUnwatchedEpisodeId` (`series-query-helpers.ts`), which already calls
   `isEpisodeReleased`. **Already correctly release-gated** — confirmed, not the bug.
2. **`+N` count field**: `WatchNextItemDto.remainingEpisodesAfterNext`, computed by
   `MeService.getRemainingEpisodesAfterNextBySeriesId` → `computeRemainingEpisodesAfterNext`
   (`me-query-helpers.ts`). **This is the confirmed bug**: the query fetches every `Episode` row
   for the series with zero `airDate` filter and zero watched-status filter
   (`prisma.episode.findMany({ where: { season: { seriesId: {in} } }, select: { id, season } })`),
   then `computeRemainingEpisodesAfterNext` does a pure positional count
   (`orderedEpisodeIds.length - index - 1`) with no awareness of release date or watch state at
   all. Every future episode after `nextEpisodeId` inflates this count.
3. **Does the backend currently return future episodes?** Yes, implicitly, inside this count's
   calculation (not as episode objects, just folded into the number). `nextEpisode` itself never
   exposes a future episode object.
4. **Does the mobile client independently build a queue from the catalog?** No.
   `WatchNextCard.tsx` only ever renders the single `nextEpisode` the server sends plus the
   `remainingEpisodesAfterNext` number, formatted by `getRemainingEpisodesIndicator`
   (`mobile/src/utils/remainingEpisodesIndicator.ts`) — pure display formatting of an
   already-computed number, no episode-list logic on the client. There is no carousel/multi-episode
   navigation on `WatchNextCard` at all today.
5. **Where is release-date filtering missing?**
   - `me-query-helpers.ts::computeRemainingEpisodesAfterNext` / `me.service.ts::getRemainingEpisodesAfterNextBySeriesId` — the `+N` count (confirmed bug, fixed below).
   - `src/modules/episodes/episode-watch.service.ts::markWatched` (`POST /episodes/:episodeId/watch`)
     — **no release-date check at all**. Any episode id, including a far-future one, can be marked
     watched through the normal single-episode endpoint today. Confirmed by direct read — not
     assumed. This is the real server-side gap Phase 5 asks about.
   - `mobile/src/components/EpisodeCard.tsx` (used by `SeriesDetailScreen`'s season/episode list,
     reachable by tapping a Watch Next card → series detail) — the "mark watched" button has no
     release-date-based disabling; every unwatched episode in the full season list, including
     future ones, shows an active mark-watched affordance today.
   - **Not missing**: `watch-all-logic.ts::planWatchAll` (bulk "mark all released") already calls
     `isEpisodeReleased` and buckets future episodes into `skippedFuture` — already correct, no
     change needed. Import tooling (`import-tvtime/normalize-watched-episodes.ts`) does not and
     should not check release date — it's importing real historical watch events, not live user
     action; confirmed as a fully separate write path (`upsertEpisodeWatch`, never calls
     `EpisodeWatchService.markWatched`).

---

## Phase 2 — Canonical released predicate

`src/common/is-episode-released.ts::isEpisodeReleased(airDate, now)`. Existing semantics,
**unchanged, reused everywhere below, not duplicated**:
- past `airDate` → released
- `airDate === now` (exact instant) → released (`<=`)
- future `airDate` → not released
- `null` → not released (conservative — documented existing rule: "no way to tell 'definitely
  already aired, provider just never recorded the date' from 'not aired yet'")

This is already the single source of truth, already reused by `markWatched`'s `findNextEpisode`,
`watch-all-logic.ts`, `unwatch-logic.ts`, `series-query-helpers.ts`, and
`episode-release-refresh/progress-reconciliation-logic.ts`. No new comparison logic is introduced
anywhere in this task — every fix below calls this exact function.

---

## Phase 3 — Backend Watch Next contract fix

`remainingEpisodesAfterNext` is **not renamed** — after this fix it has one unambiguous meaning
(released + unwatched only), so the "avoid ambiguous names for mixed content" concern no longer
applies; renaming would touch the DTO, mobile type, mobile formatter, mobile component prop, and
every existing test for no behavior gain. Its description (Swagger + code comments) is corrected
to state the released-only contract explicitly. Decision recorded here, not left implicit.

`computeRemainingEpisodesAfterNext` now takes the full per-episode data it needs (id, airDate,
watched) instead of bare ids, and counts only `!watched && isEpisodeReleased(airDate, now)` among
episodes strictly after `nextEpisodeId`'s position. `getRemainingEpisodesAfterNextBySeriesId` now
also fetches `EpisodeWatch` for the batch (it didn't before) and accepts an injectable `now`.

---

## Phase 4 — Catalog knowledge preserved

No episode is deleted, hidden from `GET /series/:id`, or excluded from import/enrichment/refresh.
Verified: `SeriesDetailScreen` already lists every known episode (including future ones) via
`GET /series/:id` — unaffected by this task. `episode-release-refresh`, `progress-reconciliation`,
and provider enrichment are untouched by this task's changes (they already use
`isEpisodeReleased`/`findFirstUnwatchedEpisodeId` correctly, per the prior session's work).

---

## Phase 5 — Feed navigation and mark-watched safety

- **Server**: `EpisodeWatchService.markWatched` now rejects (400) a not-yet-released episode
  before creating any `EpisodeWatch` row or touching progress. Import tooling's separate write
  path (`upsertEpisodeWatch`) is untouched — confirmed it never calls this method.
- **Client**: `WatchNextCard`'s mark-watched target is always `nextEpisode`, which is already
  guaranteed released by construction (Phase 1 finding #1) — no change needed there. `EpisodeCard`
  (`SeriesDetailScreen`'s season list, reachable from a Watch Next card tap) now disables its
  mark-watched affordance for a not-yet-released episode, as client-side defense-in-depth on top
  of the server guard — never the only protection.
- No "next/previous"/carousel navigation exists on `WatchNextCard` today (Phase 1 finding #4) — no
  code to fix there; noted rather than invented.

---

## Phase 6 — Date-based activation

No new code needed — `episode-release-refresh/progress-reconciliation-logic.ts`
(previous task) already composes `deriveActiveProgress` → `findFirstUnwatchedEpisodeId` →
`isEpisodeReleased`, unchanged by this task. Once a locally-stored future episode's air date
passes, `run-progress-reconciliation.ts` (dry-run or `--apply`) picks it up exactly as designed —
no provider fetch, no reinsertion required. **Operational dependency unchanged**: still requires a
human-triggered run (no scheduler exists in this app — confirmed absent again this task).

---

## Phase 7 — Count and display rules

`getRemainingEpisodesIndicator` (mobile) is unchanged — it already never renders `+0` (returns
`null` when the count is `0`, distinct from the `'Final episode'` case which is a **different**
signal not used by Watch Next). No display cap (`37+`, `99+`) exists anywhere in the current UI —
verified by reading `remainingEpisodesIndicator.ts` in full; the raw number is rendered as `+N`
with no `Math.min`/cap logic. Not inventing one — reported as a gap, not silently added.

---

## Phase 8 — Full-library read-only audit

New: `watch-next-audit/released-episode-audit-logic.ts` (pure) + `run-released-episode-audit.ts`
(read-only CLI), added alongside the existing `watch-next-audit/` tooling (which covers a
different, catalog-matching-confidence concern — reused its `classifyAirDate`/CLI conventions,
not its issue categories).

**Real run, dev database, 2026-07-11**: 26 Watch Next candidates. `correct`: 12. `future-main-
episode-exposed`: 0 (confirms the main-episode field was never actually broken — Phase 1's
finding holds). `stale-progress-requiring-reconciliation`: 0 (confirms the prior task's progress-
reconciliation apply is holding). `additional-count-includes-future`: **14 of 26 (54%)** — the
real, confirmed blast radius of this bug. Some real examples: Doctor Who (2005) would have shown
`+347`, corrected `+155`; The Big Bang Theory would have shown `+281`, corrected `+1`; Superstore
would have shown `+80`, corrected `0` (hidden per the never-show-`+0` rule). `ambiguous-manual-
review`: 0.

---

## Phase 9/10 — Tests and real validation

Server: 82 suites, 1106 tests (+15 new), `tsc --noEmit` clean. Mobile: 4 suites, 28 tests (+5 new),
`tsc --noEmit` clean, `expo lint` clean.

**Real X-Men '97 validation, live API**: between this task's investigation and its
implementation, the real dev-database user genuinely watched S2E4 (visible via a fresh
`lastWatchedAt`) — X-Men '97 is now correctly `CAUGHT_UP`/no next episode, since S2E5 doesn't
release until 2026-07-15. Rather than fabricate a different state, this was used as a live,
real proof: `POST /episodes/<real S2E5 id>/watch` against the running server → **`400 Bad
Request`**, no `EpisodeWatch` row created, progress unchanged. Confirms Phase 5's server guard on
real data, not a constructed fixture.

**Two other real series, live `GET /home`**:
- `Digimon Beatbreak` (multiple released unwatched: 30 released-unwatched, 2 future) —
  `remainingEpisodesAfterNext: 29` live from the real endpoint, matching the audit's prediction
  exactly.
- `Daemons of the Shadow Realm` (future episodes exist, only one currently released unwatched: 1
  released-unwatched, 10 future) — `remainingEpisodesAfterNext: 0` live from the real endpoint
  (mobile correctly hides this per the existing never-show-`+0` rule), matching the audit exactly.
