# Status Model Plan

Design for separating "is this show still airing" (a public fact, sourced from TMDb/Trakt) from "where am I personally at with it" (a personal fact, mostly user-controlled).

**Status of this document:** the core model below (§3, §4, §6, §8) has been applied — `Series.releaseStatus`/`UserSeriesProgress.userStatus` exist in the schema, the TV Time importer and `markWatched` write them, and the 433 imported series have been backfilled. This revision corrects and sharpens two things that turned out to be under-specified in that first pass (both clarifications, not schema or behavior changes to what's already live): the precise TV-Time-derivable subset of `userStatus` values (see the new subsection in §4), and the exact "Haven't Watched For A While" filter (§8). It also documents the dry-run enrichment reports' new preview fields (§7a) that show what §7's not-yet-built apply step *would* do, without doing it. **No `prisma/schema.prisma` changes in this revision, and no enrichment apply step exists or was added.**

## 1. What exists today, and the actual problem

Inspected directly (schema + the services that read/write these fields), not assumed:

- `Series.status` (`SeriesStatus`: `ONGOING` / `ENDED` / `CANCELED`) — **defaults to `ONGOING`** for every new row, including every one of the 430 TV Time-imported series that have never been checked against any real metadata provider. That default isn't "unknown," it's a confident-sounding claim MyTv has no basis for. This is a real bug the current design has, not just a naming gap.
- `UserSeriesProgress.status` (`ProgressStatus`: `WATCHING` / `COMPLETED`) — two values doing the job of at least four real distinctions that are currently conflated:
  - The TV Time importer (`import-tvtime/normalize-watched-episodes.ts:234`) sets **every** imported series with any watched episode to `WATCHING`, unconditionally — it completely ignores TV Time's own `is_archived` flag (which the audit already identified, `docs/tvtime-data-audit.md` §3.6, as the closest thing TV Time has to "the user gave up on this show"). A show the user explicitly archived in TV Time looks identical, in MyTv today, to one they're actively watching tonight.
  - `WATCHING` also conflates "there's a next episode and I'm actively going through it" with "I've watched everything that exists so far and I'm just waiting for more" — `src/modules/episodes/episode-watch.service.ts:37-42` only ever writes `WATCHING` or `COMPLETED`, and `COMPLETED` itself conflates "the show is fully over and I finished it" with "I'm caught up on an ongoing show." `API_CONTRACT.md:15` already gestures at this exact ambiguity ("`COMPLETED` means the user has watched every episode that exists right now") without actually resolving it — this plan resolves it.
  - There's no "paused" or explicit "dropped" at all today.
- `WatchlistItem` is a **separate table** from `UserSeriesProgress`, with no status enum of its own — a series is either "has a `WatchlistItem` row" or not, with no further nuance, and (today) a series can have a `WatchlistItem` with zero corresponding `UserSeriesProgress` row (nothing watched yet) — the two tables don't currently overlap in a series' early life.

## 2. Design principles (carried over from the rest of this project's docs, applied here)

- **Provider data never overwrites user intent.** If a user explicitly paused or dropped a show, an enrichment pass discovering "oh, this show actually ended in 2019" changes `releaseStatus`, never `userStatus`. The reverse is also true: nothing about a user's personal status ever writes to `releaseStatus`.
- **`unknown` is an honest answer, `ongoing`/`watching`-by-default is not.** Mirrors this project's existing "nullable over invented" principle (`docs/mytv-prisma-schema-plan.md` §3) — a status nobody has verified should say so, not default to whichever value happens to sound normal.
- **A fresh user action is the strongest signal available and wins immediately.** Marking an episode watched is unambiguous proof of current engagement — it should clear `paused`/`dropped` without requiring a separate "resume" action, the same way it already implicitly means "take this off the watchlist."
- **Computed statuses stay computed; explicit statuses stay explicit.** `caught_up`/`completed` are derived from data (episode catalog + release status) and get recomputed as that data changes. `paused` has no derivation rule at all — it only exists because a user set it, and only stops existing because a user (or a fresh watch) cleared it. Conflating the two (e.g. auto-pausing something because it's gone stale) would mean the backend silently guessing at intent, which this project has consistently avoided elsewhere.

## 3. A. `Series.releaseStatus` — the public fact

```
returning | ended | cancelled | in_production | unknown
```

Entirely provider-derived. **Never user-editable, never touched by watch activity.** Replaces `SeriesStatus`/`Series.status`; default changes from today's `ONGOING` to **`unknown`** — the concrete fix from §1.

### Derivation

| MyTv `releaseStatus` | TMDb `status` (confirmed, `docs/tmdb-enrichment-plan.md` §2) | Trakt `status` (expected, **unconfirmed** — `docs/trakt-enrichment-plan.md` §2) |
| --- | --- | --- |
| `returning` | `Returning Series` | `returning series` (provisional) |
| `ended` | `Ended` | `ended` (provisional) |
| `cancelled` | `Cancelled` | `canceled` (provisional) |
| `in_production` | `In Production`, `Planned`, `Pilot` | `upcoming` (provisional) |
| `unknown` | *(no enrichment run yet, or enrichment result was `NEEDS_REVIEW`/`NO_MATCH`)* | same |

`Planned` and `Pilot` both collapse into `in_production` — a deliberate many-to-one simplification. MyTv's vocabulary is coarser than TMDb's on purpose: for a personal tracker, "confirmed but not filming yet" and "actively filming" both mean the same actionable thing ("don't expect new episodes soon"), so splitting them isn't worth a fifth value. The Trakt column stays marked provisional until a live call confirms it, consistent with how both enrichment plan docs already flagged this field.

Only an **`AUTO_MATCH`**-tier enrichment result writes `releaseStatus` (never `NEEDS_REVIEW`/`NO_MATCH` — an uncertain match shouldn't assert a confident public fact). Unlike most enrichment fields (which use fill-if-null, per `docs/trakt-enrichment-plan.md` §4 step 6), **`releaseStatus` is always refreshed on a fresh confident match, not just filled when null** — it's a genuinely time-varying fact (a show can go from `returning` to `ended` between two enrichment runs), so "first write wins" would let it go stale in exactly the case where staying current matters most.

## 4. B. `UserSeriesProgress.userStatus` — the personal fact

```
watchlist | watching | paused | dropped | caught_up | completed | unknown
```

Replaces `ProgressStatus`/`UserSeriesProgress.status`. Each value, what it means, and where it comes from:

| `userStatus` | Meaning | Source |
| --- | --- | --- |
| `watchlist` | Wants to watch, hasn't started (0 episodes watched) | **User-controlled** (explicit add-to-watchlist action) — or initialized from TV Time's `is_for_later` on import |
| `watching` | Has watched at least one episode, more known episodes remain | **Auto-derived** from watch activity + known episode catalog; also the state a fresh watch action always re-asserts |
| `paused` | User knows they stopped, plans to resume | **User-controlled only** — no derivation rule, no TV Time import signal maps to this (TV Time has no "pause" concept in anything the audit found) |
| `dropped` | User gave up, doesn't intend to resume | **User-controlled** (explicit action) — or initialized from TV Time's `is_archived` on import |
| `caught_up` | Watched everything currently known to exist, but the show is still `returning`/`in_production`/`unknown` — more could air | **Auto-derived** from `nextEpisodeId IS NULL` + `Series.releaseStatus` |
| `completed` | Watched everything, and the show's `releaseStatus` is `ended`/`cancelled` — nothing more is coming, ever | **Auto-derived**, same inputs as `caught_up`, opposite `releaseStatus` condition |
| `unknown` | A row exists but there isn't enough signal yet to classify it | System fallback — not user-settable, not provider-derived, just an honest "don't know yet" |

**This table is exhaustive — these seven values are the entire stored vocabulary.** Anything that reads like a status but isn't in this list (e.g. "stale," "haven't watched in a while") is **not** a `userStatus` value and never will be — it's a *derived, computed-at-query-time filter* over these seven values plus `lastWatchedAt`, not an eighth thing to store. §8 covers this distinction in detail for Home specifically, but the principle is general: if a "status" can be recomputed identically from other columns on demand, it doesn't get its own enum value, on this project's usual bias against storing what can be derived.

### TV Time alone cannot tell us `caught_up` or `currently watching` — only three of these seven values are safely TV-Time-derivable

This is worth stating as its own rule, not just a caveat buried in §5's table, because getting it wrong would mean writing confident-sounding lies into `userStatus` exactly the way the old `WATCHING`-by-default bug did into `Series.status` (§1). TV Time's export gives MyTv exactly three reliable signals about personal status, and no more:

- **`dropped`** — from TV Time's `is_archived` flag. A real, explicit signal: the user told TV Time they're done with this show.
- **`watchlist`** — from TV Time's `is_for_later` flag (or a dedicated watchlist source, per `docs/tvtime-data-audit.md` §3.6). Also real and explicit.
- **`watching`** — **not** a real signal at all, despite the name. TV Time never tells MyTv "the user is actively, currently watching this show" as a distinct fact — it only tells MyTv *that some episodes were watched*. `watching` on import is a **non-committal placeholder**: "this series has watched episodes and isn't archived," nothing more. It is deliberately the least-informative label in the enum, chosen only because MyTv has no better word for "some signal exists, but not enough to say more" without inventing an eighth value.

**`caught_up` and `completed` must never be assigned from TV Time data alone, under any circumstance, no matter how the `is_archived`/`is_for_later`/watched-count signals are combined.** Both require knowing the show's *full* episode catalog (to know there's nothing left unwatched) and its `releaseStatus` (to know whether "nothing left unwatched, for now" means "caught up" or "completed, forever") — and TV Time's export contains neither. It only ever tells MyTv about episodes the user personally interacted with, never a show's complete episode list, and it has no field resembling `releaseStatus` at all (§1, §3). These two values only become derivable **after** a TMDb/Trakt enrichment pass has resolved both facts for a given series — see the new §7a below for exactly how that shows up today, ahead of any actual `userStatus` write happening.

### Does `watchlist` merge `WatchlistItem` into `UserSeriesProgress`, or stay separate?

The requirement lists `watchlist` as a `userStatus` value, which means `UserSeriesProgress` needs to represent "on the watchlist, not started" as one of its states — but today `UserSeriesProgress` rows only get created once there's a watched episode (`import-tvtime/normalize-watched-episodes.ts:229-241`; the live `markWatched` path is the same), while `WatchlistItem` is created independently and can exist with zero corresponding `UserSeriesProgress` row.

**Recommendation: keep both tables, stop treating `UserSeriesProgress` creation as conditional on having watched something.** A `UserSeriesProgress` row should exist for *any* series the user has *any* relationship with — watchlisted, watching, paused, dropped, caught up, or completed — making it the single place to answer "what's my status with this series," while `WatchlistItem` stays as the lightweight companion record of *when and how* it was added to the watchlist (it already has useful provenance fields — `addedAt`, `rawMetadata` for TV Time source reconciliation — that don't belong on the broader progress row). The **Watchlist screen keeps querying `WatchlistItem` directly** (§6) — least churn, already built, already indexed correctly — while `UserSeriesProgress.userStatus = watchlist` stays in sync for the *other* screens/consistency (so a future "everything I'm watching" view doesn't need to separately know about `WatchlistItem` to exclude not-yet-started series). This is presented as a recommendation for the schema-change pass, not applied now.

## 5. How imported TV Time data should initialize these statuses

Concrete rules, replacing the current unconditional `WATCHING` default (`import-tvtime/normalize-watched-episodes.ts:234`):

| TV Time signal (from `tracking-prod-records-v2.csv` `user-series-*` rows) | Episodes watched? | → `userStatus` |
| --- | --- | --- |
| `is_archived = true` | any | `dropped` |
| `is_archived = true` | none, and not `is_for_later` | *(no row created — no real relationship to record)* |
| `is_for_later = true`, `is_archived = false` | none | `watchlist` |
| `is_archived = false`, not `is_for_later` (or `is_for_later` but already started) | ≥ 1 | `watching` *(see caveat below)* |
| no usable signal at all | — | *(no row created)*, or `unknown` if a row must exist for another reason |

**Important caveat on the `watching` row above:** at TV-Time-import time, MyTv doesn't yet have a full episode catalog for that series (`docs/mytv-prisma-schema-plan.md` §6 — `nextEpisodeId` is deliberately left `null` on import, "unknowable until a future Trakt/TMDb enrichment pass"). That means the import step genuinely **cannot** distinguish `watching` from `caught_up` from `completed` yet — it doesn't know if there are more episodes. `watching` is used here as an honest, non-committal placeholder ("this user has an active relationship with this show"), not a claim that more episodes are known to exist. **§7 closes this loop**: the first enrichment pass that successfully resolves a series' full catalog must re-run the `watching`/`caught_up`/`completed` derivation for it, exactly once real data is available to make that call.

`paused` is never set by import — there is no TV Time source for it (§4).

## 6. How marking an episode watched should update `userStatus`

Replaces `src/modules/episodes/episode-watch.service.ts`'s current always-`WATCHING`-or-`COMPLETED` logic. On every successful watch:

1. Recompute `nextEpisode` exactly as today (`findNextEpisode` — same-series next-in-sequence lookup against whatever episode catalog MyTv currently has).
2. **Always overwrite `userStatus`** with the result below — a fresh watch is the strongest available signal and should clear any prior `paused`/`dropped`/`watchlist` state without a separate "resume" step:
   - Next episode found → `watching`
   - No next episode found, and `Series.releaseStatus` is `ended` or `cancelled` → `completed`
   - No next episode found, and `Series.releaseStatus` is `returning`/`in_production`/`unknown` → `caught_up`
3. `lastWatchedAt` updates to the new watch's timestamp, same as today.

One derivation function — `deriveUserStatus(nextEpisodeExists, releaseStatus)` — covers all three outcomes and is reused by both the live `markWatched` flow and the enrichment re-evaluation in §7, so the two paths can never disagree about what "caught up" means.

## 7. How TMDb (and later Trakt) enrichment should update `releaseStatus` — and cascade into `userStatus`

1. **Write `releaseStatus`** per the §3 mapping, only from `AUTO_MATCH`-tier results, always overwritten (not fill-if-null) since it's time-varying.
2. **When enrichment resolves a series' full episode catalog for the first time**, recompute `nextEpisodeId` for that series against the newly-known catalog, then re-run the same `deriveUserStatus` function from §6 for every row currently sitting at `watching` (the import-time placeholder from §5) — this is the concrete mechanism that closes the "MyTv can't tell `watching` from `caught_up` until enrichment happens" gap. Rows already at `paused`/`dropped`/`watchlist` are **not** touched by this — those are user intent, not a data-completeness artifact.
3. **When `releaseStatus` transitions into `ended`/`cancelled`** for a series where `userStatus = caught_up`, flip it to `completed` (nothing more is coming, and the user had already watched everything known). Symmetrically, if a `completed` show's `releaseStatus` ever moves *back* out of `ended`/`cancelled` (a revival — rare, but real), flip `completed` back to `caught_up`. Neither direction touches `watching`/`paused`/`dropped`/`watchlist`.
4. Same non-clobbering rule as everywhere else in this project's enrichment design: episode-level fields (`title`/`overview`/`airDate`) stay fill-if-null; only `releaseStatus` and its `userStatus` cascade are exceptions, because they're the two fields in this whole model that are expected to genuinely change over the life of a show.

## 7a. What's actually implemented today: the dry-run report *previews* this cascade, without applying it

§7 describes what an eventual **apply** step should do — that step doesn't exist yet (`docs/trakt-enrichment-plan.md` §8, `docs/tmdb-enrichment-plan.md` §9: both pipelines are dry-run only, no writes to `Series`/`UserSeriesProgress`). What exists today is a **preview**: `trakt-enrichment-report.json` and `tmdb-enrichment-report.json` each compute, for every candidate where the full episode catalog was fetched (`AUTO_MATCH` tier, and `NEEDS_REVIEW` entries where a top candidate was fetched), three additional fields showing *what §7's cascade would do if it ran*, without running it:

- **`currentUserStatus`** — the series' actual `userStatus` right now, read directly from `UserSeriesProgress`.
- **`proposedUserStatusAfterEnrichment`** — what `userStatus` would become if this candidate's data were applied, computed by the same rules as §6/§7 but never written anywhere:
  - `currentUserStatus` is `dropped` or `paused` → **unchanged**. These are user intent; per §2's principle, enrichment discovering a fuller catalog never overrides them, preview or not.
  - Nothing watched yet (`watchedEpisodeCount = 0`) → **unchanged**. A `watchlist`/`unknown` series isn't affected by learning how many episodes a show has; nothing about "have I watched anything" changed.
  - Otherwise, compare `watchedEpisodeCount` against the newly-known total episode count: watched everything known → `completed` (if the candidate's provider status maps to `ended`/`cancelled`) or `caught_up` (otherwise); still behind → `watching`.
- **`userStatusChangeReason`** — a human-readable sentence explaining the above, e.g. *"full episode catalog now known (24 episodes); watched 12/24 — would move to WATCHING"* or *"current status is DROPPED (user-controlled) — enrichment never overrides explicit personal status."*

This is deliberately **report-only** — it answers "what would happen," it doesn't make it happen. The provider `status` string (Trakt/TMDb) is mapped to a candidate `releaseStatus` purely for this preview calculation (`trakt-enrichment/release-status-mapping.ts`, `tmdb-enrichment/release-status-mapping.ts`) and is never written to `Series.releaseStatus` by either pipeline. Same caveat as everywhere else this project has touched Trakt's `status` field: TMDb's mapping is confirmed (`docs/tmdb-enrichment-plan.md` §2), Trakt's is still provisional.

## 8. How Home sections should use these statuses

**Important correction: "Haven't Watched For A While" is not, and will never be, a `userStatus` value.** It has no row in the §4 table because it isn't personal-status information at all — it's a *derived Home section*, computed at query time from `lastWatchedAt` against the seven real `userStatus` values. Calling it "the stale status" (even informally) would be wrong in the same way calling `releaseStatus`'s absence "the unknown status" would undersell that `unknown` already covers that case — staleness isn't a state a series is *in*, it's a filter condition MyTv evaluates fresh on every `/home` call. Nothing about this section writes or reads a stored "stale" flag anywhere.

| Section | Query (under the new model) | Notes / behavior change from today |
| --- | --- | --- |
| **Watch Next** | `UserSeriesProgress WHERE userStatus = 'watching' AND nextEpisodeId IS NOT NULL`, order by `lastWatchedAt desc` | Same shape as today's query, just precise now — today's `WATCHING` filter accidentally would have included what should be `caught_up`/`paused`/`dropped` rows once those states exist; the new filter genuinely excludes them |
| **Haven't Watched For A While** | `UserSeriesProgress WHERE userStatus IN ('watching', 'caught_up') AND lastWatchedAt < cutoff`, order by `lastWatchedAt asc` | An **include-list**, not an exclude-list, on purpose — see below |
| **Recently Watched** | Unchanged — pure `EpisodeWatch` history, no `UserSeriesProgress`/status involvement | Worth stating explicitly: a recently-watched episode is a historical fact and shows up regardless of the series' *current* `userStatus`, even if the user dropped the show five minutes after watching it |
| **Watchlist** | Unchanged — `WatchlistItem` for the user, ordered by `addedAt desc` (§4's recommendation to keep this table as the query source) | No behavior change; `userStatus = watchlist` on the corresponding `UserSeriesProgress` row is kept in sync but isn't what this screen queries |

**"Haven't Watched For A While," precisely:**
- `userStatus` is `watching` **or** `caught_up` — an explicit include-list rather than "everything except a few excluded values," so the section can never silently start showing a new `userStatus` value added later without a deliberate decision to include it. (`caught_up` can't exist in real data yet — nothing assigns it before enrichment ships, §7a — but the filter is written to already be correct once it can.)
- `lastWatchedAt` is older than the threshold (unchanged from today).
- Never `dropped` (the user already told MyTv they know — re-nudging is noise) or `completed` (nothing to watch, staleness is irrelevant) — both already excluded by the include-list above, called out explicitly here because they're the two cases most likely to be assumed rather than checked.
- Never `watchlist` (never started, so "haven't watched in a while" doesn't apply — also already excluded by the include-list).
- **Never `paused`, at least for now** — a user who explicitly paused a show already told MyTv they know they stopped; re-surfacing it as "haven't watched in a while" is redundant with information the user already gave. This is a deliberate, revisitable choice, not settled permanently — if it turns out users want paused-but-old shows resurfaced as a gentle "still want to get back to this?" nudge, that's a one-line change (add `paused` to the include-list), not a redesign.

`paused`, `dropped`, and `completed` series are **deliberately invisible to all four sections above** — that's the functional point of those statuses existing (decluttering Home). A future "all series" or "paused/dropped" management view would be the place to surface them; out of scope here.

## 9. Schema change summary (for the future implementation pass — not applied now)

- Rename `SeriesStatus` → (e.g.) `ReleaseStatus`, values `ONGOING/ENDED/CANCELED` → `RETURNING/ENDED/CANCELLED/IN_PRODUCTION/UNKNOWN`; rename `Series.status` → `Series.releaseStatus`; change `@default(ONGOING)` → `@default(UNKNOWN)`.
- Rename `ProgressStatus` → (e.g.) `UserSeriesStatus`, values `WATCHING/COMPLETED` → `WATCHLIST/WATCHING/PAUSED/DROPPED/CAUGHT_UP/COMPLETED/UNKNOWN`; rename `UserSeriesProgress.status` → `UserSeriesProgress.userStatus`.
- Both are additive-shaped renames (new enum, column swap) — doable as a non-destructive migration (add new enum/column, backfill, drop old), not a data-loss risk, consistent with every other migration in this project so far.
- No change needed to `WatchlistItem` itself (§4) — the only behavior change is that `UserSeriesProgress` rows start getting created earlier (at watchlist-add time, not just first-watch time), which is an application-logic change, not a schema change.
- `Series.releaseStatus` default correction (`ONGOING` → `UNKNOWN`) applies to **existing rows** too — a backfill setting every currently-`ONGOING` (i.e., every row, since nothing has been enriched yet) `Series.status` to `UNKNOWN` would need to run alongside the migration, otherwise 433 series would falsely read as "confirmed still airing."

## 10. Risks / open questions

- **The `watching` re-evaluation in §7 step 2 needs to run for all 390 currently-`WATCHING` imported series once enrichment lands** — a real, sizeable backfill, not a one-off. Should be designed as its own idempotent pass (similar shape to the existing `trakt-enrichment`/`tmdb-enrichment` dry-run → apply split) rather than folded silently into the enrichment apply step.
- **`paused` vs. dropped-but-not-told-us.** Some fraction of series currently sitting at `watching` are, realistically, shows the user quietly stopped caring about without ever archiving them in TV Time (`is_archived` only catches explicit archival). This model doesn't try to guess that — per §2's principle, an unstated abandonment stays `watching` (and surfaces via "Haven't Watched For A While") rather than being inferred into `dropped`. Worth revisiting only if that turns out to be poor UX in practice, not pre-solved here.
- **Trakt's `status` enum is still unconfirmed** (§3) — carried over as an open item from both enrichment plan docs, not resolved by this document.
- **Revival handling (§7 step 3)** is specified but not going to come up often — low priority to implement first, included for completeness rather than urgency.

## 11. Explicitly not done (as of this revision)

- No `prisma/schema.prisma` changes in this revision — §9's schema (already applied in an earlier pass) is unchanged; this revision is docs plus the §7a report-preview fields plus the §8 stale-filter correction in `me.service.ts`.
- No enrichment **apply** step exists or was added — `trakt-enrichment`/`tmdb-enrichment` remain dry-run only, confirmed by the same structural check used throughout this project (no write calls to any app-facing table). §7a's preview fields are computed and reported, never written.
- No live Trakt/TMDb calls were required to make this revision's changes — the report-preview fields and doc corrections don't depend on calling either API, only on data already fetched by prior/future dry runs.

## 12. `PATCH /series/:seriesId/status` — two bugs found and fixed (2026-07-11)

Full detail in `docs/on-hold-dropped-status-todo.md` (written for a task that set out to "add
ON_HOLD/DROPPED" and discovered both already existed as `paused`/`dropped`, end to end, except for
two real bugs in this endpoint and a missing mobile UI). Recorded here too since this is the
model's own authoritative doc:

1. **Resuming (`userStatus: WATCHING`) used to always write literal `WATCHING`**, even when the
   correct derived status was `caught_up` or `completed` (e.g. resuming a `paused` series that's
   already watched everything currently known, on a still-`returning` show, incorrectly became
   `watching` instead of `caught_up`). Fixed: the `WATCHING` branch now runs the exact same
   `deriveUserStatusFromNextEpisode` §6 uses, instead of hardcoding `WATCHING`.
2. **Pausing/dropping used to null `nextEpisodeId`** instead of preserving it, contrary to this
   task's own principle of not throwing away a value the app already had correctly computed.
   Fixed: `paused`/`dropped` now carry the row's existing `nextEpisodeId` forward unchanged, so a
   later resume is immediate and correct without needing a fresh recompute.

Both were pure logic bugs in `series-query-helpers.ts::deriveManualStatusUpdate` — no schema
change, no data migration, no change to watch-history safety (already correct, verified
end-to-end against a `paused`↔`dropped`↔`watching` round trip on real dev-DB series, including a
real 53-row `dropped` cohort from the original TV Time import).

A mobile-side status-actions menu (`SeriesDetailScreen`, `src/utils/seriesStatusActions.ts`) now
also exists, so `paused`/`dropped` are reachable from the app for the first time — previously the
endpoint existed but nothing in the client called it.
