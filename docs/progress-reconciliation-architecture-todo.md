# Episode-Release-Refresh Progress Reconciliation — Architecture TODO

Status legend: `TODO` `IN_PROGRESS` `DONE` `BLOCKED` `DEFERRED`

Scope: fix the systemic bug where `UserSeriesProgress.nextEpisodeId`/`userStatus` never gets
recomputed for a series that already had a future-dated episode locally, once that episode's air
date passes, because `episode-release-refresh`'s apply flow only ever recomputes progress as a
side effect of inserting new episodes (`insertPlan.episodesToInsert.length === 0` early-returns
before any progress write). Confirmed real example: X-Men '97 (`1effb21a-46f9-41f8-8098-d7805ae68373`).
This is a systemic repair — every affected series across the library, not an X-Men-specific patch.

## Phase status overview

| Phase | Description | Status |
|---|---|---|
| 1 | Inspect and design | DONE |
| 2 | Independent reconciliation operation | DONE |
| 3 | Protected status audit | DONE |
| 4 | Fix apply flow (4 combinations) | DONE |
| 5 | Transaction/write safety | DONE |
| 6 | System-wide dry-run audit | DONE |
| 7 | Safe reconciliation/backfill apply | DONE |
| 8 | Scheduling/runtime lifecycle audit | DONE |
| 9 | Tests | DONE |
| 10 | Validate real X-Men case | DONE |

---

## Phase 1 — Inspect and design

### Current write flow, traced exactly (before any change)

**`episode-release-refresh/run-apply-refresh.ts`** (main per-series loop):
1. Live TMDb fetch → `compareSeriesCatalog()` (`refresh-logic.ts`) → `classification` (catalog-only
   diff: is there a provider episode not already local) + independently-computed
   `proposedNextEpisodeId`/`proposedUserStatus`/`nextEpisodeWouldChange`/`userStatusWouldChangeToWatching`
   preview fields (Step 4 of that function — a merged local+provider "as if applied" lookup).
2. `buildEpisodeInsertPlan({classification, newEpisodes, ...})` → `insertPlan.episodesToInsert`.
3. **The bug, exact location**: `if (insertPlan.episodesToInsert.length === 0) { push a report
   entry with progressRecomputed:false, progressChange:null; continue; }` — line ~289. This is
   reached for `classification === NO_CHANGE` (among others), which is exactly X-Men '97's case:
   `providerEpisodeCount === localEpisodeCount` (nothing new to insert), yet the very same
   `comparison` object already contains `nextEpisodeWouldChange: true`,
   `userStatusWouldChangeToWatching: true`. **These correctly-computed preview values are
   discarded, never written, never even passed to anything that could write them.**
4. Only when `insertPlan.episodesToInsert.length > 0` does the loop call
   `applySeriesInsertPlan()` (`apply-refresh-transaction.ts`) at all.

**`applySeriesInsertPlan`** (`apply-refresh-transaction.ts`, the only place this pipeline writes
to the DB today):
1. One transaction. Live-reads `UserSeriesProgress` (never trusts the pre-transaction snapshot).
2. `checkLiveWriteEligibility` (`apply-refresh-writes.ts`) — requires a progress row to exist AND
   `userStatus` in `TRACKED_USER_STATUSES` (`refresh-logic.ts`, currently
   `[WATCHING, CAUGHT_UP, COMPLETED]`). This is the pipeline's existing, single, already-correct
   protected/tracked gate — `PAUSED`/`DROPPED`/`WATCHLIST`/`UNKNOWN` are simply never in this list,
   so none of them are ever touched by this pipeline today, by construction.
3. `createMissingSeasonsAndEpisodes` — inserts Season/Episode rows from `insertPlan`. Never
   touches `EpisodeWatch`/`UserSeriesProgress`.
4. `decideProgressRecompute(episodesInserted, liveUserStatus)` (`apply-refresh-writes.ts`) —
   `shouldRecompute` is `true` **only if `episodesInserted > 0`** (plus still-tracked). This
   function's contract is correct and narrow ("was this recompute triggered by an actual insert
   that just happened") — the bug isn't in this function, it's that nothing else in the pipeline
   ever calls anything equivalent when `episodesInserted === 0` because no insert happened.
