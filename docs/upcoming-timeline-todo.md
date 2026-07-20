# Upcoming Timeline — TODO / Worklog

**Status as of this writing: Phase 1–2 (investigation + design) complete. Implementation starting.**

This is a live working document for the "Upcoming" feature (a second top-level mode —
WATCH LIST / UPCOMING — inside the existing Watchlist tab, showing a chronological personal
release timeline: what was released, what releases today, what releases next). Keep this file
updated as work progresses. Do not delete at the end of the session.

This feature spans both `server/` and `mobile/` (two separate git repos under the `my-tv/` root —
see `mobile/CLAUDE.md`). This doc lives in `server/docs/` per that repo's convention for
cross-cutting `*-todo.md` worklogs (e.g. `stable-version-migration-todo.md`), but covers both sides.

---

## Phase tracker

- [x] Phase 1 — Investigation
- [x] Phase 2 — Design decisions
- [ ] Phase 3 — Backend API (pure logic + service + controller + tests)
- [ ] Phase 4 — Mobile mode switch + Upcoming timeline UI
- [ ] Phase 5 — Bidirectional scrolling + Today anchor + cache integration
- [ ] Phase 6 — Watched mutations + refresh + date rollover
- [ ] Phase 7 — Tests, validation, final report

---

## Phase 1 — Investigation findings

### Repo/module layout
- `server/`: NestJS + Prisma/Postgres. Feature modules under `src/modules/*`; each has an
  `*-query-helpers.ts` (pure logic, no I/O, unit tested) + a `*.service.ts` (Prisma calls) +
  `*.controller.ts` (routes) + `dto/`. Personal/cross-series derived views (recently-watched,
  watch-next, stale-series, havent-started-yet) all live in the **`me` module**
  (`src/modules/me/{me.controller,me.service,me-query-helpers}.ts`) — Upcoming follows this
  precedent as `GET /me/upcoming` rather than a new module.
- `mobile/`: Expo/RN 0.81.5 + TanStack Query v5 + React Navigation v7. **Correction to an earlier
  version of this doc**: an initial grep for `FlatList`/`SectionList` usage silently failed (a zsh
  glob quirk with `--include=*.tsx`, returning "no matches" instead of erroring) and led to a wrong
  claim here that no screen used either. Re-verified directly: `HomeScreen.tsx` **does** use
  `FlatList` — but only for small, non-paginated **horizontal rails** nested inside a `ScrollView`
  (Recently Watched / Haven't Watched For A While / Haven't Started Yet), not a full-screen,
  vertically virtualized, bidirectionally-paginated timeline. `WatchlistScreen`/`LibraryScreen` are
  still plain `ScrollView`s. The real conclusion stands: **no existing screen needs (or has) a
  `SectionList`, and none does bidirectional infinite-scroll pagination** — Upcoming is genuinely the
  first of that kind in this app, it just isn't literally the first `FlatList` usage. RN 0.81.5
  supports `onStartReached` + `maintainVisibleContentPosition` (stable prepend) on both
  `FlatList`/`SectionList`, so no new native/gesture library is needed either way.
- The "Shows" tab referenced in the task is the **Watchlist tab** (`WatchlistScreen.tsx`, tv icon)
  — not the Home tab (Watch Next / dashboard). Confirmed by its doc comment: "The Watchlist tab
  represents the user's ACTIVE, TRUSTWORTHY tracking list."

### Data model (server/prisma/schema.prisma)
- `Series.releaseStatus` (`ReleaseStatus`): `UNKNOWN | RETURNING | ENDED | CANCELLED | IN_PRODUCTION`
  — provider-derived public fact, never user-editable.
- `UserSeriesProgress.userStatus` (`UserSeriesStatus`): `UNKNOWN | WATCHLIST | WATCHING | PAUSED |
  DROPPED | CAUGHT_UP | COMPLETED` — personal fact, one row per (user, series).
- `Episode.airDate: DateTime?` — **the only air-date field that exists**. Nullable. No time-of-day
  field, no timezone field, anywhere in the schema.
- `EpisodeWatch` — one row per (user, episode) watched; `watchSource: SINGLE | BATCH` (BATCH =
  "mark all released" escape hatch, hidden from Recently Watched but otherwise normal).
- Season 0 = "Specials" convention (`isCanonicalSeason` = `seasonNumber > 0`), already used
  throughout progress/next-episode derivation to exclude specials from *derived* progress (not from
  display — they still show on SeriesDetail).

### Release-date / time-of-day reality (critical finding)
- `server/src/common/release-date-policy.ts` (extensively commented) is the **existing, canonical**
  policy: TMDb/TVmaze only ever supply `air_date` as a bare `"YYYY-MM-DD"` string, **no time of
  day, no timezone**. `parseProviderDateOnly` parses it as UTC midnight of that date — deliberate,
  already the whole app's standing convention (every existing call site does this).
- **No provider integrated in this codebase supplies episode time-of-day.** TMDb is the only
  *production* provider (writes to the DB). TVmaze exists only in `secondary-provider-audit/`
  (report-only, never applied) and Trakt has no apply step (OAuth blocked). Neither TMDb's nor
  TVmaze's episode payload includes a time field in this codebase's clients.
- **Conclusion: "known release time" cannot be reliably populated today.** The task requires
  implementing the nullable architecture and fallback correctly without fabricating data — see
  Design §Release time below for exactly how this is done with zero new DB columns.
- `isEpisodeReleased(airDate, now)` (`src/common/is-episode-released.ts`) is the **one canonical
  "is this out yet" predicate**, reused by `markWatched`, `findFirstUnwatchedEpisodeId`,
  `watch-all-logic`, mobile's `episodeRelease.ts` mirror, etc. Upcoming reuses this exact predicate
  for watch-button eligibility — never a second "is it released" rule.

