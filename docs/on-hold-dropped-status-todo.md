# ON_HOLD / DROPPED Status — Working TODO

Status legend: `TODO` `IN_PROGRESS` `DONE` `BLOCKED` `DEFERRED`

## Critical audit finding (read this first)

**The premise of this task — "ON_HOLD and DROPPED are missing" — is false.** `PAUSED` and `DROPPED`
already exist as first-class `UserSeriesStatus` enum values, already mean exactly what this task
asked for (`PAUSED` = "paused, may continue later" = this task's "ON_HOLD"; `DROPPED` = "abandoned,
not currently planning to continue"), and are already wired through nearly the entire backend:
schema, import mapping, derivation, API validation, an existing status-update endpoint, a
status-filter query param, Continue Watching exclusion, and protection in every automated
pipeline (release refresh, catalog migration, watch-all, unwatch). **53 real series in the live
dev database are already `DROPPED` today**, imported from real TV Time `is_archived` data.

This document proceeds as an audit-and-complete task, not a build-from-scratch task, per the
audit's own instruction: "Do not guess," "record exact files, fields, values, and counts." Every
phase below states what's already done (with evidence) vs. what's a real, confirmed gap.

---

## Phase status overview

| Phase | Description | Status |
|---|---|---|
| 1 | Legacy data audit | DONE |
| 2 | Current status model review | DONE |
| 3 | Add first-class status values | DONE — not needed, already exist |
| 4 | Status transition rules | DONE — resume-derivation bug fixed, verified against real dev-DB data |
| 5 | Preserve watch history / progress | DONE — nextEpisodeId-preservation bug fixed, verified against real dev-DB data |
| 6 | Continue Watching behavior | DONE — already correct, verified |
| 7 | Watchlist filters | DONE — `LibraryScreen` filter UI (pre-existing) + label fix (`PAUSED` → "On hold") |
| 8 | Series-page actions | DONE — options menu added to `SeriesDetailScreen` |
| 9 | Backend status update API | DONE — Phase 4/5 bug fixes applied to the existing endpoint |
| 10 | Status derivation / automated processes | DONE — already correctly protected, verified across every pipeline |
| 11 | Recover legacy statuses | DONE — DROPPED already backfilled from real data (53 series); PAUSED has no recoverable source, correctly left unset |
| 12 | UI details | DONE — label override, theme tokens confirmed already correct (no new colors needed) |
| 13 | Tests | DONE — see final report for exact counts |
| 14 | Full validation | DONE — real dev-DB series exercised through pause/drop/resume round trips, verified via API, all restored to original state afterward |

---

## Phase 1 — Legacy data audit

**Source**: `server/import-tvtime/normalize-watched-episodes.ts` (Phase 2 of the TV Time
importer), driven by `docs/status-model-plan.md` §5, applied against
`tracking-prod-records-v2.csv` `user-series-*` rows.

**Findings, from live code (lines ~185-235 of `normalize-watched-episodes.ts`) and a live DB
query against the dev database** (`docker compose ps` confirms `my-tv-postgres` running; query run
via a throwaway `ts-node` script, read-only `groupBy` on `UserSeriesProgress.userStatus`):

1. **Did the original source contain these statuses?**
   - `dropped` (this task's "DROPPED"): **yes** — TV Time's `is_archived` flag.
   - `paused` (this task's "ON_HOLD"): **no** — confirmed directly in `status-model-plan.md` §4/§5
     and in the importer's own code comment: "`paused` is never set by import — there is no TV
     Time source for it." TV Time has no pause/hold concept anywhere in the export.
2. **Exact source values**: `is_archived = true` on a `user-series-*` row in
   `tracking-prod-records-v2.csv` → `userStatus = DROPPED` (any watched-episode count).
   `is_archived = true`, zero watched episodes, not `is_for_later` → no row created (no real
   relationship to record).
3. **Intentionally omitted, accidentally unmapped, or collapsed?** Not omitted or accidental —
   `is_archived` → `DROPPED` is live, current importer behavior (not a stale/planned-only doc
   claim — read directly from the running code). `paused` was never collapsed into anything; there
   is genuinely no TV Time signal for it, by design, confirmed in the doc's own risk section (§10:
   "Some fraction of series currently sitting at `watching` are, realistically, shows the user
   quietly stopped caring about... This model doesn't try to guess that").
4. **Can the original status still be recovered reliably for existing series?** `DROPPED`: yes,
   already recovered (see live counts below). `PAUSED`/on-hold: no — there is no reliable source
   to recover from, for any already-imported series. Guessing "quietly abandoned" from staleness
   would be exactly the kind of invented status this project's stale-series work has already
   rejected elsewhere.
5. **How many real current series are affected?** Live query, dev DB, 2026-07-11:
   ```
   WATCHING:   115
   COMPLETED:  165
   DROPPED:     53
   WATCHLIST:    3
   CAUGHT_UP:   57
   PAUSED:       0
   (total Series rows: 430)
   ```
   53 real series are already `DROPPED` from the real import. Zero are `PAUSED` — expected, since
   nothing has ever had a UI path to set it (see Phase 8).
6. **Is there enough evidence to backfill automatically?** For `DROPPED`: the backfill already
   happened, as part of the live importer, not something this task needs to perform. For `PAUSED`:
   no — there is no evidence to backfill from at all. Recommendation, per the task's own instruction
   ("If no reliable source exists, do not invent statuses"): leave every existing series' status
   exactly as-is; `PAUSED`/on-hold only ever becomes populated going forward, via the explicit user
   action this task is adding UI for (Phase 8).

**Conclusion**: no backfill work is needed or safe to perform in this task. `DROPPED` backfill is
already complete and live. `PAUSED` backfill is correctly impossible and is not attempted.

---

## Phase 2 — Current status model review

Traced end to end, live code (not the design doc alone — every claim below re-verified against
the file it describes):

- **Schema**: `prisma/schema.prisma` — `enum UserSeriesStatus { UNKNOWN WATCHLIST WATCHING PAUSED
  DROPPED CAUGHT_UP COMPLETED }`. All 7 values already present.
- **Derivation**: `src/common/derive-user-status.ts::deriveUserStatusFromNextEpisode(hasNext,
  releaseStatus)` — the one shared function every write path uses (or should use — see Phase 4 bug).
- **Import**: `import-tvtime/normalize-watched-episodes.ts` — `is_archived` → `DROPPED`,
  `is_for_later` (unwatched) → `WATCHLIST`, watched/not-archived → `WATCHING` placeholder. Never
  touches an existing row whose status the importer itself wouldn't have set (re-import safe).
- **markWatched** (`src/modules/episodes/episode-watch.service.ts`): always overwrites
  `userStatus` via `deriveUserStatusFromNextEpisode` on every watch — **by deliberate, documented
  design** (`status-model-plan.md` §2: "A fresh user action is the strongest signal available and
  wins immediately... clears `paused`/`dropped` without requiring a separate resume action").
  This is today's real UX for single-episode marking and is preserved unchanged (see Phase 10).
- **watch-all** (`src/common/watch-all-logic.ts`, `POST /seasons/:id/watch-all`,
  `POST /series/:id/watch-all-released`): `checkWatchAllAllowed` blocks with a 400 when current
  status is `DROPPED`/`PAUSED` unless `force=true` is passed; once forced, status is unconditionally
  re-derived (no partial-preservation option) — a different, stricter policy than markWatched's
  auto-resume, deliberately, since a bulk action is a bigger side effect than one episode.
- **unwatch** (`src/common/unwatch-logic.ts`): the opposite direction — `PROTECTED_STATUSES`
  (`DROPPED`/`PAUSED`) are never touched by an unwatch's status recompute at all (`statusPreserved:
  true`), regardless of force — force there only concerns attached note/rating data, never status.
- **Manual status API**: `PATCH /series/:seriesId/status`
  (`src/modules/series/{series.controller,series.service}.ts`,
  `dto/update-series-status.dto.ts`) — already exists, already accepts exactly
  `WATCHING | PAUSED | DROPPED | WATCHLIST` (`MANUAL_USER_STATUSES`, validated via `@IsIn`),
  rejects `CAUGHT_UP`/`COMPLETED`/`UNKNOWN` (400) since those must stay auto-derived. Transactional,
  keeps `WatchlistItem` in sync. **Two real bugs found here — Phase 4/5 below.**
- **List/filter API**: `GET /series?status=` already accepts any `UserSeriesStatus` including
  `PAUSED`/`DROPPED` (`series.controller.ts` `@ApiQuery` enum list already includes them;
  `series-query-helpers.ts::buildLibraryWhere` filters on it directly).
- **Continue Watching** (`src/modules/me/me.service.ts::getWatchNext`): exact-match filter
  `userStatus: UserSeriesStatus.WATCHING` — an include-list, not an exclude-list, so `PAUSED`/
  `DROPPED`/`CAUGHT_UP`/`COMPLETED` are excluded by construction, already correct, needs no change.
- **Automated pipelines**:
  - `episode-release-refresh/refresh-logic.ts::TRACKED_USER_STATUSES = [WATCHING, CAUGHT_UP,
    COMPLETED]` — `PAUSED`/`DROPPED` are simply absent, so refresh never touches them, already correct.
  - `library-health/migration-confirmation-logic.ts::PROTECTED_MIGRATION_STATUSES`,
    `library-health/health-logic.ts`, `library-health/migration-policy-logic.ts` — `DROPPED`/`PAUSED`
    always win over any migration/reconciliation decision, already correct, already tested.
  - `src/common/derive-user-status.ts::proposeUserStatusAfterEnrichment` — `PROTECTED_USER_STATUSES`
    (`DROPPED`/`PAUSED`) never overridden by the enrichment dry-run preview, already correct.
- **Mobile**:
  - `mobile/src/api/endpoints/series.ts::updateSeriesStatus()` — fully typed client function
    already exists, calls the real endpoint. **Comment in the file literally says "Not called by
    any screen yet."** This is the real, confirmed gap (Phase 8).
  - `mobile/src/screens/LibraryScreen.tsx` — pre-existing, **uncommitted**, not part of any prior
    session in this conversation — already implements a status-filter tab bar
    (`WATCHING/CAUGHT_UP/COMPLETED/PAUSED/DROPPED`) against `GET /series?status=`, already wired
    into `TabNavigator.tsx` as a live "Library" tab. This substantially satisfies Phase 7's filter
    requirement already, as a dedicated screen rather than changes to `WatchlistScreen` (correctly
    keeping `WatchlistScreen` un-redesigned, matching this task's own restriction) — needs a label
    wording fix only (`PAUSED` → "On hold" instead of the generic "Paused").
  - `mobile/src/components/StatusBadge.tsx` / `utils/format.ts::formatStatusLabel` — already
    renders any status string as a colored pill; `DROPPED` already reads "Dropped" (matches this
    task's suggested label exactly); `PAUSED` reads "Paused" (needs the "On hold" override).
  - `mobile/src/screens/SeriesDetailScreen.tsx` — already shows a `StatusBadge` for `userStatus`.
    **No action menu of any kind exists** — no way to actually change status from the app. This is
    the single largest real gap in the whole task.
  - **No localization/i18n system exists anywhere in mobile** (confirmed in a prior session's
    audit of this same codebase, re-confirmed by grep here) — every UI string in the app is
    hardcoded English (`"Watched"`, `"Caught up"`, etc.). Phase 12's Hebrew-localization
    instructions are therefore moot for this pass; English-only labels are used, consistent with
    the rest of the app, and this is stated plainly rather than inventing a translation layer that
    doesn't exist anywhere else.

**Assumptions identified** (matches the task's Phase 2 ask):
- `WATCHING` = active + visible in Continue Watching. Confirmed, unchanged.
- `COMPLETED` = no next episode + series releaseStatus is ended/cancelled. Confirmed, unchanged.
- `CAUGHT_UP` = active (no next episode yet, but show is ongoing) — **explicitly treated as an
  active state** by `TRACKED_USER_STATUSES` and by "Haven't Watched For A While"'s include-list,
  but is **excluded** from the strict Watch Next list (`getWatchNext`'s exact `WATCHING` filter) —
  this exact nuance is why Phase 6 says "or whatever active statuses the app already includes":
  the app's own existing behavior is Watch Next = `WATCHING`-only, `CAUGHT_UP` shows up in
  "Haven't Watched For A While" instead. Preserved unchanged (task explicitly says to preserve
  existing `CAUGHT_UP` behavior unless there's a clear bug — there isn't one).

---

## Phase 3 — Add first-class status values

**Not needed.** Both values already exist in `prisma/schema.prisma`, already migrated into the
live database (`PAUSED`/`DROPPED` are real enum members in Postgres today — the enum itself, not
just Prisma's generated types). No migration will be created. Adding a second, differently-named
pair of enum values (literal `ON_HOLD`) would violate Phase 3's own instruction to "use existing
naming conventions" and would fragment the status model the rest of the backend already
consistently protects. **Decision: reuse `PAUSED` as this task's "ON_HOLD," display it to users as
"On hold."** Recorded here explicitly since it's a real judgment call, not a default.

---

## Phase 4 — Status transition rules

Status: DONE. Fixed, tested (`series-query-helpers.test.ts`, 9 new/updated cases), and verified
live: paused "A Knight of the Seven Kingdoms" (real dev-DB series, `CAUGHT_UP`/`nextEpisode: null`
before), then resumed it (`PATCH .../status {userStatus: WATCHING}`) — came back `CAUGHT_UP`, not
`WATCHING`. Restored to its original state afterward, zero residual change.

Existing `deriveManualStatusUpdate` (`series-query-helpers.ts`) already implements every
transition in principle (client sends the target `userStatus`, endpoint validates it's one of
`MANUAL_USER_STATUSES`), **except one real bug**:

**Bug found**: when a client requests `userStatus: 'WATCHING'` (the "Resume watching" action from
`PAUSED`/`DROPPED`), `deriveManualStatusUpdate` **always** writes literal `WATCHING` with a freshly
computed `nextEpisodeId` — it never checks whether the correct derived state is actually
`CAUGHT_UP` or `COMPLETED` (e.g. resuming a series where every released episode is already
watched, but the show is still airing → should become `CAUGHT_UP`, not `WATCHING`). This is
exactly the bug the task's Phase 4 explicitly warns against: "Do not blindly force WATCHING if the
correct derived status is CAUGHT_UP or COMPLETED."

**Fix**: `TODO` → `DONE` (see below) — reuse `deriveUserStatusFromNextEpisode` (the same function
`markWatched` already uses) inside the `WATCHING`-requested branch, instead of hardcoding
`WATCHING`. Requires fetching `Series.releaseStatus` alongside the episode catalog in that branch
(currently not fetched there).

`COMPLETED` (from the task's "evaluate existing product behavior" instruction): the app has no UI
concept of manually setting `COMPLETED` at all (rejected by `MANUAL_USER_STATUSES`, by design — a
client can't claim "I've watched everything" without the server verifying it). From `COMPLETED`,
the only sensible manual actions are the same ones as from `CAUGHT_UP`: put on hold, drop. Resuming
from `COMPLETED` isn't a real product concept (there's nothing left to resume) and is out of scope —
not added.

From `CAUGHT_UP`: treated as active per Phase 2's finding — actions: Put on hold, Drop series.

---

## Phase 5 — Preserve watch history and progress

Status: DONE. Fixed, tested, and verified live: paused real dev-DB series "A Certain Scientific
Railgun" (`WATCHING`, next episode S3E1) — `nextEpisode` stayed S3E1 after pausing (previously
would have gone `null`). Resumed it — came back `WATCHING` with the same S3E1. Restored to its
original state afterward.

Everything in the task's "must never" list is already safe **except one real bug**:

**Bug found**: `deriveManualStatusUpdate`'s non-`WATCHING` branch returns
`{ userStatus: input.userStatus, nextEpisodeId: null }` for every other status, including
`PAUSED`/`DROPPED` — it **nulls `nextEpisodeId`** on pause/drop instead of preserving it. This
directly contradicts this task's explicit preferred behavior ("keep `nextEpisodeId` accurate
internally... excludes the title from active Continue Watching presentation"). It doesn't cause
data loss (resuming still works, since the `WATCHING` branch recomputes from scratch, and paused/
dropped series are already excluded from episode-release-refresh so nothing else would have kept
it fresh anyway) — but it's an unnecessary loss of a value the app already had correctly computed,
and it means a moment-of-pause snapshot isn't preserved. **No data-model difficulty prevents
fixing this** — it's a one-line logic change (carry forward the row's current `nextEpisodeId`
instead of overwriting with `null`, specifically for `PAUSED`/`DROPPED`).

**Fix**: `TODO` → `DONE` (see below) — pass the current `nextEpisodeId` into
`deriveManualStatusUpdate` and preserve it verbatim for `PAUSED`/`DROPPED`. `WATCHLIST` keeps its
existing null-out behavior unchanged (out of this task's scope; a watchlisted series is normally
un-started anyway).

Everything else already verified safe with no code change needed: `EpisodeWatch` rows are never
touched by any status-update path (confirmed by reading every write site above); watched orphan
rows carry their own `importBatchId`/watch history untouched by any status write; no catalog
row is touched by `updateStatus`; ratings/emotions are keyed independently of `userStatus` and
untouched.

---

## Phase 6 — Continue Watching behavior

Status: DONE, verified, no change needed.

`getWatchNext` (`me.service.ts`) filters `userStatus: UserSeriesStatus.WATCHING` exactly —
`PAUSED`, `DROPPED`, `CAUGHT_UP`, `COMPLETED`, `WATCHLIST`, `UNKNOWN` are all excluded by
construction (an include-list on one value, not an exclude-list), already covered by
`me-query-helpers.test.ts`. Mobile's `HomeScreen`/`WatchNextCard` render exactly what `/home`
returns — no client-side re-filtering to check or fix. No entry point (backend query, API,
frontend, cache) needs any change for this phase.

---

## Phase 7 — Watchlist filters

Status: DONE. Label fix applied (`mobile/src/utils/format.ts`'s `formatStatusLabel`, override map)
— `PAUSED` now reads "On hold" everywhere it's shown (`StatusBadge`, `LibraryScreen`'s filter
pills), `DROPPED` unchanged ("Dropped," already correct). Verified live: paused/dropped series
correctly appear via `GET /series?status=PAUSED` / `?status=DROPPED` (real dev-DB check above).

`mobile/src/screens/LibraryScreen.tsx` (pre-existing, uncommitted) already provides exactly this:
a filter tab bar over `GET /series?status=`, covering `WATCHING/CAUGHT_UP/COMPLETED/PAUSED/DROPPED`,
wired into the tab bar as its own "Library" screen — deliberately not a redesign of the classic
`WatchlistScreen` (which stays querying `WatchlistItem` per `status-model-plan.md` §4/§8, unchanged,
per this task's own "do not redesign Watchlist" restriction). Only gap: filter pill labels use the
generic `formatStatusLabel`, so `PAUSED` reads "Paused" instead of this task's desired "On hold."
`DROPPED` already reads "Dropped," matching exactly.

**Fix**: `TODO` → `DONE` (see below) — a small `UserSeriesStatus`-specific label map (only for the
one differing value) so `PAUSED` reads "On hold" everywhere it's user-facing, without changing
`formatStatusLabel`'s generic behavior (still used for `ReleaseStatus` and other enums elsewhere).

---

## Phase 8 — Series-page actions

Status: DONE. `mobile/src/utils/seriesStatusActions.ts` (pure, 9 tests) + wiring in
`SeriesDetailScreen.tsx` — a "⋯" options button (hidden entirely for `WATCHLIST`/`UNKNOWN`, which
have no on-hold/drop concept) opens a native `Alert.alert` action list built from the current
status. "Drop series" confirms first (reusing the screen's existing `confirmAsync` helper); "Put
on hold"/"Resume watching" fire immediately. On success, the cached `SeriesDetail` is patched in
place and Home/Watchlist/Library queries are invalidated.

No options menu of any kind exists on `SeriesDetailScreen`. Plan:
- Small "..." (options) button in the header, opens an `Alert.alert`-based action sheet (same
  pattern this screen and this codebase already use everywhere else — `confirmAsync`,
  `Alert.alert` for "Mark as unwatched?", force-required flows — not a new UI primitive).
- Menu contents driven by current `userStatus`, per the task's exact table.
- "Drop series" gets a lightweight confirmation (same `confirmAsync` pattern as "Mark as
  unwatched?"); "Put on hold" and "Resume watching" fire immediately, no confirmation — matches
  the task's preferred behavior and this app's existing confirmation conventions (destructive-ish/
  hard-to-reverse-feeling actions get one confirm step, routine ones don't).
- Copy avoids any "delete/remove history" language — "Drop series" / "Put on hold" / "Resume
  watching" only.
- On success: update the cached `SeriesDetail` in place (same `queryClient.setQueryData` pattern
  already used by `applyUnwatchResult`) plus invalidate `home`/`watchlist`/`seriesList` query keys
  so Continue Watching, Watchlist, and Library all reflect the change without a manual refresh.

---

## Phase 9 — Backend status update API

Status: DONE — endpoint reused as-is (no new endpoint). Already authenticated (dev-user
middleware, same as every other endpoint), already validates the series exists, already
transactional, already rejects unsupported values (`@IsIn`). The Phase 4/5 bug fixes are inside
`deriveManualStatusUpdate` and `series.service.ts::updateStatus`'s data-fetching, not the
endpoint's shape/contract, which is unchanged (only its doc comments were corrected to describe
the fixed behavior accurately — see `series.controller.ts`,
`dto/update-series-status-response.dto.ts`).

---

## Phase 10 — Status derivation and automatic processes

Status: DONE, verified across every automated writer, no change needed.

| Process | File | Behavior |
|---|---|---|
| Provider migration (Pipeline A) | `library-health/migration-confirmation-logic.ts`, `migration-policy-logic.ts` | `PROTECTED_MIGRATION_STATUSES = [DROPPED, PAUSED]` always wins, never overridden, even with an explicit `statusOverride` |
| Catalog health checks | `library-health/health-logic.ts` | Same protected set |
| Episode release refresh (Pipeline B) | `episode-release-refresh/refresh-logic.ts` | `TRACKED_USER_STATUSES` excludes `PAUSED`/`DROPPED` entirely — never even considered |
| Enrichment dry-run preview | `src/common/derive-user-status.ts::proposeUserStatusAfterEnrichment` | `PROTECTED_USER_STATUSES` never overridden |
| Mark episode watched (single) | `episode-watch.service.ts::markWatched` | **Always** overwrites/clears `PAUSED`/`DROPPED` — deliberate, documented, existing policy (see below) |
| Mark all released (bulk) | `watch-all-logic.ts::checkWatchAllAllowed` | Blocked (400) unless `force=true`; once forced, unconditionally re-derived |
| Unwatch | `unwatch-logic.ts` | `PAUSED`/`DROPPED` never touched at all, force or not |
| Import (re-run) | `normalize-watched-episodes.ts` | Never overwrites a status the importer itself wouldn't have set |

**The "mark watched while paused/dropped" policy decision, made explicit per the task's
instruction not to leave this implicit**: this app already has **two different, both deliberate,
both already-shipped policies**, depending on the action's blast radius:
- **Single-episode watch → auto-resumes** (policy 1 from the task's list). This is
  `status-model-plan.md`'s core, explicitly-reasoned design principle (§2, §6): a real watch event
  is unambiguous proof of current engagement, stronger evidence than a resume button. **Kept
  unchanged** — this is a pre-existing, deliberate product decision, not something this task
  asked to redesign, and reversing it would contradict the task's own "verify against existing
  UX" instruction, since the existing UX already made and documented this exact choice.
- **Bulk "mark all released" → blocked, requires explicit `force=true`** (closer to policy 3,
  "prompt the user" — mobile's existing `runWatchAll` flow already prompts via `confirmAsync` when
  this 400 fires). **Kept unchanged** — also pre-existing and deliberate, and appropriately
  stricter than a single episode tap given the larger blast radius.

This is reported here rather than silently picked, per the task's explicit instruction — no code
change was made to either policy; both were audited and confirmed intentional.

---

## Phase 11 — Recover legacy statuses

Status: DONE. See Phase 1 — `DROPPED` is already recovered and live (53 series, real import data).
`PAUSED` has no recoverable source and is correctly left unset. No backfill script is written or
run in this task; none is needed or safe (there is nothing ambiguous to dry-run — the importer's
own live behavior already is the backfill, and it already ran during the original import).

---

## Phase 12 — UI details

Status: DONE.

- Labels: "On hold" (`PAUSED`), "Dropped" (`DROPPED`, already correct) — via a small
  `UserSeriesStatus`-specific override in `formatStatusLabel`, not a new i18n system (none exists
  in this app — see Phase 2 finding).
- Colors: `StatusBadge`/`theme/statusColors.ts` already had sensible, restrained, existing-theme-
  token colors for both (`PAUSED` → warning/amber, `DROPPED` → danger/red) — checked, no change
  needed.
- No new visual chrome beyond the badge that already existed and the new "⋯" options button +
  native `Alert.alert` menu (reusing existing patterns, no new custom component).

---

## Phase 13 — Tests

Status: DONE.
- `series-query-helpers.test.ts`: `deriveManualStatusUpdate` rewritten with 9 cases (both fixed
  behaviors + regression coverage), all existing tests in this file still green.
- Mobile: `seriesStatusActions.test.ts` (9 cases — transition table, "never offers current status,"
  confirmation-required-only-for-drop, no-destructive-copy) — no `Alert` mocking needed at all,
  since the menu-building/confirmation-requirement logic is pure and tested directly.
- Full suite re-run, zero regressions:
  - Server: `npx jest` — **78 suites, 1067 tests, all passing**. `npx tsc --noEmit` clean.
  - Mobile: `npx jest` — **3 suites, 23 tests, all passing**. `npx tsc --noEmit` clean.
    `npm run lint` (`expo lint`) — clean, no warnings/errors.

---

## Phase 14 — Full validation

Status: DONE — against real dev-DB data (not fixtures; this is the project's existing shared
local dev database, same one every other task in this repo uses), read-only-safe round trips that
restored every touched row to its exact original state:

1. **"A Certain Scientific Railgun"** (real, `WATCHING`, next episode S3E1): paused →
   `nextEpisode` correctly preserved (S3E1, not nulled) → confirmed absent from `/home`'s
   `watchNext` while paused → confirmed present in `GET /series?status=PAUSED` → resumed →
   correctly back to `WATCHING` with the same S3E1 → confirmed present in `/home` again (as
   `staleSeries`, per its real `lastWatchedAt` — pre-existing, correct, unrelated-to-this-task
   behavior, not a regression).
2. **"A Knight of the Seven Kingdoms"** (real, `CAUGHT_UP`, `nextEpisode: null`, `releaseStatus:
   RETURNING`): paused → resumed → **correctly came back `CAUGHT_UP`, not `WATCHING`** — this is
   the live, real-data proof of the Phase 4 bug fix.
3. **"Andor"** (real, `DROPPED` from the original TV Time `is_archived` import, one of the 53):
   put on hold → dropped again — round-tripped cleanly, confirming `DROPPED`↔`PAUSED` transitions
   work on a genuinely legacy-imported row, not just a freshly-created one.

All three rows verified back to their pre-test state via a final `GET /series/:id` read after each
round trip. No fixture/test-user infrastructure exists in this project for this kind of check
(matching this repo's established pattern of validating against the real dev DB with careful
before/after reads — see `docs/stable-version-migration-todo.md`'s batch-apply validations for the
same convention), so this followed that precedent rather than introducing a new one.

---

## Unresolved risks (tracked, not hidden)

- The single-episode-watch-auto-resumes vs. bulk-requires-force asymmetry (Phase 10) is
  intentional and pre-existing, but is worth the user's awareness — if this ever feels
  inconsistent in practice, it's a one-line policy change in `markWatched`, not a redesign.
- `LibraryScreen.tsx`/`TabNavigator.tsx` changes are pre-existing uncommitted work from before
  this task, not yet reviewed/tested by this task's author — this task treats them as real,
  already-shipped-enough-to-build-on UI, fixes their one real label gap, but does not otherwise
  audit their unrelated correctness (out of this task's scope).