5. If `shouldRecompute`: re-fetch full local episode catalog + watches, live, inside the
   transaction; `findFirstUnwatchedEpisodeId` (`src/modules/series/series-query-helpers.ts`) +
   `deriveUserStatusFromNextEpisode` (`src/common/derive-user-status.ts`); **writes
   unconditionally** (no "did the computed value actually differ from what's stored" check before
   the `tx.userSeriesProgress.update()` call) — a second, smaller gap: Phase 5 asks to avoid
   unnecessary writes/`updatedAt` bumps when nothing effectively changed, and today's code doesn't
   check that even on the already-working insert-triggered path.

**Every other `UserSeriesProgress` writer** (re-confirmed, not assumed — matches the audit already
recorded in `docs/on-hold-dropped-status-todo.md` Phase 2/10):
- `episode-watch.service.ts::markWatched` — always recomputes on every real watch (no gap; this
  runs on-demand with fresh data, so it can never go stale the way a bulk-inserted future episode
  can).
- `episode-watch.service.ts::unwatchEpisode` (`unwatch-logic.ts`) — `PROTECTED_STATUSES =
  [DROPPED, PAUSED]`, never touches those; recomputes for everything else on demand.
- watch-all (`watch-all-logic.ts`) — same `PROTECTED_STATUSES`, blocks unless `force=true`.
- `series.service.ts::updateStatus` (`series-query-helpers.ts::deriveManualStatusUpdate`) —
  already fixed in the prior ON_HOLD/DROPPED task to correctly re-derive WATCHING/CAUGHT_UP/
  COMPLETED on resume and preserve `nextEpisodeId` for PAUSED/DROPPED.
- `library-health/run-provider-confirmation-pipeline.ts` (Pipeline A, catalog migration) —
  `PROTECTED_MIGRATION_STATUSES = [DROPPED, PAUSED]`, separate pipeline, out of this task's scope
  (it recomputes progress as part of its own migration-apply transaction, on-demand, not subject
  to this "future episode ages into released" gap — migration only runs once per series).
- `next-episode-backfill/run-backfill.ts` (`derive-next-episode.ts`) — a **separate, one-time**
  backfill script (own header comment: "One-time backfill"), not part of `episode-release-refresh`,
  not touched by this task. Its `deriveNextEpisodeUpdate` is a close relative of what Phase 2 asks
  for (skips `DROPPED/PAUSED/WATCHLIST/UNKNOWN`, plus `COMPLETED` — a narrower scope than mine
  needs, see Phase 3) and independently reuses `deriveUserStatusFromNextEpisode` already — cited
  here as prior art, not imported from (see Phase 2 for why).
- Import (`normalize-watched-episodes.ts`) — write-once at import time, out of scope.

### Smallest safe architectural change

1. **Extract, don't duplicate**: `deriveManualStatusUpdate`'s `WATCHING` branch already does
   exactly "recompute nextEpisodeId + derive WATCHING/CAUGHT_UP/COMPLETED from a local catalog" —
   pull that composition out into a new exported `deriveActiveProgress()` in
   `series-query-helpers.ts` (same file, zero new dependency edges), and have
   `deriveManualStatusUpdate` call it. Behavior-preserving refactor (existing tests must stay
   green unchanged).
2. **New, independent, first-class reconciliation operation** — a new pure function
   `reconcileSeriesProgress()` in a new file `episode-release-refresh/progress-reconciliation-logic.ts`,
   built on top of `deriveActiveProgress()` (reused from `series-query-helpers.ts`), that adds:
   protected/tracked-status gating (reusing `TRACKED_USER_STATUSES` from `./refresh-logic`, not a
   second copy), and a stored-vs-computed comparison producing a classified outcome (unchanged /
   changed+mismatch-type / protected / not-tracked). This function takes **only local data** — no
   provider fetch, no TMDb — matching Phase 2's explicit "from the current local catalog, release
   dates, watch history, and release status" and enabling Phase 6's fully offline, no-network audit.
3. **New, independent write path** — `applyProgressReconciliation()` in a new file
   `episode-release-refresh/apply-progress-reconciliation.ts`, mirroring `applySeriesInsertPlan`'s
   existing conventions exactly (one transaction, live re-read, never trusts the pre-transaction
   snapshot, re-checks protection live) but touching **only** `UserSeriesProgress` — never
   `Season`/`Episode`. Returns the exact same result shape (`progressRecomputed`, `progressChange`,
   `progressSkippedReason`, `writeSkippedReason`) `applySeriesInsertPlan` already returns, so
   `run-apply-refresh.ts`'s report-building code needs only a branch, not a redesign.