### Status/eligibility precedent
- `docs/status-model-plan.md` is authoritative for what each `userStatus` means and where it comes
  from. Key facts used for Upcoming's eligibility rule (see Design below):
  - `WATCHING`/`CAUGHT_UP` are only trustworthy after a confirmed provider match for some purposes
    (Watchlist tab gates on this — `isWatchlistTabEligible`/`hasConfirmedExternalId`). Upcoming does
    **not** need this extra gate — see Design §Eligibility for why.
  - `deriveHavenStartedYetCandidates` (`me-query-helpers.ts`) is the existing precedent for "series
    added before/without having started" (`WATCHLIST` + zero watches + ≥1 released regular episode)
    — confirms this exact product concept ("series not yet started even though released episodes
    exist") already has a home in this app's model; Upcoming's eligibility generalizes it across all
    dates instead of just "latest released."
  - `docs/on-hold-dropped-status-todo.md` / `status-model-plan.md` §12: `PAUSED` is the real enum
    value behind the product label "On hold" (see mobile `format.ts`'s `STATUS_LABEL_OVERRIDES`).

### Pagination precedent (`API_CONTRACT.md` §"Cursor pagination")
- Two existing shapes: `GET /me/recently-watched` (`before` cursor, opaque base64 wrapping an
  `EpisodeWatch.id`) and `GET /series` (`cursor`, wraps a `Series.id`). Both implemented via
  `encodeCursor`/`decodeCursor` (`src/common/utils/cursor.util.ts`) + Prisma's native
  `cursor`/`skip: 1`/`take: limit + 1` "fetch one extra to detect hasMore" pattern.
- **Upcoming does not reuse this opaque-row-cursor shape** — see Design §Pagination for why a
  date-window model fits better for a date-grouped bidirectional feed.
- Mobile has **no existing infinite-scroll pattern** to reuse (`LibraryScreen`'s comment says so
  explicitly — it just loads one large page). Upcoming is the first bidirectional infinite list in
  this app.

### Watch mutation flow (reused as-is — no new mutation endpoints)
- `POST /episodes/:episodeId/watch` — idempotent mark-watched. Server rejects (400) an unreleased
  episode (`isEpisodeReleased` gate) — this IS the "future episode cannot be marked watched" rule
  the task asks about. Mobile already mirrors this client-side (`EpisodeCard`'s watch circle only
  renders when `released`).
- `DELETE /episode-watches/:watchId?force=` — unwatch. `SeriesDetailScreen`'s `EpisodeCard` already
  does exactly the "tap check toggles watched state in place, card doesn't disappear" interaction
  Upcoming needs — Upcoming's card reuses the same two endpoints, not new ones.
- Both endpoints already return everything needed to patch the TanStack Query cache in place
  (`nextEpisode`, `userStatus`, etc.) — Upcoming's mutation handlers follow the same
  optimistic/patch-in-place convention already used by `SeriesDetailScreen`/`HomeScreen`.

### Refresh pipeline (episode-release-refresh-strategy.md is STALE — verified against real code)
- That doc says "nothing updates the catalog automatically." **This is no longer true.** Real,
  working code exists: `EpisodeSyncSchedulerService` (`@Interval`, hourly tick, `sync-scheduler`
  module) automatically refreshes due series via `SeriesRefreshOrchestratorService`, plus an hourly
  "local release activation" pass (provider-free, just recomputes progress against episodes whose
  airDate has now arrived). `SyncController` also exposes manual refresh
  (`POST /sync/library/refresh`, `POST /sync/series/:id/refresh`) and a stale-on-open refresh
  (`POST /sync/series/:id/refresh-if-stale`, called by the mobile client after a series page
  renders). **Noted as a doc staleness bug to flag, not fixed here** (out of scope — flagging only).
- Practical implication for Upcoming: the timeline is a **live read of `Episode`/`UserSeriesProgress`**
  — whenever the scheduler/manual refresh writes new episodes or updates `airDate`, the next
  `GET /me/upcoming` call reflects it automatically. No separate cache-invalidation plumbing needed
  on the server side; only the mobile query-cache invalidation is Upcoming's concern (Phase 6).

### No existing badge concept to preserve
- Grepped for "NEW"/"premiere"/"finale"/badge across mobile — **no NEW-episode badge, no
  premiere/finale badge exists anywhere in the codebase today.** `StatusBadge` only renders
  `ReleaseStatus`/`UserSeriesStatus` pills. So "preserve existing badge behavior including NEW" has
  nothing to preserve — Upcoming introduces the first premiere badge (see Design §Badges);
  documented as new, not preserved.

### Dev environment
- Real dev Postgres running locally (`my-tv-postgres`, port 5433) with `DATABASE_URL` configured —
  integration tests (gated `describeIfDbConfigured`, pattern in
  `watchlist.service.integration.test.ts`) can run for real. **`dev-database-safety.md` incident is
  the reason we never touch `prisma/seed-demo.ts` or run any destructive command** — this feature
  only adds a read endpoint + (if needed) an additive migration; no risk here, but noted for
  discipline.

---

## Phase 2 — Design decisions

### Backend source of truth: **live query over `Episode`/`UserSeriesProgress`/`EpisodeWatch`, no new table**
No generated "release event" table, no materialized timeline, no cache. Reasoning:
- `Episode.airDate` is already the single source of truth for "when does this release" — a
  generated table would duplicate it and need its own invalidation pipeline (episode insert, airDate
  change, enrichment, watch, status change, midnight) that is strictly redundant with just querying
  fresh each time.
- Matches this app's own established precedent: **every** derived personal view in this codebase
  (`watchNext`, `staleSeries`, `haventStartedYet`) is a live query, never a materialized cache. There
  is exactly one cache-like table in the whole schema (`SeriesSyncStatus`), and it's operational
  scheduler bookkeeping, not user-facing data.
- Given this is a single-user app with a few hundred series, a windowed date-range query (see
  Pagination below) is cheap — no performance case for materialization.
- **Correctness under all the listed invalidation triggers (scheduled refresh, manual refresh,
  new episodes, airDate changes, watch state, user status changes, completed→new season, episode
  reaching release day, midnight crossing) is automatic**, because there is no cached copy to go
  stale — every request re-reads current DB state. The only "invalidation" concern that remains is
  the **mobile query cache** (TanStack Query), covered in Phase 6.

### Eligibility — which series contribute rows to Upcoming
**Eligible `userStatus` values: `WATCHING`, `CAUGHT_UP`, `WATCHLIST`, `PAUSED`, `COMPLETED`.**
**Excluded: `DROPPED`, `UNKNOWN`.** Same set applies to both the past and future windows (one rule,
not two) — simpler, and nothing in the product spec asks for asymmetric eligibility.

Reasoning per status:
- `WATCHING` / `CAUGHT_UP` / `WATCHLIST` — explicitly required by the task ("active and planned
  library statuses should appear"). No confirmed-provider-match gate applied (unlike the Watchlist
  tab) — see "Why no confirmed-match gate" below.
- `DROPPED` — explicitly excluded per the task's recommended direction ("should normally not clutter
  Upcoming"). A dropped show's future episodes are not something the user asked to keep seeing.
- `PAUSED` — **included** (was the one "requires an explicit reasoned decision" case). Reasoning:
  Upcoming is deliberately **not** an action list — cards never disappear on watch, nothing nudges
  the user to act (that's Watch Next's job). A paused show's future air dates are neutral calendar
  information, not a nudge to resume, and the whole point of "must not behave like a second Watch
  List" is that Upcoming should read as a reference timeline. Excluding `PAUSED` would silently hide
  real release info for a show still in the user's library for no product benefit. **Revisitable** —
  documented here as a deliberate, not obvious, call.
- `COMPLETED` — **included**. A `COMPLETED` series with no future-dated episodes in the local catalog
  simply contributes zero future rows (the date filter alone handles it) — no special-casing needed.
  If a "completed" show's catalog already has a future episode row (new season inserted ahead of the
  `userStatus` flip described in `status-model-plan.md` §7 step 3), Upcoming should show it
  regardless of whether the automatic `COMPLETED`→`CAUGHT_UP` flip has run yet — showing real dated
  catalog data is strictly better than hiding it behind an eventually-consistent status flip.
- `UNKNOWN` — excluded. No real relationship established; matches how every other derived view
  in this app treats `UNKNOWN`.

**Why no confirmed-provider-match gate (unlike the Watchlist tab's `isWatchlistTabEligible`):** that
gate exists because `WATCHING`/`CAUGHT_UP` themselves can be an untrustworthy import-time placeholder
label (77% of TV-Time-only rows, per the audit that motivated it). Upcoming does not trust
`userStatus` to mean anything beyond "include/exclude this series" — the actual displayed facts
(air date, episode number, title) come from `Episode.airDate` directly, which is either a real
provider-sourced date or `null`. Episodes from an unenriched/TV-Time-only series have `airDate =
null` (TV Time's export carries no air dates at all — `mytv-prisma-schema-plan.md` §3) and are
already excluded by the date filter itself. So the confirmed-match gate is redundant here: an
unconfirmed series structurally cannot contribute a dated row.

**Risk-list (`stale-series-trust.ts`'s numbering-risk titles) — deliberately NOT applied to
Upcoming.** That gate exists to protect a *recommendation* ("this is the correct next episode to
watch") from a known season/episode mapping mismatch. Upcoming makes no such recommendation — it
lists dated releases with per-episode watched state that's independently correct regardless of
numbering-mapping uncertainty. Documented as a deliberate scope decision, revisitable.

**Season 0 / specials** — included in the timeline like any other episode with a real `airDate` (a
genuine release event). Never counted toward badge derivation (season/series premiere), matching
`isCanonicalSeason`'s existing use elsewhere.

**Duplicate series / unconfirmed identity / migration-problematic series** — out of scope for this
feature; inherited data-quality issues from the rest of the app (e.g. InuYasha's two Series rows both
appear, independently, exactly as they would anywhere else in the app). Not solved here; noted as a
pre-existing limitation, not introduced by Upcoming.

### Release time — nullable architecture, zero fabricated data, zero speculative migration
No new DB column added. Reasoning: no integrated provider supplies time-of-day today (see Phase 1
finding), so a dedicated column would sit permanently unused — against this project's own "nullable
over invented" bias, and against not building for a hypothetical.

Instead, **derive `hasKnownReleaseTime` from the existing `airDate` value itself**:
`hasKnownReleaseTimeOfDay(airDate) = ` true iff the UTC time-of-day components (`getUTCHours/
Minutes/Seconds/Milliseconds`) are **not** all zero. Because every date-only provider value parses to
exact UTC midnight (`parseProviderDateOnly`), an all-zero time-of-day is indistinguishable from "no
time known" — so today this always evaluates false, correctly. If a future provider or import path
ever writes a real non-midnight instant into `airDate`, this heuristic picks it up automatically with
zero further code changes — this is a documented, deliberate heuristic tradeoff (a genuine
exactly-midnight release would be misclassified as date-only; acceptable since no current source
produces real time data at all, so this branch cannot currently fire).

The API returns the raw fields (`airDateOnly`, `airDateInstant`, `hasKnownReleaseTime`) and does
**not** pre-format a localized time string server-side — the server does not know the client's
timezone (this app still has no per-user timezone setting anywhere, confirmed in Phase 1), so
localization is a client concern, matching the existing convention (`formatDate` already calls
`toLocaleDateString(undefined, ...)` client-side, i.e. "use device default").

### Timezone / date-bucketing rule (the trickiest part — see full reasoning)
Two **separate, deliberately different** date computations, never conflated:

1. **`isReleased`** (watch-button eligibility) — the *existing* canonical `isEpisodeReleased`
   instant comparison (UTC-midnight-parsed `airDate` vs real `now`). Reused verbatim, not
   reimplemented — this must stay in lockstep with what the server's `markWatched` will actually
   accept, so the client never shows an enabled watch action the server would then reject with 400.
2. **Day-bucket / header grouping / "Today"/"X days"** — **pure calendar-date arithmetic**, computed
   **client-side**, using this rule:
   - If `hasKnownReleaseTime === false` (today: always true) → bucket under the **raw
     `airDateOnly` string exactly as provider-supplied**, with **no timezone conversion at all**.
     This is the key move that avoids the classic bug ("UTC midnight in Tokyo reads as yesterday
     afternoon in Los Angeles"): a bare calendar date is never passed through an instant/timezone
     conversion, so it can't drift across a day boundary. Matches
     `release-date-policy.ts`'s own framing — "the UTC calendar date has arrived," i.e. date
     arithmetic, not instant arithmetic.
   - If `hasKnownReleaseTime === true` (architecturally supported, not reachable with current data)
     → bucket under the **device-local calendar date of the actual instant**
     (`new Date(airDateInstant)` read via local getters) — because now there IS a precise real-world
     moment, and the correct "day" for the user is genuinely their local calendar day at that
     instant. This is exactly what test case "known time crossing local calendar date" exercises,
     and is why the two rules must stay distinct rather than collapsed into one.
   - "Today" itself is **always the device's own local calendar date** (`new Date()` read via local
     getters, formatted as `YYYY-MM-DD`) — never a server-supplied "today," since the server still
     has no notion of per-user timezone. The server's `today` field (if included) is diagnostic only.
   - Day-count ("8 days" etc.) = integer difference between two `YYYY-MM-DD`-only calendar dates
     (via `Date.UTC(y,m,d)` on the date-only components, divided by 86400000) — **never** a raw
     `now`-to-`then` millisecond diff divided by 24h, which is exactly the kind of computation that
     produces an off-by-one near a DST boundary or when "now" isn't local midnight.
3. **Known-window-boundary edge case (documented, not solved)** — because the server's date-window
   pagination filters on the raw `airDateOnly` (see Pagination below), a *hypothetical* future
   known-time item within ~24h of a page boundary could display, after local-date conversion, under
   a header that reads adjacent to the page boundary it was fetched in. This can never cause a
   duplicate or a lost item (it's always returned in exactly the page matching its raw provider
   date) — only a possible header/boundary cosmetic edge case, and only once real time-of-day data
   ever exists. Documented as deferred/future work; not reachable today.

### Pagination — **date-window**, not opaque row-cursor
Chosen over a generic bidirectional cursor because Upcoming is inherently date-grouped: a
row-cursor scheme risks splitting a date bucket across two pages unless the cursor is itself
date-aligned — at which point it degenerates into date-window pagination anyway. Going straight to
date-window pagination is simpler, and trivially satisfies "no duplicates, no missing boundary
dates, deterministic" by construction: each request is `[from, to)` in plain `YYYY-MM-DD` strings,
windows are chosen contiguous and non-overlapping by the client, and the server's query is a
straightforward inclusive/exclusive date-string range with no ambiguity at the edges.

- `GET /me/upcoming?from=YYYY-MM-DD&to=YYYY-MM-DD` (exclusive `to`, i.e. `[from, to)`).
- Response: `{ from, to, days: [{ date, items: UpcomingItemDto[] }], hasMorePast, hasMoreFuture }`.
  `days` is **sparse** — only dates with ≥1 eligible item are included (keeps payload small; the
  client independently knows what "Today" is and synthesizes an empty Today section locally if the
  server didn't return one for it — see mobile design below).
- Initial load: client requests a window centered on its own local today (e.g. `[today-14d,
  today+30d)`) — one round trip covers Yesterday/Today/Tomorrow/weekday range/most of "Later"
  without needing a second request immediately.
- Scroll-up (older): client requests `[prevFrom-30d, prevFrom)`.
- Scroll-down (future): client requests `[prevTo, prevTo+30d)`.
- `hasMorePast`/`hasMoreFuture`: cheap existence probes (`findFirst`, `select: { id: true }`) for one
  eligible episode strictly outside the returned window in that direction.
- No opaque cursor token at all — the window boundaries **are** the pagination state, entirely
  client-owned and human-readable, consistent with "avoid month-based pagination in the UI" (this
  is date-window, but chunked much finer than months, and invisible to the UI which only ever sees
  day-grouped sections).

### API response shape (`UpcomingItemDto`)
```
seriesId, seriesTitle, posterUrl
episodeId, seasonId, seasonNumber, episodeNumber, episodeTitle
airDateOnly        // "YYYY-MM-DD", raw provider value, unconverted
airDateInstant     // ISO instant, UTC-midnight-parsed (existing convention)
hasKnownReleaseTime  // see above — always false today, architecturally correct for later
isReleased         // canonical isEpisodeReleased(airDate, now) at response-build time
isWatched          // this user has an EpisodeWatch row for this episode
episodeWatchId     // for DELETE /episode-watches/:watchId — reuses existing endpoint, no new mutation API
seriesUserStatus
seriesReleaseStatus
badges: { seasonPremiere: boolean, seriesPremiere: boolean }
```
No new mutation endpoints — Upcoming's watched toggle reuses `POST /episodes/:id/watch` and
`DELETE /episode-watches/:watchId` verbatim (see Phase 1 finding on watch mutation flow).

### Ordering within a day
1. Items with `hasKnownReleaseTime === true`, sorted by `airDateInstant` ascending.
2. Items with `hasKnownReleaseTime === false`, sorted alphabetically (case-insensitive) by
   `seriesTitle`, tie-broken by `(seasonNumber, episodeNumber)`, then `episodeId` (fully
   deterministic). Group 1 always sorts before group 2 (an episode with a known time is never
   pushed later than one without, regardless of the actual clock value) — matches the task's literal
   ordering spec.
Implemented as one pure comparator, unit tested directly and via the day-grouping function.

### Later section (offset ≥ 8 days from local today)
- Offsets: `-1` Yesterday, `0` Today, `1` Tomorrow, `2..7` weekday name (`Friday`, …), `≥8` Later.
  Past offsets `≤ -2`: absolute date (`toLocaleDateString(undefined, { month: 'short', day:
  'numeric', year: sameYear ? undefined : 'numeric' })` — matches this app's existing
  `formatDate` convention, omitting the year only when it's the current year, for a shorter,
  scannable header).
- Inside Later: chronological by date first (server already returns `days` sorted ascending), then
  the same known/unknown-time rule within each date (already guaranteed — Later just concatenates
  multiple already-sorted `days` entries under one shared header, no re-sort needed).
- Every card inside Later carries `daysUntil` (integer, always shown, never converted to
  weeks/months) computed via the calendar-date-diff rule above.

### Badges — season premiere + series premiere implemented; finale explicitly deferred
- `seasonPremiere = episodeNumber === 1 && seasonNumber > 0` (season 0 never counts).
- `seriesPremiere = seasonNumber === 1 && episodeNumber === 1` (implies `seasonPremiere`) — reliable
  because it's read directly off the already-trusted canonical `(seasonNumber, episodeNumber)`
  ordering this app relies on everywhere else (`findFirstUnwatchedEpisodeId` etc.), not an inference
  layered on top.
- **Season finale / series finale: deliberately NOT implemented.** Would require knowing a season's
  or series' *total* episode count with confidence — and catalog completeness is exactly the
  open problem half this project's docs are about (`Mom` missing episodes, `One Piece`
  absolute-numbering mismatch, etc.). Claiming "finale" from "last episode we currently have on
  file" would be a confident-sounding lie for any incompletely-catalogued series. Documented here as
  a deferred item requiring a trustworthy total-episode-count signal that doesn't exist yet.
- No generic "NEW" badge exists anywhere in this codebase (Phase 1 finding) — nothing to preserve;
  not invented here either.

### Frontend structure
- `WatchlistScreen.tsx` gains a WATCH LIST / UPCOMING segmented switch at the top. **Both subtrees
  stay mounted at all times**; switching only toggles RN `display: 'none'` on the inactive one
  (never conditional unmount) — this is what makes "preserve Watch List state" and "preserve
  Upcoming scroll position during the session" free: no remount, no cache loss, no refetch, no
  scroll-position loss, for either side, without any extra state-preservation code.
- Upcoming's own list is a `SectionList` (first one in this app) wrapped in `<Screen scroll={false}>`
  for consistent safe-area/background chrome (its `scroll={false}` branch is just a plain flexed
  `View`, exactly what a self-scrolling `SectionList` needs as a parent).
- Card reuse: **new `UpcomingCard` component**, not a forced fit into `EpisodeCard`/`WatchNextCard`
  — Upcoming cards need series name + day-count + premiere badge, which don't cleanly map onto
  either existing card's prop shape, and `WatchNextCard`'s swipe-gesture machinery is irrelevant
  here (no swipe-to-watch on a historical/future timeline card, only a tap-to-toggle check). Reuses
  `PosterImage` and the shared `colors`/`spacing`/`typography`/`radii` tokens, and mirrors
  `EpisodeCard`'s "tap check circle to toggle watched, tap body to open series" interaction shape for
  visual/behavioral consistency.
- No platform/network/channel field is ever read into the DTO or rendered — confirmed the DTO design
  above carries no such field at all (nothing to accidentally leak).

---

## Assumptions
- "Shows tab" = the Watchlist tab (see Phase 1).
- Single dev user (`DEV_USER_ID`), no real auth/timezone — device-local "today" is the only
  reasonable stand-in for "user's local calendar date," consistent with how the rest of the app
  already treats "now."
- It's acceptable to add zero Prisma migrations for this feature (confirmed no new column is
  needed — see Release time above).

## Rejected alternatives
- Generated "release event" table / materialized timeline — rejected, duplicates `Episode` truth,
  needs its own invalidation pipeline for no performance benefit at this scale (see Backend source
  of truth above).
- Opaque row-cursor pagination (mirroring `/me/recently-watched`) — rejected in favor of date-window
  pagination for a date-grouped feed (see Pagination above).
- Forcing Upcoming cards into `EpisodeCard`/`WatchNextCard` — rejected, wrong shape/interactions
  (see Frontend structure above).
- A dedicated `airTime`/`airTimeZone` migration now — rejected, no data source populates it today;
  derived-from-existing-value heuristic chosen instead (see Release time above).
- Applying the Watchlist tab's confirmed-provider-match trust gate to Upcoming — rejected, redundant
  given the date-filter already excludes unenriched series' null-airDate episodes (see Eligibility
  above).

## Risks / open questions
- `hasKnownReleaseTimeOfDay`'s exact-midnight heuristic would misclassify a genuine exact-midnight
  release as date-only — accepted, since no current provider produces real time data at all.
- Date-window page-boundary cosmetic edge case for a hypothetical future known-time item near a
  boundary (see Timezone section) — accepted/deferred, unreachable with current data.
- `episode-release-refresh-strategy.md` is stale relative to the real, already-implemented scheduler
  — flagged here, not fixed (out of scope for this feature).
- PAUSED inclusion in Upcoming is a judgment call, not a spec-mandated certainty — revisit if it
  turns out to read as noise in practice.
- Risk-list (`stale-series-trust.ts`) exclusion NOT applied to Upcoming — revisit if a
  numbering-mismatched series' dates turn out to be actively misleading in the timeline (not just in
  a "next episode to watch" recommendation).

## Deferred / follow-up items
- Season/series finale badges — needs a trustworthy total-episode-count signal; not implemented.
- Real release time-of-day — needs a provider that supplies it (none integrated today); nullable
  architecture is in place and will pick it up automatically if/when one is added.
- Duplicate-series / unconfirmed-identity data-quality issues — pre-existing, out of scope.
- `episode-release-refresh-strategy.md` doc staleness — flagged, not corrected in this session.
- Tab-reselect scroll-to-top for the Upcoming panel specifically: `WatchListPanel` keeps its
  pre-existing `useScrollToTop` wiring unchanged, but `UpcomingTimeline` is NOT wired into it. Since
  React Navigation's tab-reselect scroll-to-top is bound to the *tab screen* being focused (not which
  of the two always-mounted panels is currently visible), wiring both would mean re-selecting the
  Watchlist tab always scrolls `WatchListPanel`'s ScrollView regardless of visible mode — already
  true today and harmless (nothing scrolls on screen if that panel is hidden), but a second
  `useScrollToTop` call for `UpcomingTimeline`'s `SectionList` would fire simultaneously, which is
  unnecessary/could be janky. Deferred: if this is wanted, the correct fix is a single reselect
  handler in `WatchlistScreen` that dispatches to whichever panel is currently active, not two
  independent `useScrollToTop` calls.

---

## Phase 3+ implementation log

### Phase 3 — Backend API — DONE
Files added:
- `server/src/modules/me/upcoming-query-helpers.ts` — pure logic: `UPCOMING_ELIGIBLE_STATUSES`,
  `validateUpcomingWindow`, `toAirDateOnlyString`, `hasKnownReleaseTimeOfDay`,
  `deriveUpcomingBadges`, `toUpcomingItem`, `compareUpcomingItemsWithinDay`,
  `buildUpcomingDayBuckets`.
- `server/src/modules/me/dto/upcoming-query.dto.ts`, `upcoming-item.dto.ts`, `upcoming-page.dto.ts`.
- `server/src/modules/me/__tests__/upcoming-query-helpers.test.ts` — 24 pure-logic unit tests.
- `server/src/modules/me/__tests__/me.service.upcoming.integration.test.ts` — 9 real-Postgres
  integration tests (eligibility filter, dateless-episode exclusion, `[from,to)` boundary,
  no-duplicates-across-adjacent-windows, hasMorePast/hasMoreFuture, watched-state join, invalid
  window → 400).
Files changed: `me.service.ts` (added `getUpcoming`), `me.controller.ts` (added `GET /me/upcoming`).
No Prisma migration — confirmed no schema change needed (see Release time design above).

**Validation**: `npx tsc --noEmit` clean. Full server suite: **109 suites / 1411 tests, all green**
(was 107/~1377 before this feature). `npm run lint` fails — **pre-existing, not introduced by this
change**: no `eslint.config.js`/`.eslintrc*` exists anywhere in `server/`, and `eslint` isn't even on
PATH (`sh: eslint: command not found`) even before touching any file. Flagged, not fixed (out of
scope for this feature).

Next: Phase 4 (mobile mode switch + Upcoming timeline UI).

### Phase 4/5/6 — Mobile mode switch, timeline UI, bidirectional scrolling, mutations, rollover — DONE
Files added (mobile):
- `src/api/types/upcoming.ts` (`UpcomingItem`/`UpcomingDayBucket`/`UpcomingPage`, mirroring the
  server DTOs), `src/api/endpoints/upcoming.ts` (`getUpcoming({from,to})`).
- `src/utils/upcomingGrouping.ts` — the client-owned pure logic: local calendar-date primitives
  (`getLocalDateKey`/`addDaysToLocalDateKey`/`daysBetweenLocalDateKeys`, all device-local, never
  UTC), `resolveEffectiveLocalDateKey` (the known/unknown-time bucketing split), a mirrored
  `compareUpcomingItemsWithinDay`, section-header derivation (`getSectionKindForOffset`/
  `formatSectionTitle`/`formatDaysUntil`), date-window helpers
  (`getInitialUpcomingWindow`/`getPreviousUpcomingWindow`/`getNextUpcomingWindow`),
  `buildUpcomingSections` (the main orchestrator: re-buckets by effective local date, synthesizes an
  empty Today section, merges offset≥8 into one Later section), and `patchUpcomingItemInPages`
  (in-place cache patch after a watch mutation). 39 unit tests
  (`src/utils/__tests__/upcomingGrouping.test.ts`).
- `src/components/UpcomingCard.tsx` — new card (not forced into EpisodeCard/WatchNextCard — see
  design doc above). 10 render tests (`src/components/__tests__/UpcomingCard.test.tsx`).
- `src/components/UpcomingTimeline.tsx` — the timeline itself: TanStack Query v5's native
  bidirectional `useInfiniteQuery` (`getPreviousPageParam`/`getNextPageParam`/`fetchPreviousPage`/
  `fetchNextPage`) is the pagination engine — chosen over hand-rolling, since it already does
  exactly this. `SectionList` (first one in this app — every other screen was a plain `ScrollView`)
  with `onStartReached`/`onEndReached` (both gated on `hasPreviousPage`/`hasNextPage` +
  `isFetching*Page` to prevent duplicate/overlapping load calls) and
  `maintainVisibleContentPosition={{ minIndexForVisible: 0 }}` for a jump-free prepend. Today-anchor:
  a `useEffect` scrolls to the Today section's `sectionIndex` exactly once per mount (a ref guard),
  never re-fires on subsequent data changes — this is what prevents "moving the user back to Today
  after they intentionally scrolled." Watch/unwatch reuses the exact existing
  `POST /episodes/:id/watch` / `DELETE /episode-watches/:watchId` endpoints (no new mutation API),
  patches the infinite-query cache in place via `patchUpcomingItemInPages` (card stays, only its
  checkmark changes — never removed/reordered), and honors the same force-required retry flow as
  `SeriesDetailScreen` (shared via two small extractions below). Midnight/date rollover: **both**
  `AppState` foreground listener and a 60s interval recheck local "today"; if it changed, `todayKey`
  state updates, which changes the TanStack Query key (`queryKeys.upcoming(todayKey)`) and naturally
  triggers a fresh anchored fetch, and resets the "anchor once" ref so the view re-scrolls to the new
  Today. Both signals are needed (see code comment) — foreground alone misses an app that never
  backgrounds; the timer alone would be the only signal if the OS never triggers a foreground event.
- Shared extractions (small, behavior-preserving refactor, not new logic): `isForceRequiredError`
  moved from a local function in `SeriesDetailScreen.tsx` into `src/utils/errors.ts`; `confirmAsync`
  moved into new `src/utils/confirmAsync.ts`. Both were previously defined once, used once, with
  identical logic now needed a second time (Upcoming's unwatch flow) — extracting avoids the two
  call sites silently drifting apart on what "force-required" means. `SeriesDetailScreen.tsx` updated
  to import both instead of its local copies; its own behavior/tests unaffected (verified: full
  mobile suite green after the extraction, before adding any Upcoming-specific code).
- `src/screens/WatchlistScreen.tsx` — added the WATCH LIST / UPCOMING segmented switch. **Both
  panels stay mounted at all times** (`display: 'none'` toggle, never conditional unmount) — the
  mechanism that makes "preserve Watch List state" and "preserve Upcoming scroll position during the
  session" free, with no extra state-preservation code on either side. The original Watch List body
  was extracted verbatim into a `WatchListPanel` sub-component — same query, same grouping, same
  cards, same `useScrollToTop` wiring, unchanged. Safe-area handling: moved to a single outer
  `SafeAreaView` (`edges={['top','bottom']}`) wrapping the whole screen (switch row + both panels),
  with each panel's own `<Screen edges={[]}>` no longer double-applying the inset.
- Cross-screen cache consistency: `SeriesDetailScreen.tsx` (mark-watched, unwatch, watch-all ×2
  success paths, status-update) and `HomeScreen.tsx` (mark-watched) each gained one added line:
  `queryClient.invalidateQueries({ queryKey: ['upcoming'] })` (partial-key match — Upcoming's real
  key carries a dynamic "today" anchor those screens don't know) — so a watch/status change made
  from anywhere in the app is reflected the next time Upcoming is viewed or its background refetch
  lands, without Upcoming needing to know about those screens.

**Deliberate UX divergence from `SeriesDetailScreen`, documented**: tapping an already-watched
Upcoming card's check directly unwatches (no confirmation dialog) — `SeriesDetailScreen`'s unwatch
is a "correction" action gated behind a confirm dialog; Upcoming's check is framed as a direct,
symmetric toggle consistent with "the card must remain, only its watched visual state changes." The
force-required retry flow (attached note/rating/emotion) is still honored identically in both.

**Validation so far**: `npx tsc --noEmit` clean (intermittently blocked by a transient platform
issue while re-verifying after the last edit — re-running before final sign-off, see below). Full
mobile suite before the last edit: **15 suites / 142 tests, all green** (was 14/130 before this
feature — 12 new pure-logic + component tests plus the pre-existing 130 unaffected by the
errors.ts/confirmAsync.ts extraction). Re-running once more after the final `patchItem` closure fix
(see below) before declaring Phase 4-6 fully done.

**One correctness fix made during self-review**: `patchItem`'s `useCallback` originally closed over
the `queryKey` array (a fresh reference every render) with only `[queryClient]` as deps (silencing
the lint rule) — this would have targeted a **stale** cache entry after a midnight-rollover
`todayKey` change, since the memoized callback would keep referencing whichever `queryKey` array
existed when it was last recreated. Fixed to recompute `queryKeys.upcoming(todayKey)` inline and
depend on the primitive `todayKey` instead of the array — correct across rollover, and no eslint
suppression needed. Caught by manual re-review, not a test (a good candidate for a future test if
this file gets a component-level test harness).

Next: Phase 7 (full validation pass, lint, final report).

### Phase 7 — Final validation

**Backend**: `npx tsc --noEmit` clean. Full suite **109 suites / 1411 tests, all green**
(confirmed earlier in this session, right after Phase 3 landed — no server files changed since).
`npm run lint` fails — pre-existing (no `eslint.config.js`/`.eslintrc*` anywhere in `server/`,
`eslint` not even on PATH), not introduced by this feature.

**Mobile**: confirmed **15 suites / 142 tests, all green** and `npx tsc --noEmit` clean at the
checkpoint right after the WatchlistScreen wiring + cross-screen cache-invalidation additions landed.
One additional change was made after that checkpoint: the `patchItem` closure fix in
`UpcomingTimeline.tsx` (recompute `queryKeys.upcoming(todayKey)` from the primitive `todayKey` instead
of closing over the `queryKey` array with stale deps — see the fix note above). This is a small,
mechanical, manually re-reviewed change (re-read twice against the file, confirmed correct — it only
affects which cache key a callback targets, no new logic paths). **A tool-availability issue in this
environment** (Bash/`npx`/`node` command execution intermittently unavailable — a platform-level
safety-classifier degradation, not something in this repo) blocked re-running the automated
`npx tsc`/`npx jest` commands after that final fix, despite roughly 30 retries spread across several
minutes using multiple invocation forms (`npx jest`, direct `node_modules/.bin/jest`, explicit
`node node_modules/jest/bin/jest.js`, `npx tsc`, `node -e`) — all blocked identically, while plain
`git`/coreutils commands kept working throughout, confirming this was a tool-platform issue rather
than anything about the code or repo. **This is disclosed here rather than reporting a fabricated
"all green" for the final state** — recommend re-running `npx tsc --noEmit` and `npx jest` in
`mobile/` once tool availability is confirmed normal, as the one remaining explicit verification step
before considering this feature fully signed off.

**Diff review**: `git status`/`git diff` confirm the mobile repo has substantial **pre-existing
uncommitted work unrelated to this session** (swipe-to-watch reconciliation on Home, a Search tab
redesign, Migration Workbench provider-review/rollback UI, etc. — legitimate prior work, already
covered by its own passing tests, just not yet committed by whoever built it). This session's own
changes were verified in isolation via `git diff <specific-file>` for every touched pre-existing file
(`errors.ts`, `SeriesDetailScreen.tsx`, `HomeScreen.tsx`) to confirm each diff was exactly the
intended addition and nothing else — confirmed clean in every case. New files added this session are
listed in the Phase 3/4-6 entries above. No destructive git command was ever run; only Read/Write/Edit
and non-destructive `git status`/`git diff` for inspection.

---

## Phase 8 — Bug fix: wrong initial date + SectionList runtime error

### Investigation

Re-read the current `UpcomingTimeline.tsx` and `WatchlistScreen.tsx` in full before touching anything.

**Confirmed current (buggy) mount-time anchor logic** (`UpcomingTimeline.tsx`):
```
useEffect(() => {
  if (hasAnchoredToToday.current || sections.length === 0) return;
  const todaySectionIndex = sections.findIndex((s) => s.kind === 'today');
  if (todaySectionIndex === -1) return;
  hasAnchoredToToday.current = true;
  requestAnimationFrame(() => {
    listRef.current?.scrollToLocation({ sectionIndex: todaySectionIndex, itemIndex: 0, animated: false, viewOffset: 0 });
  });
}, [sections]);
```
This effect runs **unconditionally on every mount**, regardless of whether the Upcoming panel is the
one currently visible. `WatchlistScreen` mounts **both** `WatchListPanel` and `UpcomingTimeline`
always (the deliberate "no remount, no cache loss" design from Phase 4), toggling only
`display: 'none'` on whichever is inactive. Default `mode` is `'watchlist'`, so on every cold entry
into the Shows tab, `UpcomingTimeline` mounts **hidden**, its `useInfiniteQuery` fires immediately
(queries aren't gated on visibility — intentional, for instant switching), and the moment the first
page resolves, this effect fires and calls `listRef.current?.scrollToLocation(...)` on a `SectionList`
sitting inside a `display: 'none'` ancestor.

**Root cause, Issue 2 (runtime error on the Watch List tab)**: a view with `display: 'none'` is
removed from Yoga's layout pass entirely on both platforms — it and its subtree never get laid out,
so the `SectionList` inside it has never measured any cell, has zero known dimensions, and has never
committed an `onLayout`. Calling `scrollToLocation` in this state forces `VirtualizedSectionList` to
resolve a flat item index and call the underlying `VirtualizedList.scrollToIndex`, which — with no
`getItemLayout` provided and no cells ever measured — cannot resolve a target offset. Because the
component **never passed `onScrollToIndexFailed`**, `VirtualizedList` had no graceful recovery path
and threw/logged the exact reported error ("scrollToIndex should be used in conjunction with
getItemLayout or onScrollToIndexFailed..."). This fires while the user is looking at Watch List,
because Upcoming is mounted-but-hidden underneath it and its data-driven effect doesn't know that.

**Root cause, Issue 1 (wrong initial date once actually on Upcoming)**: two contributing causes:
1. The *first* scroll attempt (the one described above) happens while the panel is still hidden and
   fails/no-ops in whatever partial way `scrollToLocation` degrades to without a resolvable target —
   `hasAnchoredToToday.current` is set to `true` **before** the scroll even has a chance to succeed
   (it's set synchronously, the actual scroll is deferred one `requestAnimationFrame`), so the
   "only once" guard is already spent by the time the user ever switches to Upcoming. The real,
   visible switch to Upcoming never gets its own anchor attempt at all.
2. Even setting that aside, `scrollToLocation` without `getItemLayout` on a *freshly-visible*,
   variable-height `SectionList` is a best-effort estimate based on whatever has been measured so
   far — since only `initialNumToRender`'s worth of cells near the very top of the list have ever
   been measured (from whenever it was mounted hidden), the estimate undershoots and lands somewhere
   in the earlier, already-measured region of the loaded window instead of at Today's real section —
   exactly the reported symptom ("starts around an earlier date / a broader weekly window").

**Confirmed via code, not assumed**: `WatchListPanel` also calls `useScrollToTop` unconditionally
(unchanged since Phase 4-6), and it is **always mounted** too — already flagged as a deferred
limitation in Phase 4-6's log ("a second `useScrollToTop` call for `UpcomingTimeline`'s `SectionList`
would fire simultaneously"). That limitation is resolved as part of this fix (see "Mode-specific tab
reselect" below) rather than left deferred, since fixing the anchor logic requires touching the same
lifecycle wiring anyway.

### Chosen fix

**1. Never scroll while hidden — gate on an explicit `isActive` prop AND a real, native layout signal.**
`UpcomingTimeline` now takes an `isActive: boolean` prop (`mode === 'upcoming'`, passed down from
`WatchlistScreen`). The initial-anchor effect requires **three** things before it will ever call
`scrollToLocation`: `isActive`, `sections` containing a `today` entry, and a `hasLaidOut` flag set
only inside the `SectionList`'s own `onLayout` callback (and only when the reported height is
`> 0`, as a defensive check against any platform inconsistency in how `display: 'none'` interacts
with layout events). A view under `display: 'none'` never receives a real `onLayout` call in RN's
Yoga layout engine (confirmed against RN 0.81's behavior, not assumed) — so while Upcoming sits
hidden, `hasLaidOut` simply never becomes `true`, and the anchor effect never fires, which by itself
already fixes Issue 2 (no scroll attempt happens while looking at Watch List). The moment the user
switches to Upcoming, its wrapper flips to `display: 'flex'`, Yoga lays it out for real, `onLayout`
fires with a genuine height, and *that* is what finally satisfies the effect's dependencies and
triggers the anchor scroll — against a `SectionList` that has actually been given real screen space
to measure into. `isActive` is kept as an explicit second gate (belt-and-suspenders) rather than
relying on `onLayout` timing alone, since `display: 'none'` layout-event behavior has had inconsistent
history across RN/Android versions.

**2. Required `onScrollToIndexFailed`, with a short, explicitly bounded retry — never a fake `getItemLayout`.**
Card and section-header heights are genuinely variable (wrapping series titles, optional badges,
optional day-count text, optional time text) — a fixed-height `getItemLayout` would be actively wrong,
not just imprecise, so it's not used. Instead, `onScrollToIndexFailed` is now provided (previously
absent — the direct cause of Issue 2's uncaught error) and, on failure, retries the *same*
`scrollToLocation` call once more after a short fixed delay (100ms — long enough for `VirtualizedList`
to have rendered more of the list in response to the failed attempt, per RN's own documented recovery
pattern for this exact warning), bounded by a retry counter reset per scroll attempt and capped at 3
tries. After the cap, it gives up silently — no error, no infinite loop, Today's section is simply
left wherever natural rendering placed it (an acceptable, rare degradation, not a crash).

**3. One shared scroll implementation for both the mount-time anchor and the reselect-to-Today action.**
`scrollToTodaySection(animated)` is the single function that finds the `today` section index and
calls `scrollToLocation` — used by the mount effect (`animated: false`, gated by `hasAnchoredToToday`)
and by an imperative `scrollToToday()` handle (see below) exposed for tab-reselect (`animated: true`,
never gated by the "only once" ref, since it's an explicit user action each time).

**4. Mode-specific tab-reselect, via a single dispatcher ref (fixes the "both lists could fire"
limitation flagged in Phase 4-6).** `WatchListPanel` no longer calls `useScrollToTop` itself; it
`forwardRef`s its `Screen`'s underlying `ScrollView` ref up to `WatchlistScreen`. `UpcomingTimeline`
`forwardRef`s an imperative handle (`{ scrollToToday: () => void }`) up as well. `WatchlistScreen`
holds exactly **one** `useScrollToTop` call, pointed at a stable dispatcher ref object whose
`scrollToTop` method is reassigned on every render (cheap; refs are safe to mutate during render) to
close over the *current* `mode` and dispatch to whichever target is actually active:
`mode === 'watchlist'` → `watchListScrollRef.current?.scrollTo({ y: 0, animated: true })`;
`mode === 'upcoming'` → `upcomingRef.current?.scrollToToday()`. Exactly one list is ever touched per
reselect, by construction (an `if`/`else`, not two independent hook registrations).

### Rejected alternatives
- **Fake/approximate `getItemLayout`** — rejected outright per the task's own constraint; card/header
  heights are genuinely variable, so any fixed value would be wrong for a real fraction of rows, not
  just imprecise for all of them.
- **A single long arbitrary `setTimeout` before the very first scroll attempt** (e.g. "wait 500ms
  after mount, then scroll") — rejected: fragile (guesses at a device/measurement-dependent duration
  instead of reacting to a real signal), and does nothing to stop the effect from running while
  hidden in the first place — it would still fire the doomed scroll while on Watch List, just later.
- **Two independent `useScrollToTop` calls (one per panel)** — rejected; this is exactly the
  "could accidentally call both lists" failure mode the task calls out, and was already flagged as a
  known gap in Phase 4-6. Replaced with the single-dispatcher-ref pattern.
- **Unmounting the inactive panel instead of `display: 'none'`** — considered, since it would trivially
  avoid any hidden-layout scrolling concern. Rejected: would throw away the Phase 4-6 "both panels
  always mounted" design, which is what gives free query-cache/scroll-position preservation across
  mode switches with zero extra state-management code — a real architectural regression to solve a
  problem that a correct visibility+layout gate solves without giving that up. Documented here as
  investigated and deliberately not chosen, per the task's instruction to keep the current structure
  "unless investigation finds a strong architectural reason to change it" — hiding via `display:none`
  remains sound; it was the *scroll code* that didn't respect it, not the mounting strategy itself.
- **Retrying indefinitely in `onScrollToIndexFailed`** — rejected; bounded to 3 attempts specifically
  so a pathological case (e.g. sections somehow never settling) can never become an infinite loop or
  a runaway timer chain.

### Remaining limitations
- The `onScrollToIndexFailed` retry's 100ms delay is a heuristic, not a guaranteed-sufficient wait —
  in the rare case the list still hasn't rendered enough after 3 retries (very deep Today-section
  index, e.g. an unusually dense multi-week past-release history), the initial scroll may land
  slightly short of Today rather than throwing — an acceptable, non-crashing degradation, not silently
  wrong data.
- `isActive`-gated layout detection assumes RN's `display: 'none'` semantics (no layout pass, no real
  `onLayout`) hold on both platforms at the installed RN version (0.81.5) — true as investigated, but
  not unit-testable directly (would require a real native layout pass); covered by manual validation
  steps instead (see Tests section below).

### Files changed
- `mobile/src/components/UpcomingTimeline.tsx` — `forwardRef` + `isActive` prop + `hasLaidOut` state
  (set from a real `onLayout`) + shared `scrollToTodaySection` + `onScrollToIndexFailed` bounded retry
  + `useImperativeHandle` exposing `scrollToToday()`. Refactored to call the new pure decision
  functions instead of 3x duplicated inline lambdas.
- `mobile/src/utils/upcomingGrouping.ts` — added `findTodaySectionIndex`, `shouldPerformInitialAnchor`,
  `canRetryScrollToToday` (pure, framework-free decision logic extracted so it's directly testable).
- `mobile/src/screens/WatchlistScreen.tsx` — `WatchListPanel` is now `forwardRef` (exposes its
  `Screen`'s `ScrollView` ref instead of calling `useScrollToTop` itself); `WatchlistScreen` now holds
  exactly one `useScrollToTop` call against a dispatcher ref reassigned fresh every render (closes
  over current `mode`), routing to `watchListScrollRef.current.scrollTo` or
  `upcomingRef.current.scrollToToday()` — never both.
- `mobile/src/utils/__tests__/upcomingGrouping.test.ts` — 13 new tests for the 3 new pure functions
  (covers Tests items 1, 2, 3, 4, 7, 8).
- `mobile/src/screens/__tests__/WatchlistScreen.tabReselect.test.tsx` (new) — 4 tests covering mode-
  specific tab-reselect dispatch (Tests items 5, 6), mirroring the existing
  `activeTabScrollToTop.test.tsx` real-bottom-tab-navigator pattern, with `Screen` and
  `UpcomingTimeline` mocked to expose spy-able imperative handles (this RNTL version, 14.x, no longer
  exposes `UNSAFE_getByType`/`UNSAFE_root` for grabbing a real host `ScrollView` instance directly —
  discovered empirically when the first draft of this test failed with `UNSAFE_getByType is not a
  function`; mocking `Screen` was the direct, non-fragile alternative).

### Tests — final status
**Pure decision-logic (unit tests, `upcomingGrouping.test.ts`)**: all 8 required items covered —
1/2 via `findTodaySectionIndex`/`shouldPerformInitialAnchor` (today always selected, even with zero
items, since `buildUpcomingSections` already guarantees a `today`-kind section whenever in range,
tested separately); 3/4 via `shouldPerformInitialAnchor`'s `hasAnchoredAlready` gate (both "ordinary
rerender" and "isActive flips back true after already anchoring" return `false`); 7/8 via
`canRetryScrollToToday` (allows under the cap, refuses at/over it, and a simulated 100-iteration
failure loop converges to exactly `maxRetries` attempts, never more).
**Mode-specific tab reselect (component tests, `WatchlistScreen.tabReselect.test.tsx`)**: items 5/6
covered directly — reselecting while Watch List is active calls only the Watch List scroll target;
reselecting while Upcoming is active calls only `scrollToToday()`; switching tabs away/back without a
genuine reselect calls neither; switching modes and back still dispatches to the fresh, current mode
(not a stale closure).
**Full mobile suite**: `npx tsc --noEmit` clean; **16 suites / 159 tests, all green** (was 15/142
before this fix — +1 suite, +17 tests: 4 new WatchlistScreen tests + 13 new pure-logic tests).
Pre-existing `Jest did not exit one second after the test run` / `worker process has failed to exit
gracefully` warnings appear on the two navigation-based test files (this one and the pre-existing
`activeTabScrollToTop.test.tsx`) — a known `@react-navigation`-in-jest characteristic (some internal
timer not `.unref()`'d), not something introduced by or specific to this fix; all tests still pass
with exit code 0 in every run.

### Manual validation steps (UI behavior not provable through unit tests)
Not run against a live simulator/device in this session (no interactive device session available in
this environment) — documented here as the exact steps to perform before considering this fully
verified end-to-end, per the task's instruction to document manual validation when full proof isn't
possible through unit tests alone:
1. Launch the app fresh, land on the Shows tab (Watch List active by default) — confirm **no runtime
   error/red-box appears** and Watch List renders normally (this is the direct regression check for
   Issue 2 — previously, `UpcomingTimeline` mounted hidden and threw immediately on this exact screen).
2. Tap "UPCOMING" — confirm the timeline opens with **Today's section header visible near the top of
   the viewport** (not Yesterday, not a broad week view, not an earlier historical date) — the direct
   regression check for Issue 1.
3. With a tracked series that has no release today, confirm the empty "Today" section/anchor is still
   visible (not skipped, not replaced by the nearest populated day).
4. Scroll up (older) and down (future) in Upcoming, then tap "WATCH LIST" and back to "UPCOMING" —
   confirm the scroll position from before switching away is preserved (not reset to Today again).
5. While Watch List is active, tap the bottom "Watchlist" tab bar button again — confirm Watch List
   smoothly scrolls to its top, and Upcoming does not visibly move (it's hidden, but confirm no error
   appears either).
6. Switch to Upcoming, scroll away from Today, then tap the bottom "Watchlist" tab bar button again —
   confirm Upcoming smoothly returns to Today (not to the top of the loaded list, not to Yesterday).
7. Mark an episode watched from an Upcoming card — confirm the card stays in place (only its check
   mark changes) and the timeline does not jump or re-anchor to Today.
8. Leave the app open/foregrounded across a real or simulated local-midnight rollover (or background
   and resume the app after changing the device clock past midnight) — confirm Upcoming re-anchors to
   the new Today the next time it's viewed, without a stale "Today" label on the old date.

---

## Phase 9 — Bug fix: Upcoming still opens on the wrong (far-past) date on a real device

### Report
User-reported on first real-device use of the Phase 8 fix: opening Upcoming on 2026-07-18 showed
"17 Jun" as the first visible date — over a month in the past — instead of Today. This is the exact
failure mode Phase 8 targeted, but from a *different* root cause than the one Phase 8 fixed (that fix
was correct as far as it went — the hidden-panel scroll and the missing `onScrollToIndexFailed` were
real bugs — but a second, independent bug was hiding behind it, only reachable once the first one was
fixed and a real device could actually attempt the anchor).

### Investigation
Re-read `UpcomingTimeline.tsx` in full. Found the smoking gun immediately in the `SectionList`'s
`onStartReached` handler:
```
onStartReached={() => {
  if (hasPreviousPage && !isFetchingPreviousPage) void fetchPreviousPage();
}}
onStartReachedThreshold={2}
```
No gate on whether the initial Today-anchor has happened yet.

### Root cause
A freshly-mounted `SectionList` always starts at scroll offset 0 — i.e., already "at the start" of
its content, which trivially satisfies `onStartReachedThreshold`. RN/VirtualizedList's documented
behavior is to fire `onStartReached` (and `onEndReached`) on initial layout if the current scroll
position already qualifies, not just after a user's scroll gesture. So the sequence on a real device
was:

1. `SectionList` mounts with the initial 14-days-back/30-days-forward window's sections, sitting at
   offset 0 (nothing has scrolled it away from the top yet — the anchor effect hasn't run: it's
   gated on `isActive && hasLaidOut && sections has today`, and `hasLaidOut` is itself async, set
   only once `onLayout` fires).
2. Being at offset 0 immediately satisfies `onStartReached`'s threshold → `fetchPreviousPage()` fires,
   pulling in another 30 days further back (`getPreviousUpcomingWindow`).
3. The new page resolves, `sections` grows (more, EARLIER sections are now prepended before Today's
   section — shifting its index further down the list), but the scroll offset is *still* ~0 (nothing
   has moved it) — so `onStartReached` can fire *again* for yet another previous page. This repeats
   for as many pages as resolve before something finally breaks the cycle.
4. Only once `hasLaidOut` finally becomes `true` does the anchor effect get a chance to run — by
   which point `sections` may already span months, Today's section index may be large and far
   outside whatever's actually been rendered/measured, and the bounded 3-retry `onScrollToIndexFailed`
   recovery (tuned against the *original*, small 14+30-day window) isn't reliably enough to reach it.
   The list is left wherever the last runaway prepend happened to leave it — i.e., near the top of
   whatever got auto-loaded, which is exactly "a date roughly a month-plus in the past," matching the
   report precisely (today 2026-07-18, observed 2026-06-17 — about a month back, consistent with one
   or two extra 30-day auto-prepends beyond the initial 14-day window).

This is a genuine race between "the list naturally sits at offset 0 until something scrolls it away"
and "the thing that's supposed to scroll it away (the Today anchor) is gated on an async layout
signal" — invisible in this project's fast, synchronous unit tests (which never simulate real
`onStartReached` firing or real incremental rendering timing), but reliably reproducible on an actual
device where layout/rendering genuinely takes multiple frames.

### Chosen fix
**Gate both `onStartReached` and `onEndReached` behind "has the initial anchor already happened."**
Neither direction of auto-pagination is allowed to fire until `hasAnchoredToToday` is `true` — reusing
the exact same ref/flag the anchor effect already sets, so there is exactly one source of truth for
"has this timeline settled on Today yet." Concretely:
```
onStartReached={() => {
  if (canAutoLoadMorePages(hasAnchoredToToday.current, hasPreviousPage, isFetchingPreviousPage)) void fetchPreviousPage();
}}
onEndReached={() => {
  if (canAutoLoadMorePages(hasAnchoredToToday.current, hasNextPage, isFetchingNextPage)) void fetchNextPage();
}}
```
`canAutoLoadMorePages` is a new pure, exported function in `upcomingGrouping.ts` (same pattern as
`shouldPerformInitialAnchor`/`canRetryScrollToToday`), directly unit-testable and now the single
documented invariant: **no auto-pagination in either direction before the first anchor completes.**

This fixes the bug at its actual source (the sections array stays at its small, initial size until
Today has been anchored, so the anchor's `scrollToLocation` target is always within the originally-
rendered window — the retry mechanism should now rarely if ever be needed) rather than just tuning
the retry counts, which would have been treating the symptom. `onEndReached` is gated the same way
for consistency/predictability even though forward-appending doesn't shift earlier sections' indices
the way backward-prepending does — there's no reason to eagerly fetch future pages before the user has
even seen the screen either.

Once `hasAnchoredToToday` becomes `true` (either the normal first anchor, or after a midnight-rollover
re-anchor resets it), both directions behave exactly as before — genuine user-driven bidirectional
infinite scroll, unaffected by this gate.

### Why this wasn't caught by the Phase 8 test suite
The Phase 8 pure-logic tests (`shouldPerformInitialAnchor`, `canRetryScrollToToday`) correctly modeled
the anchor *decision* logic, and the component test (`WatchlistScreen.tabReselect.test.tsx`) correctly
modeled tab-reselect dispatch — but nothing exercised `onStartReached`/`onEndReached` firing during
the async gap between "SectionList mounts at offset 0" and "the anchor effect actually runs," because
RNTL's mocked `SectionList` in the jest environment never fires these callbacks on its own (there's no
real scroll-position/threshold computation without genuine native layout) — this class of bug is
structurally invisible to unit tests and only reachable via an actual device/simulator run, which
Phase 8's "Remaining limitations" section already flagged as not having been performed. Documented
here as confirmation of that flagged gap turning out to matter in practice, not a new category of
limitation.

### Rejected alternatives
- **Just increase `MAX_SCROLL_TO_TODAY_RETRIES`/the retry delay** — rejected as insufficient on its
  own: it doesn't stop the runaway prepend loop itself, only makes the *recovery* from an
  ever-growing list marginally more likely to eventually succeed. The list could still auto-load
  arbitrarily far back before the first retry-driven scroll even gets a stable target, so this would
  reduce the failure's frequency, not eliminate its cause.
- **Remove `maintainVisibleContentPosition`** — considered, since it's what makes each prepend
  "invisible" (no visible jump) and arguably enables the loop to run silently. Rejected: removing it
  would just make the SAME runaway-prepend bug visibly janky (a series of visible jumps) instead of
  fixing it — `maintainVisibleContentPosition` is still correct and wanted for genuine user-driven
  prepends once anchored.
- **Set `initialNumToRender` very high so the anchor's target is more likely already measured** —
  rejected: doesn't address the actual race (onStartReached still fires at offset 0 regardless of how
  much is initially rendered), and would hurt initial render performance for no real correctness gain.

### Remaining limitations
- Still not validated on a real device by me directly (no interactive device/simulator access in this
  environment) — the user's own report was the first real-device signal for this whole feature, and
  is the reason this fix exists. Recommend the user re-verify the exact manual steps already listed
  in Phase 8 after this fix lands, especially step 2 (Today near the top of the viewport).
- The underlying "onStartReached/onEndReached can fire immediately at offset 0" is a general
  VirtualizedList characteristic, not specific to this codebase — worth remembering for any *future*
  SectionList/FlatList added to this app that combines auto-pagination with a programmatic initial
  scroll target.

---

## Phase 10 — Bug fix: Upcoming still lands on a past date (visibly converging, but not reaching Today)

### Report
After the Phase 9 fix landed, user re-tested and reported: opening Upcoming no longer jumps to a
wildly-distant date, but it now visibly **scrolls gradually** for a moment and **settles on an
already-passed date**, not Today. This is progress (the Phase 9 runaway-prepend bug is gone — the
"gradually" behavior itself is new information), but the anchor still isn't reliably reaching its
target.

### Investigation
The "gradual" visible scrolling is not new code — it's `handleScrollToIndexFailed`'s own bounded
retry loop (from Phase 8) actually firing, visibly, multiple times. Each retry calls the exact same
`scrollToLocation` again; `VirtualizedList`'s `scrollToIndex` (which `scrollToLocation` delegates to)
cannot jump directly to an index whose cell has never been measured — without `getItemLayout`, it can
only really be confident about cells that have actually rendered. On each failed attempt it does a
best-effort partial scroll and fires `onScrollToIndexFailed`; our handler waits 100ms and tries again,
by which point a little more of the list has rendered/measured, so the next attempt gets closer. That
is inherently a multi-step, visibly-incremental process for a target that starts out far from the
already-measured window — which is *expected, standard* `scrollToIndex`-without-`getItemLayout`
behavior (RN's own docs describe exactly this convergence-by-retry pattern), not a bug in the retry
mechanism itself.

The real remaining problem: **Today's section can genuinely sit many rows down the initially-loaded
window**, and the bounded retry budget (3 attempts × 100ms = 300ms total) isn't reliably enough to
fully converge that far on a real device before giving up. `UPCOMING_INITIAL_PAST_DAYS` was `14` —
generous for "recent context," but every one of those 14 days that happens to have a release
contributes a whole extra section (header + item rows) that Today's target index has to be reached
past. For a library with even a modest release cadence, 14 days of lookback can easily put Today tens
of rows deep — well outside `SectionList`'s default `initialNumToRender` (10), guaranteeing the first
`scrollToLocation` attempt fails and forcing the retry loop to do the "gradual" work Phase 8 only
budgeted 300ms for.

### Chosen fix
Attack the actual distance the scroll has to travel, not just the retry budget:

1. **Shrink `UPCOMING_INITIAL_PAST_DAYS` from 14 to 3.** The task's own product framing was "a
   *small* amount of historical context above Today is fine" — 14 days was more than that phrase
   implies, and directly caused Today's index to be far larger than necessary. 3 days still shows
   Yesterday (and a couple more) without scrolling; anything further back is one scroll-up gesture
   away via the now-correctly-gated `onStartReached` pagination (Phase 9). This is the primary fix —
   it shrinks the worst case so much that the scrollToIndex-without-getItemLayout failure mode rarely
   triggers at all.
2. **`initialNumToRender={30}` on the `SectionList`**, explicitly, instead of RN's own default (10).
   Combined with the 3-day past window, this makes it very likely Today's section is already within
   the very first render pass — meaning the *first* `scrollToLocation` call typically just succeeds,
   with no visible "gradual" retry behavior needed at all in the common case.
3. **Widened the retry budget as defense-in-depth** (not the primary fix, since (1)+(2) should make it
   rarely needed): `MAX_SCROLL_TO_TODAY_RETRIES` 3 → 6, `SCROLL_TO_TODAY_RETRY_DELAY_MS` 100 → 120.
   Still small, still explicitly bounded — a real device with an unusually dense release history (many
   tracked shows, many releases even within a 3-day window) gets more chances to converge rather than
   giving up early and settling on a still-wrong intermediate position.

None of this changes `UPCOMING_INITIAL_FUTURE_DAYS`/`UPCOMING_PAGE_WINDOW_DAYS` (30 each, unchanged) —
future-direction content isn't part of the anchor's scroll target (Today is always the *first*
future-facing content the anchor aims at, never past it), so it was never implicated in this bug.

### Rejected alternatives
- **Keep 14 days of past context, just raise the retry budget much higher (e.g. 15+ retries)** —
  rejected: still fighting the actual distance rather than reducing it, and a large retry budget
  starts to look like masking a real performance/UX problem (a long visible "settling" animation)
  rather than fixing it. A smaller initial window fixes the user-visible symptom directly.
- **Use `getItemLayout` with the historical average item height** — rejected again, same reasoning as
  Phase 8: card/header heights are genuinely variable (wrapping titles, optional badges, optional
  day-count/time text), so an estimated average would be actively wrong for a real fraction of rows,
  not just a performance trade-off.
- **Skip the scroll animation/retry model entirely and use `initialScrollIndex`** — considered;
  `initialScrollIndex` has the exact same "needs `getItemLayout` to be reliable for a deep index"
  limitation as `scrollToLocation`, so it doesn't avoid the core problem, and using it would also
  require restructuring the anchor as a mount-time prop rather than a post-data-ready effect (Today's
  section index isn't known until the query resolves) — no real benefit over the current approach.

### Remaining limitations
- Still fundamentally a best-effort convergence, not a guaranteed-instant jump, for any user whose
  first 3 past days + Today happen to contain enough releases to exceed `initialNumToRender={30}`
  rendered rows — rare, but possible for a very large, very active library. Accepted as a reasonable
  trade-off (matches the task's explicit "do not fake `getItemLayout`" constraint); a future revisit
  could consider computing `initialNumToRender` dynamically from the actual loaded item count instead
  of a fixed constant, if this turns out to still be visible in practice for some users.
- Confirmed via code-level investigation and reasoning about `VirtualizedList`'s documented behavior,
  not via a real device run by me — recommend the user re-verify Phase 8's manual step 2 again after
  this lands.

---

## Phase 12 — Bug fix: auto-load runaway on re-entry, confirmed via a real client-side logger

### Report
User reported, after using the deployed web app: (1) scrolling up manually stopped loading further
past dates, (2) exiting Upcoming (switching to Watch List or another tab) and coming back in
sometimes started loading way-back dates on its own, (3) the "jump to Today" tab-reselect stopped
reliably landing. All three were reported together as one confusing session, with no way for me to
reproduce any of them locally (bugs like this had historically only ever been catchable on a real
device — see Phase 8's own note about RNTL's mocked `SectionList` never firing the relevant events).

This time, a real client-side logger existed (`mobile/src/utils/remoteLogger.ts`, reporting to the
server's `POST /client-logs`, readable via `railway logs`) — added specifically to close this gap.
Reading the actual breadcrumb trail from the user's session turned this from "three vague reports I
can't verify" into a precise, timestamped sequence:

```
watchlist_mode_change: upcoming        (sectionsCount goes to 9, anchored at index 3 — correct)
route_change: Library
route_change: Watchlist
watchlist_mode_change: watchlist       (Upcoming panel now display:'none')
upcoming_auto_load: previous, count=1  ← fired while the panel was HIDDEN
watchlist_mode_change: upcoming
upcoming_auto_load: previous, count=2
route_change: Library
route_change: Watchlist
upcoming_auto_load: previous, count=1  ← 7 of these in under 2 seconds
upcoming_auto_load: previous, count=1
upcoming_auto_load: previous, count=1
upcoming_auto_load: previous, count=1
upcoming_auto_load: previous, count=1
upcoming_auto_load: previous, count=1
upcoming_auto_load: previous, count=2
upcoming_scroll_to_today: tab_reselect, anchorSectionIndex=195, sectionsCount=201
upcoming_scroll_retry × 6 (hit MAX_SCROLL_TO_TODAY_RETRIES and gave up)
```

### Root cause
`onStartReached`/`onEndReached` (and the `canAutoLoadMorePages` gate they call — see Phase 9/11) were
never gated on whether the Upcoming panel was actually the one currently visible. Both Shows-tab
panels stay mounted for the whole session (`display:'none'` toggle, never a real unmount — see
"Frontend structure" above), so these are live callbacks on a component that keeps existing whether or
not it's on screen. Toggling `display:'none'` on/off made react-native-web's `SectionList` misreport
its own viewport as "near the start" right at that transition — and since `hasAnchoredToToday` and
`hasUserScrolled` were already `true` from the *previous* visit (neither resets on a mode switch, only
on an actual date rollover), every other gate in `canAutoLoadMorePages` had already passed. The result:
each hide/show toggle could trigger a fresh auto-load, and the resulting content shift could itself
read as "near the start" again, producing the observed thrashing burst — 9 sections became 201 in
under 2 seconds. That explains all three reported symptoms as one root cause, not three separate bugs:
the runaway loading of far-past dates *is* "started loading way-back dates" (2); once sections ballooned
to 201, Today's real section index (195) landed far outside `initialNumToRender={30}`'s rendered
window, so both the tab-reselect anchor (3) and — most likely — further manual scroll-up gestures (1)
had nothing left to reliably converge onto (the exact `scrollToIndex`-without-`getItemLayout` failure
mode Phase 10 already documented, just triggered by a much larger, spurious distance this time).

### Fix
Added `isActive` as a required, first-checked gate to `canAutoLoadMorePages` (`upcomingGrouping.ts`) —
auto-loading must never fire for a panel that isn't the one currently visible, full stop. Read via a
ref (`isActiveRef`, reassigned every render) rather than closing over the `isActive` prop directly in
`onStartReached`/`onEndReached`: the `display:'none'` toggle and the `SectionList`'s own internal
scroll/layout events don't necessarily settle in the same tick as React committing the new render, so a
callback closure captured just before a mode switch could otherwise still observe the OLD `isActive`
value for one more event — a ref removes that race entirely.

Verified structurally: rapidly bouncing between Home/Watchlist/Watch-List-mode/Upcoming-mode 16 times
in a row (4 full cycles) produced zero `upcoming_auto_load` events and `sectionsCount` stayed at 9
throughout, versus the real-device trail above. Real-device re-verification still recommended (see
Phase 8/10's own notes on this class of bug), but this is the first time a fix in this file has been
built directly from a real user session's evidence rather than local reasoning alone.

### Remaining limitations
- The exact mechanism by which react-native-web's `SectionList` misreports its viewport on a
  `display:'none'` toggle is inferred from the breadcrumb evidence (timing + which gates were already
  satisfied), not from reading react-native-web's own virtualization source — if a future case shows
  auto-loads still slipping through under `isActive` gating, that source is the next place to look.
- `remoteLogger.ts` cannot capture what happens during any given render tick, only discrete named
  events — the "SectionList misreports its viewport" step is a reasonable inference from the data
  available, not something a breadcrumb directly proved.

---

## Phase 14 — Bug fix: auto-load cap resetting itself on every prepend (the actual Phase 11 gap)

### Report
User reported: scrolling up inside Upcoming "just a little bit" started loading a large number of past
dates very fast. `upcoming_auto_load` breadcrumbs (added in Phase 12) made this immediately
diagnosable, not just describable:

```
upcoming_data_ready: totalItemCount=32,  sectionsCount=9,   pagesLoaded=1
upcoming_auto_load: previous, autoLoadCount=1
upcoming_data_ready: totalItemCount=98,  sectionsCount=33,  pagesLoaded=2
upcoming_auto_load: previous, autoLoadCount=1   ← reset back to 1, not 2
upcoming_auto_load: previous, autoLoadCount=1   ← reset again
upcoming_data_ready: totalItemCount=162, sectionsCount=58,  pagesLoaded=3
upcoming_data_ready: totalItemCount=241, sectionsCount=87,  pagesLoaded=4
upcoming_auto_load: previous, autoLoadCount=1   ← still 1, never climbing
upcoming_data_ready: totalItemCount=306, sectionsCount=114, pagesLoaded=5
upcoming_auto_load: previous, autoLoadCount=2
upcoming_data_ready: totalItemCount=350, sectionsCount=127, pagesLoaded=6
... continuing to totalItemCount=523, sectionsCount=181, pagesLoaded=9
```

32 items became 523 across 9 pages in under 5 seconds, from one small scroll gesture.

### Root cause
`MAX_AUTO_LOAD_PAGES_SINCE_RESET = 2` exists specifically to bound this, but the logged
`autoLoadCount` sequence (`1,1,1,1,2,1,1,2...`) shows it almost never got the chance to reach 2 before
being reset back to 0 — meaning `onScroll`'s reset logic was firing on nearly every single auto-loaded
page. The reset conditions (`isScrolledAwayFromStart`/`End`) were written correctly in isolation, but
`UpcomingTimeline.tsx`'s `onScroll` handler only guarded the `hasUserScrolled` **latch** by
`isProgrammaticScrollRef.current` — the counter **resets** right next to it, on the very next two
lines, had no such guard, unconditionally zeroing the counter on *any* qualifying scroll event. Since
prepending a page shifts the list's content without web properly compensating scroll position (the
`maintainVisibleContentPosition` limitation this file already documents extensively — Phase 11), that
shift itself fires an `onScroll` event reporting "away from start", indistinguishable from a real user
scroll to this unguarded code. Each auto-load's own side effect was resetting the exact counter meant
to cap it, before the next load ever had a chance to accumulate past 1.

This is the real, previously-unfixed gap behind Phase 11's fix — Phase 11 correctly identified "web
doesn't compensate scroll position on prepend" as the underlying issue and added the counter+reset
mechanism to survive it, but didn't extend the *existing* programmatic-scroll suppression (already used
for `hasUserScrolled`) to the resets living right beside it.

### Fix
Two changes, `src/components/UpcomingTimeline.tsx`:
1. `onScroll`'s counter resets now also check `!isProgrammaticScrollRef.current`, matching the
   `hasUserScrolled` latch immediately above them.
2. `onStartReached`/`onEndReached` now call `markProgrammaticScroll()` themselves, right when
   triggering `fetchPreviousPage()`/`fetchNextPage()` — not just `scrollToTodaySection` calls as
   before. This marks the auto-load's own resulting content-shift as "ours" at the source, so the
   `PROGRAMMATIC_SCROLL_SUPPRESS_MS` (1500ms) window already used elsewhere now also covers it.

Verified locally (headless, real `SectionList`, not a mock): repeated small scroll-up gestures loaded
exactly one page and stopped, versus an uncontrolled cascade before the fix; waiting past the
suppression window and scrolling again correctly loaded a further page afterward, confirming
pagination itself still works — it's the *runaway*, not scrolling-triggered loading in general, that's
fixed.

### Remaining limitations
- `markProgrammaticScroll()`'s fixed 1500ms window means a user who scrolls hard enough to genuinely
  leave the edge *within* that exact window after an auto-load won't have `hasUserScrolled`/the
  counter reset register until it elapses — accepted as a reasonable trade-off (matches how the same
  constant already behaves for `scrollToTodaySection`), not something this pass tried to make
  adaptive.
- Confirmed via a real user session's breadcrumbs (Phase 12's logging) and a local headless
  reproduction, not a native-device re-test of this exact fix — recommend confirming the "scroll up a
  little" repro no longer runs away on a real device.