4. **Fix the apply loop**: `run-apply-refresh.ts`'s `insertPlan.episodesToInsert.length === 0`
   branch now calls `applyProgressReconciliation` (dry-run: computes and reports without writing;
   apply: writes only if changed) instead of unconditionally skipping.
5. **Close the second gap**: `applySeriesInsertPlan`'s existing insert-triggered recompute now
   also skips the write when computed values equal what's already stored (case 2: catalog changed,
   progress did not) — via a tiny shared `hasProgressChanged()` pure helper, reused by both write
   paths, avoiding a duplicated inline comparison.
6. **New standalone CLI + reports** for Phase 6/7 — `episode-release-refresh/run-progress-reconciliation.ts`
   (dry-run by default, `--apply`, `--series=<id>`), `progress-reconciliation-reports.ts` (I/O:
   markdown/JSON, matching this pipeline's existing report-writer conventions).

`RefreshClassification`/`compareSeriesCatalog`'s existing `classification` field is **not**
renamed or split — it already correctly means "catalog delta" and is heavily reused across
`refresh-operating-outcome.ts`, `reports.ts`, `run-refresh.ts`, and their tests. Renaming it to
`catalogClassification` would be a large, purely-cosmetic, high-blast-radius change for no
functional gain. Instead, the new `reconcileSeriesProgress()` outcome type (`protected` /
`not-tracked` / `unchanged` / `changed`) **is** the "progress classification, kept separate from
catalog classification" the task describes — implemented as its own dedicated, clearly-named type
rather than bolted onto the existing one. Documented here as the deliberate answer to "if needed."

---

## Phase 2 — Independent reconciliation operation

`reconcileSeriesProgress()` — see Phase 1 design above. Determines, from local data only:
first unwatched released episode (`findFirstUnwatchedEpisodeId`, reused, unchanged) → correct
`nextEpisodeId` → correct derived status (`deriveUserStatusFromNextEpisode`, reused, unchanged):
`WATCHING` if a next episode exists; else `CAUGHT_UP` (returning/in-production/unknown) or
`COMPLETED` (ended/cancelled) via the exact same function every other write path already trusts.
No new derivation math anywhere — 100% composed from existing canonical helpers.

---

## Phase 3 — Protected status audit

**Reconciliation only ever runs for `TRACKED_USER_STATUSES = [WATCHING, CAUGHT_UP, COMPLETED]`**
— reused directly from `episode-release-refresh/refresh-logic.ts` (not redefined), the exact same
constant this pipeline's eligibility (`checkSeriesEligibility`) and existing write gate
(`checkLiveWriteEligibility`, `decideProgressRecompute`) already use. Every other status is
excluded, each for a distinct, already-established reason — no new rule invented:

| Status | Included? | Justification (from existing codebase) |
|---|---|---|
| `WATCHING` | Yes | Active; has (or should have) a real next episode |
| `CAUGHT_UP` | Yes | Active; `nextEpisodeId` legitimately null until something releases — exactly X-Men '97's case |
| `COMPLETED` | Yes | Included on purpose, unlike `next-episode-backfill`'s narrower one-time scope (see Phase 1) — this task's own Phase 6 explicitly requires detecting "stale COMPLETED" as a mismatch category, so it must be recomputed and compared, not blanket-skipped |
| `PAUSED` | **No — protected** | `docs/status-model-plan.md` §4: "User-controlled only — no derivation rule." Matches `PROTECTED_USER_STATUSES` (`src/common/derive-user-status.ts`), `PROTECTED_MIGRATION_STATUSES` (`library-health/migration-confirmation-logic.ts`), and watch-all/unwatch's own `PROTECTED_STATUSES` — every existing automated writer already agrees on this |
| `DROPPED` | **No — protected** | Same as `PAUSED` — explicit user intent, never auto-overridden anywhere in this codebase |
| `WATCHLIST` | No — not applicable | `docs/status-model-plan.md` §4: "hasn't started (0 episodes watched)" — no next-episode concept applies; already excluded from `TRACKED_USER_STATUSES` today |
| `UNKNOWN` | No — not applicable | "not enough signal yet to classify" — same reasoning, already excluded today |

No new status rule was invented — this is a direct reuse of the pipeline's own existing,
already-tested eligibility gate, applied consistently to the new reconciliation path.

---

## Phase 4 — Fix apply flow

Four combinations, all now handled explicitly in `run-apply-refresh.ts`:

1. **catalog no / progress no** — `insertPlan` empty, `reconcileSeriesProgress` returns
   `unchanged` → report only, zero writes.
2. **catalog yes / progress no** — `applySeriesInsertPlan` inserts episodes, but the new
   `hasProgressChanged` check finds the recomputed value equals what's stored → episodes inserted,
   progress write skipped (new; previously always wrote).
3. **catalog no / progress yes** — **the bug's exact case.** `insertPlan` empty →
   `applyProgressReconciliation` (new) recomputes and writes only `UserSeriesProgress`, no
   Season/Episode touch. This is X-Men '97's case.
4. **catalog yes / progress yes** — unchanged from before: `applySeriesInsertPlan` inserts and
   recomputes, now also with the case-2 unnecessary-write guard applied uniformly.

---

## Phase 5 — Transaction and write safety

- Both write paths (`applySeriesInsertPlan`, `applyProgressReconciliation`) are single
  transactions, live-reading progress/series/episodes *inside* the transaction — no reliance on
  the pre-transaction candidate snapshot (matches the existing, already-correct convention).
- `hasProgressChanged()` (new, pure, shared) gates the actual `tx.userSeriesProgress.update()`
  call in both paths — a Prisma `update()` (which bumps `@updatedAt`) is only ever issued when the
  computed `userStatus`/`nextEpisodeId` genuinely differ from what's stored.
- `EpisodeWatch` is never read for writing (only for the `watchedEpisodeIds` lookup) and never
  touched by either path.
- One transaction per series (existing convention) — no cross-series coupling, one series'
  failure can't affect another's.

---

## Phase 6/7 — Dry-run audit and safe apply

Status: DONE. Real run against the dev database, 2026-07-11. Tooling:
`episode-release-refresh/run-progress-reconciliation.ts` (`--apply`, `--series=<id>`), reusing
`reconcileSeriesProgress`/`applyProgressReconciliation` directly — the CLI is a thin orchestration
layer, not a second implementation.

**Dry run** (390 rows inspected — every `WATCHING`/`CAUGHT_UP`/`COMPLETED`/`PAUSED`/`DROPPED` row
for the dev user):

| Category | Count |
|---|---|
| `stale-caught-up-with-released-unwatched-episode` | 3 |
| `stale-watching-with-no-released-unwatched-episode` | 0 |
| `wrong-or-null-next-episode-id` | 8 |
| `stale-completed` | 19 |
| `protected-manual-status-skipped` | 64 |
| `no-tmdb-id-skipped` | 97 |
| `no-mismatch` | 199 |

30 real mismatches total: **26 safe to auto-apply, 4 unsafe** (all 4 are `stale-completed` on
titles from the existing episode-numbering risk list — `Dragon Ball GT`, `Seraph of the End`,
`Tales of Zestiria the X`, `The Seven Deadly Sins: Four Knights of the Apocalypse` — correctly
routed to manual review rather than applied).

**Apply run**: all 26 safe mismatches applied successfully (`X-Men '97` among them: `CAUGHT_UP/null
→ WATCHING/c043e10f-...`). Zero errors.

**Post-apply audit** (re-run immediately after): **0 safe mismatches remaining.** The 4 unsafe
ones are unchanged (still flagged, still not applied) — exactly Phase 7's required outcome.

**Idempotency, verified on real data**: a third run (`--apply` again) reported `applied: 0` —
the second apply made zero further changes.

Risk-list series (`isUntrustedNextEpisodeTitle`, `src/common/stale-series-trust.ts` — the same
existing "don't trust this series' next-episode data" list `checkSeriesEligibility` already
consults) are excluded from auto-apply and routed to manual review, even if otherwise tracked and
non-protected — reusing an existing safety list, not inventing a new one. Confirmed to matter in
practice: this is exactly what caught the 4 unsafe `stale-completed` cases above.

---

## Phase 8 — Scheduling/runtime lifecycle

No scheduler exists anywhere in this app (`docs/episode-release-refresh-strategy.md` §5, already
confirmed absent: no `@nestjs/schedule`, no cron, no CI schedule, no startup hook) and this task
does not add one. See final report §11 for the precise operational implication.

---

## Unresolved risks

- The system still requires a human to run `episode-release-refresh` (or the new
  `run-progress-reconciliation.ts`) for a previously-future local episode to actually surface in
  Watch Next — this fix makes that run *effective* once it happens; it does not make it automatic.
  Recorded as a separate, explicit product/infrastructure decision per Phase 8's instruction.
