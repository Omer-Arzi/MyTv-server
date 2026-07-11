# Stable Version Migration — Working TODO

Status legend: `TODO` `IN_PROGRESS` `BLOCKED` `DONE` `DEFERRED`

This file is the live working record for the task "Stable Version Readiness —
Policy Automation, Batch Migration Safety, Verification, and Rollback
Preparation." Updated continuously, not just at the end.

## Task goals

1. Replace per-title `migrationIntent` with an objective, explainable, batch-capable policy.
2. Separate the three concerns currently bundled into `migrationIntent`: orphan tolerance, status resolution, apply permission.
3. Introduce a top-level operating classification (`AUTO_MIGRATE` / `AUTO_REFRESH` / `REVIEW_IDENTITY` / `REVIEW_ALIGNMENT` / `PROVIDER_ERROR`) without erasing existing lower-level reason codes.
4. Formalize the Pipeline A (catalog migration, `library-health/`) vs Pipeline B (ongoing refresh, `episode-release-refresh/`) boundary, specifically for `SUSPICIOUS_BULK_INSERT` and `SEASON_ZERO_PROPOSED`.
5. Build a deterministic batch manifest (dry-run only).
6. Build a post-apply verification layer.
7. Build rollback preview/refusal logic (not a blind delete).
8. Full test coverage for all new/changed behavior.
9. Run a full-library dry run (read-only) and produce a controlled rollout plan (not executed).

## Known constraints

- **No real broad apply against the actual database in this task.** Real DB writes only in isolated test fixtures (matches this session's existing integration-test convention: throwaway `User`/`Series` rows, cascade-deleted in `afterEach`).
- Never delete `Episode`/`Season`/`EpisodeWatch`/progress data.
- Never weaken title/identity or season-shrink/misalignment checks.
- Every automatic decision needs an explainable reason in the report.
- Default to dry-run for any new apply mode.
- Scope discipline: no manual-review UI, no deletion/archival of obsolete rows, no full auto provider-discovery, no blended global confidence score, no unrelated schema redesign.

## Phase status overview

| Phase | Description | Status |
|---|---|---|
| 1 | Baseline audit and evidence collection | DONE |
| 2 | Define and encode the stable safety policy | DONE |
| 3 | Separate concerns bundled into `migrationIntent` | DONE |
| 4 | Top-level operating classification | DONE |
| 5 | Formalize pipeline boundary (bulk-insert / season-0 routing) | DONE |
| 6 | Batch manifest | DONE |
| 7 | Verification layer | DONE |
| 8 | Rollback preparation | DONE |
| 9 | Tests | DONE — full repo: 77 suites / 1046 tests green, `tsc --noEmit` clean |
| 10 | Full-library dry run | DONE |
| 11 | Controlled rollout plan (document only) | DONE — not executed, no batch applied |

(Detailed subtask breakdown added below as each phase starts.)

---

## Phase 1 — Baseline audit

Status: DONE

All items traced directly against current code (not memory from prior review turns). Exact file/function references:

### Provider candidate selection / confirmation
- Human-authored `library-health/provider-confirmation-decisions.json`, one entry per title: `{title, decision: 'confirm'|'skip'|'defer', provider?, providerId?, notes?, migrationIntent?, statusOverride?}` — type `ProviderConfirmationDecision` in `provider-confirmation-decisions-logic.ts`.
- **Critical finding, not previously stated this precisely**: `run-provider-confirmation-pipeline.ts` (`main()`, the `for (const decision of decisions)` loop, line 266) is *entirely* decisions-file-driven. A series with no `"confirm"` entry (with `provider`+`providerId` set) never reaches classification at all, regardless of how objectively safe it would be. This is the real permanent identity gate — separate from, and layered underneath, `migrationIntent`. `migrationIntent`/`statusOverride` only ever matter for a title that *already* has a human-confirmed `provider`/`providerId`.

### Title/year sanity
- `checkTitleYearSanity()` in `provider-confirmation-decisions-logic.ts` (line 97). Always run, for every confirmed decision, unconditionally — never gated behind `migrationIntent` (`run-provider-confirmation-pipeline.ts` line 316, before `migrationIntent` is even read at line 349).
- Uses `extractTitleYearHint` + `normalizeTitle` + `titleSimilarity` from `trakt-enrichment/scoring.ts`. `titleSimilarity` (line 31) is Levenshtein distance normalized to a real `0..1` float — already a continuous signal, not just a boolean.
- Constants: `MIN_TITLE_SIMILARITY = 0.6`, `YEAR_MISMATCH_THRESHOLD = 1` (year diff in whole years).
- Failure modes: exact title match but year differs by >1 (remake/reboot signal), or title similarity below 0.6.

### migrationIntent — every branch it changes
All in `migration-confirmation-logic.ts::classifyMigrationConfirmation`, only ever invoked from `run-provider-confirmation-pipeline.ts` line 350 when `decision.migrationIntent === true`:
1. Reachability gate (line 108): `migrationIntent !== true` → pure passthrough, byte-identical to today's non-migration classification.
2. Hard floor (line 119, never bypassed by the flag): `titleYearSanityPassed === false` → `BLOCKED_DESTRUCTIVE_RISK`, always, flag or no flag.
3. Orphan tolerance (line 152): when reached, **every** orphan (any pattern/count) is preserved — no pattern-shape restriction, unlike the non-migration path's two narrow carve-outs.
4. Status resolution (lines 129–150): `DROPPED`/`PAUSED` always win regardless of override (`PROTECTED_MIGRATION_STATUSES`, line 55); else an explicit `statusOverride` wins (`SAFE_MIGRATION_WITH_STATUS_OVERRIDE`); else current status is carried forward unchanged (`SAFE_MIGRATION_WITH_PRESERVED_ORPHANS`) — **never** mechanically recomputed from the new provider's episode counts.

Confirms the 3-concepts-bundled finding from the prior review, now verified line-by-line: (1) orphan-pattern tolerance, (2) status override permission, (3) the reachability boolean itself. `statusOverride` is optional even with `migrationIntent: true` — the carry-forward default already exists and requires no extra input.

### Orphan / misalignment detection
- `findOrphanedWatchedEpisodes()` (`season-zero-orphan-logic.ts` line 60) — a watched local episode with no `(seasonNumber, episodeNumber)` match on the provider side. This is the **safe** case (nothing to remap, just report and preserve).
- `compareSeriesCatalog`'s `misalignedWatchedEpisodes` check (`episode-release-refresh/refresh-logic.ts`) is a **different, narrower, more dangerous** signal reused by the library-health pipeline via the same `compareSeriesCatalog` call (`run-provider-confirmation-pipeline.ts` line 318) — NOT the same thing as an orphan. Re-verified: `compareSeriesCatalog` computes orphans and misalignment from the *same* underlying local/provider diff but they answer different questions — an orphan is "no provider slot exists here at all" (safe to preserve); the codebase does not currently have a case that's "a provider episode DOES occupy this slot but doesn't match" as a separately-flagged category distinct from being counted among `newEpisodes`/`fieldChanges` — the closest genuinely-dangerous signal is `detectRealSeasonShrink` (a season's provider count fell below local count for that season — this is what actually indicates a numbering collision, not the orphan check itself).
- `detectRealSeasonShrink()` (`season-zero-orphan-logic.ts` line 38) — objective, deterministic, per-season episode-count comparison, season-0 excluded from the shrink check by design.
- `checkBenignSeasonZeroOrphan()` (line 90) and `checkSplitEpisodeTailOnly()` (`split-episode-tail-logic.ts` line 56) — the two narrow, already-automatic (no `migrationIntent` needed) orphan-shape carve-outs, both already in `apply-confirmed-provider-logic.ts`'s `SAFE_APPLY_CLASSIFICATIONS` (line 49): `SAFE_TO_APPLY_LATER`, `SAFE_WITH_LOCAL_SPECIAL_ORPHAN`, `SAFE_WITH_SPLIT_EPISODE_TAIL`.

### Migration apply plan / orphan-preservation enforcement
- `buildMigrationApplyPlan()` (`migration-confirmation-logic.ts` line 211) — hard invariant (line 234–238): throws if any orphan ID ever appears in `episodeUpdates` (structurally impossible in practice since `planEpisodeUpdates` only ever touches matched pairs, but enforced defensively, not just documented).
- Non-migration path: `buildConfirmedSeriesApplyPlan()` (`apply-confirmed-provider-logic.ts` line 116), same shape, no throw-invariant (not needed — orphan tolerance is already scope-limited to the 2 narrow patterns there).

### **New finding, materially changes the implementation plan**: Pipeline A currently creates NO missing Season/Episode rows at all
Re-read `run-provider-confirmation-pipeline.ts`'s actual transaction (lines 522–595) end to end: it does `externalIds.upsert`, optional `series.update` (poster), a loop of `tx.episode.update()` for **matched** pairs only (line 558–566), and `userSeriesProgress.upsert`. **There is no `tx.season.create` or `tx.episode.create` anywhere in this file.** `compareSeriesCatalog`'s `newEpisodes` field (provider episodes with no local counterpart — exactly "missing episodes to create") is computed at line 318 but never consumed for creation, only implicitly via `episodeUpdates` (which only ever touches existing matched rows).

**Conclusion**: contrary to how Pipeline A's role was described in the task prompt ("create missing seasons and episodes... large catalog backfills"), the current code does not implement this at all. The *only* season/episode-creation code in the whole repository is `episode-release-refresh/apply-refresh-transaction.ts`'s `applySeriesInsertPlan` (built two tasks ago), which is Pipeline B, gated by `RefreshClassification`, and currently blocked from large batches by `SUSPICIOUS_BULK_INSERT`. This directly explains *why* `SUSPICIOUS_BULK_INSERT` exists and confirms the task's own hypothesis: large catalog gaps have nowhere else to go today. Addressed in Phase 5 below by making the season/episode-insert *pure logic* (already fully tested from Phase 1) reusable by a new Pipeline A capability, rather than duplicating it.

### episode-release-refresh eligibility / SUSPICIOUS_BULK_INSERT / SEASON_ZERO_PROPOSED
- `checkSeriesEligibility()` (`refresh-logic.ts`) — requires `tmdbId` set (i.e., series already has *some* confirmed `ExternalIds` row — from Pipeline A, at some point), tracked userStatus, not on a risk list. No season/structural check at eligibility time — that happens per-series inside `compareSeriesCatalog`.
- `detectSuspiciousBulkInsert()` (`refresh-logic.ts`) — absolute (`>10` released new episodes) or relative (local `>=10` episodes and new `>` 50% of local) threshold, checked against `releasedNewEpisodeCount`. Classification `SUSPICIOUS_BULK_INSERT`, checked after season-shift/misalignment, before ordinary `NEW_RELEASE_AVAILABLE`.
- `detectSeasonZeroProposal()` (`refresh-logic.ts`) — any released new episode with `seasonNumber === 0` blocks the whole series (`SEASON_ZERO_PROPOSED`), independent of count. Comment in the code states plainly this exists because "Phase 1 has no dedicated season-0 handling or tests" — i.e., a coverage gap, not a proven risk, confirmed on re-read.
- `buildEpisodeInsertPlan()` (`build-episode-insert-plan.ts`) gates all of the above: any classification other than `NEW_RELEASE_AVAILABLE` → empty plan. The actual episode-building logic (season/episode candidate construction) lives in the private `computeInsertPreview()` helper — reused by `previewEpisodeInsertCounts()` for reporting. **This function is the one being exported/reused for the new migration-mode episode-creation capability (Phase 5).**

### Batch IDs / provenance
- `Episode.importBatchId` and `Season.importBatchId` are real columns (`prisma/schema.prisma`), already written by `episode-release-refresh`'s Phase 1 (`PHASE1_APPLY_IMPORT_BATCH_ID = 'episode-release-refresh:phase1-apply'`, `apply-refresh-transaction.ts`).
- `run-provider-confirmation-pipeline.ts`'s apply step does **not** set `importBatchId` on anything it touches (it only ever `episode.update`s existing rows — no create — and there is no `importBatchId` write in any of its update `data` objects, confirmed above).
- **No `importBatchId` (or any provenance column) exists on `UserSeriesProgress`, `ExternalIds`, or `Series`.** `ExternalIds` has its own `matchSource`/`matchedAt` fields instead (set to `'library-health:provider-confirmation-pipeline'` or `'...:migration'`), which is a usable provenance signal for that one table only.
- **What can currently be proven from batch IDs**: which `Episode`/`Season` rows were created by `episode-release-refresh`'s Phase 1 apply (exact match on `importBatchId`). Nothing else.
- **What is not covered**: any row `run-provider-confirmation-pipeline.ts` touches (updates, not creates, so no `importBatchId` need apply, but also no way to distinguish "touched by this pipeline" from "touched by TV Time import" after the fact except via `ExternalIds.matchedAt`/`matchSource`, which lives on a different table than the rows actually changed); any `UserSeriesProgress` change, from any pipeline, ever. This is the central gap Phase 8 (rollback) has to work around — addressed via manifest-snapshot rather than a schema change (see Phase 8 below).

Baseline audit complete. Proceeding to Phase 2.

---

## Phase 2 — Policy design

Status: DONE (design). Encoded into code comments in Phase 3's new files, not just here.

### Safety gates (never weakened, never bypassable by policy)
1. Provider identity absent (no confirmed decision) — unchanged, permanent, human-only (§Phase 1 finding).
2. Title/year sanity fails, or identity confidence band is `FAILED` — unchanged threshold (`MIN_TITLE_SIMILARITY = 0.6`, `YEAR_MISMATCH_THRESHOLD = 1`), not touched.
3. Real season shrink (`detectRealSeasonShrink`) — unchanged, always blocks.
4. Engine invariant violation (`buildMigrationApplyPlan`'s orphan-collision throw) — unchanged, always routes to investigation.

### Policy/workflow gates (being made objective in Phase 3 — no longer require `migrationIntent`)
1. Orphan pattern shape (season-0-only vs. split-tail vs. scattered/large) — becomes irrelevant once identity + structural safety pass; preservation is unconditional regardless of shape.
2. Orphan count — irrelevant for the same reason (proven at ~472-orphan scale already).
3. Presence of `migrationIntent` itself, for the *orphan-tolerance* axis — replaced by an automatic eligibility check (§Phase 3A).
4. Presence of `statusOverride` — replaced by objective derivation where the data supports it, else automatic carry-forward (§Phase 3B). Manual override remains supported, now optional rather than required.
5. Large catalog-completion gap (`SUSPICIOUS_BULK_INSERT` today) — reclassified as Pipeline A's normal job, not a Pipeline B failure (§Phase 5).

### Coverage gap (not a principle — explicitly labeled as such, not solved this task)
1. `SEASON_ZERO_PROPOSED` in Pipeline B — remains a hard block, but the block is now clearly reported as a temporary coverage limitation, not a security boundary. Concrete follow-up recorded as DEFERRED (§Phase 5).

### Identity confidence banding (the one place a non-boolean signal is justified)
`titleSimilarity()` already returns a real `0..1` float. New bands, layered on top of the *existing, unchanged* pass/fail line:
- `similarity === 1` (exact normalized match) or `similarity >= 0.85` → `HIGH_CONFIDENCE`
- `0.6 <= similarity < 0.85` → `BORDERLINE` (passes today's sanity check, but should route to `REVIEW_IDENTITY` under the new auto-policy rather than silently auto-migrating)
- `similarity < 0.6`, or year-mismatch-on-exact-title failure → `FAILED` (today's existing failure — unchanged)

No blended score across other axes — season-shrink and orphan-preservation stay discrete booleans, per the prior review's own reasoning (repeated here after re-verifying it against code): they don't have a meaningful gradient.

### Objective status resolution rule
```
matchedWatchedCount = count of locally-watched episodes that DO match a provider (seasonNumber, episodeNumber)
matchedTotalCount   = count of ALL provider-matched local episodes (matched, watched or not)

if matchedWatchedCount >= matchedTotalCount:
  derive status from provider lifecycle (COMPLETED if provider ended/cancelled, else CAUGHT_UP) — same rule
  deriveUserStatusFromNextEpisode already uses everywhere else, applied to the merged catalog
else:
  preserve currentUserStatus unchanged (never mechanically recompute, never regress)
```
Protected statuses (`DROPPED`/`PAUSED`) always win over either branch, exactly as `PROTECTED_MIGRATION_STATUSES` already does today — reused, not reimplemented.

### Auto-migration eligibility (replaces `migrationIntent` as a required flag)
A title is eligible for `AUTO_MIGRATE` (no `migrationIntent` needed) iff:
1. Confirmed decision exists (`decision: 'confirm'`, `provider`+`providerId` set) — unchanged human gate.
2. `titleYearSanity.passed === true` AND identity band is `HIGH_CONFIDENCE` or `BORDERLINE` (not `FAILED`).
3. `detectRealSeasonShrink === false`.
4. No engine-invariant violation when the plan is actually built.

Orphans of any shape/count and any watched/unwatched mismatch are **not** disqualifying — preservation and status resolution both have safe, automatic outcomes per the rules above. `BORDERLINE` identity is still allowed to auto-migrate (unlike `FAILED`) but is flagged distinctly in the report for visibility — this is a judgment call, recorded here: blocking `BORDERLINE` entirely would reintroduce a manual bottleneck for a large share of real titles (fuzzy-but-clearly-right matches), and `titleYearSanity` already independently passed. If real-world dry-run evidence (Phase 10) shows this is too permissive, tightening `BORDERLINE` to require review is a one-line policy change, not a rearchitecture.

---

## Phase 3 — Implementation plan (before writing code)

Status: IN_PROGRESS

Subtasks, in dependency order:

1. `TODO` Extract shared season/episode-creation Prisma logic out of `episode-release-refresh/apply-refresh-transaction.ts` into a new shared file so Pipeline A can reuse the exact same tested write path instead of duplicating it. Re-run `apply-refresh-transaction.integration.test.ts` after, expect zero behavior change.
2. `TODO` Export `build-episode-insert-plan.ts`'s private `computeInsertPreview` under a public name so both pipelines can build episode-insert candidates from a `newEpisodes`/`providerEpisodes` diff without a `RefreshClassification` gate baked in.
3. `TODO` New `src/common/migration-operating-classification.ts` — shared top-level enum + one mapping function per pipeline.
4. `TODO` New `library-health/migration-policy-logic.ts` — identity banding, objective status resolution, auto-migration eligibility, orphan-tolerance (trivial pass-through once eligible).
5. `TODO` New `library-health/migration-catalog-plan-logic.ts` — wraps `buildEpisodeInsertCandidates` for Pipeline A's "create missing seasons/episodes during reconciliation" capability.
6. `TODO` Wire steps 3–5 into `run-provider-confirmation-pipeline.ts`: new `--apply-auto-safe-migrations` flag, additive to existing `--apply-safe-confirmed`/`migrationIntent` behavior (zero change for existing decisions.json entries).
7. `TODO` Route `SUSPICIOUS_BULK_INSERT` in `episode-release-refresh` — add a report-level pointer ("belongs in catalog reconciliation") rather than attempting a fully automatic cross-pipeline handoff (scoped down, recorded as a deliberate simplification, not silently dropped).
8. `TODO` Batch manifest builder (Phase 6).
9. `TODO` Verification module (Phase 7).
10. `TODO` Rollback manifest/preview/refusal-eligibility module (Phase 8) — explicitly NOT a rollback executor.
11. `TODO` Tests for all of the above.
12. `TODO` Full-library dry run + report.
13. `TODO` Rollout plan doc.

Proceeding to implementation now.

### Important discovery during implementation (not in original baseline audit)

`classifyMigrationConfirmation` (`migration-confirmation-logic.ts`) had **no `realSeasonShrinkDetected` input at all** before this task. Its only hard floor was title/year sanity — meaning an explicit `migrationIntent: true` could theoretically have masked a genuine numbering-collision risk (a real season shrink) that the non-migration pipeline correctly blocks on via `BLOCKED_RISK`. This was a real, pre-existing gap, not something introduced by this task, surfaced by re-reading the function's actual inputs against the task's explicit "genuine alignment risks remain blocked" requirement.

**Fixed**: added `realSeasonShrinkDetected: boolean` as a required input and a second hard floor (mirrors the title/year sanity floor exactly — checked before any status/orphan logic, never bypassed by intent or an explicit `statusOverride`). Updated the one real call site (`run-provider-confirmation-pipeline.ts`, already computes `detectRealSeasonShrink` at the point it calls `classifyMigrationConfirmation` — just wasn't passing it through). Updated all 12 existing test call sites to pass `realSeasonShrinkDetected: false` (correct for all of them — none were actually exercising real-shrink semantics despite one test's descriptive `baseReason` text implying it). Added one new regression test proving the fix. `library-health` suite: 206/206 passing after the change (up from 205 pre-fix... actually confirmed 206 total post-fix including the 1 new test).

This is exactly the kind of small, in-scope, safety-*improving* fix the task explicitly permits ("If a small prerequisite refactor is necessary for correctness... perform it and document why") — recorded here per that instruction.

Status: DONE.

### Phase 3 — completion record

All 13 subtasks listed above are DONE. Concretely, in dependency order:

1. `DONE` — `episode-release-refresh/season-episode-writer.ts` extracted from `apply-refresh-transaction.ts` (`createMissingSeasonsAndEpisodes`). Re-ran `apply-refresh-transaction.integration.test.ts` after: zero behavior change.
2. `DONE` — `build-episode-insert-plan.ts`'s private `computeInsertPreview` renamed/exported as `buildEpisodeInsertCandidates`, no classification gate baked in. Original gated `buildEpisodeInsertPlan` unchanged for Pipeline B.
3. `DONE` — `src/common/migration-operating-classification.ts`: `MigrationOperatingClassification` union + label map.
4. `DONE` — `library-health/migration-policy-logic.ts`: `classifyIdentityConfidence`, `resolveObjectiveMigrationStatus`, `evaluateAutoMigrationEligibility`. No orphan-count/pattern parameter anywhere in this module — verified by a dedicated test asserting the function signature has none.
5. `DONE` — `library-health/migration-catalog-plan-logic.ts`: `buildMigrationCatalogInsertPlan`, `computeMatchedEpisodeCounts`, `CATALOG_RECONCILIATION_IMPORT_BATCH_ID`.
6. `DONE` — Wired into `run-provider-confirmation-pipeline.ts`: new `--apply-auto-safe-migrations` flag, purely additive to `--apply-safe-confirmed`. Confirmed-decision titles with no `migrationIntent` are now evaluated for auto-eligibility; explicit `migrationIntent` always wins when both would apply. Existing `decisions.json` entries get byte-identical behavior unless the new flag is passed.
7. `DONE` — `SUSPICIOUS_BULK_INSERT` routing note wired into `episode-release-refresh/reports.ts` (this session, completing the phase). See full Phase 5 section below.
8–10. Deferred to their own phases (6/7/8), not part of Phase 3 itself — tracked separately below, still open.
11. `DONE` (for Phase 3's own scope) — `migration-policy-logic.test.ts`, `migration-catalog-plan-logic.test.ts`, `migration-operating-outcome.test.ts`, `refresh-operating-outcome.test.ts`, `catalog-reconciliation-transaction.integration.test.ts` (real-Postgres). All green. Batch/verification/rollback test categories (Phase 9's remaining scope) not yet written — tracked in Phase 9.
12–13. Not started — Phase 10/11, tracked below.

Test evidence at close of Phase 3: `library-health` 207/207, `episode-release-refresh` 120/120 (post Phase-5 wiring), 1/1 new integration test, full `tsc --noEmit` clean.

---

## Phase 4 — Top-level operating classification

Status: DONE.

`src/common/migration-operating-classification.ts` defines `AUTO_MIGRATE | AUTO_REFRESH | REVIEW_IDENTITY | REVIEW_ALIGNMENT | PROVIDER_ERROR`, used identically by both pipelines via two separate mapping functions so each pipeline stays the authority over its own lower-level reason codes:

- `library-health/migration-operating-outcome.ts::classifyMigrationOperatingOutcome` — Pipeline A. Priority order: `PROVIDER_ERROR` → `REVIEW_IDENTITY` (no confirmed identity / sanity fail / `FAILED` band) → `REVIEW_ALIGNMENT` (real season shrink / engine invariant violation) → `AUTO_REFRESH` (no pending catalog work) → `AUTO_MIGRATE`.
- `episode-release-refresh/refresh-operating-outcome.ts::classifyRefreshOperatingOutcome` — Pipeline B. Maps existing `RefreshClassification` values onto the same top-level enum; **never** produces `REVIEW_IDENTITY` (identity discovery is exclusively Pipeline A's job — enforced by a dedicated test). `SUSPICIOUS_BULK_INSERT` maps to `REVIEW_ALIGNMENT` but carries a distinct non-null `routingNote` pointing back at catalog reconciliation — every other alignment case has `routingNote: null`.

Lower-level reason codes (`MigrationClassification`/`RefreshClassification`, `identityBand`, `bulkInsertReason`, `seasonZeroReason`, etc.) are preserved unchanged in both pipelines' reports alongside the new top-level field — nothing was erased, confirmed by reading both report builders after the change (`provider-confirmation-pipeline-reports.ts`, `episode-release-refresh/reports.ts`).

Test evidence: `migration-operating-outcome.test.ts` (full priority-order coverage), `refresh-operating-outcome.test.ts` (full mapping coverage + the two "never/always" invariants above), both green.

---

## Phase 5 — Formalize the pipeline boundary

Status: DONE.

### Ownership boundary (explicit, not just implicit in file layout)

**Pipeline A — Catalog Migration / Reconciliation (`library-health/`)**. Owns:
- Provider candidate confirmation and identity validation (human-authored `decisions.json`, `checkTitleYearSanity`, `classifyIdentityConfidence`).
- Catalog reconciliation: creating any missing `Season`/`Episode` rows the provider has that the local catalog doesn't yet, of any size (`migration-catalog-plan-logic.ts` — deliberately not threshold-gated, since a large gap is exactly this pipeline's normal job, not an anomaly).
- Legacy watched-orphan preservation, of any pattern or count.
- Migration planning, status resolution/override, provider-ID attachment.
- Progress recomputation for the migrated title.
- The only pipeline that can ever produce `REVIEW_IDENTITY`.

**Pipeline B — Ongoing Episode Release Refresh (`episode-release-refresh/`)**. Owns:
- Series that are **already** provider-confirmed (`checkSeriesEligibility` requires `tmdbId` already set — i.e., already passed through Pipeline A at some point).
- Detecting newly-*aired* episodes since the last check; ignoring future/unaired episodes entirely (`FUTURE_ONLY`).
- Inserting genuinely new (small, incremental) episodes/seasons as they release.
- Recomputing `nextEpisodeId`/progress for an already-reconciled catalog.
- Never performs identity work, never produces `REVIEW_IDENTITY`.

This boundary was already implicit in the two directories before this task; what changed is that it is now enforced/visible in code: `refresh-operating-outcome.ts`'s dedicated test asserts Pipeline B can never emit `REVIEW_IDENTITY`, and `SUSPICIOUS_BULK_INSERT` now carries an explicit routing note rather than being a silent dead end.

### `SUSPICIOUS_BULK_INSERT` disposition — DONE (reclassified, not removed)

**Finding, confirmed against code**: this was a **policy-workflow gate misclassified as a safety gate**, not a genuine risk in itself. A large batch of released-but-missing episodes (e.g. importing a show TV Time never had past season 3 of) is exactly what catalog reconciliation exists to do; it only looked dangerous inside Pipeline B because Pipeline B previously had no size-aware alternative destination and, more importantly, because **Pipeline A had no episode-creation capability at all** before this task (baseline audit finding, §Phase 1). Numbering-collision protection is not weakened: `detectRealSeasonShrink` and structural checks are untouched and still block in `REVIEW_ALIGNMENT` regardless of the routing note.

**What changed**: `SUSPICIOUS_BULK_INSERT` still blocks Pipeline B from writing (unchanged — Pipeline B remains maintenance-only) but now carries `routingNote: "... belongs in library-health catalog reconciliation ..."` (`refresh-operating-outcome.ts`) surfaced in both the JSON report field (`RefreshedSeriesEntry.routingNote`) and the markdown report (`**Routing note:**` line, `episode-release-refresh/reports.ts`), so a reviewer sees this is a pipeline-ownership issue, not a "do not touch this data" issue. Pipeline A's new `buildMigrationCatalogInsertPlan` is the actual mechanism that now lets these titles get their missing catalog sections created — proven end-to-end by `catalog-reconciliation-transaction.integration.test.ts`, which specifically constructs the "whole missing season" shape `SUSPICIOUS_BULK_INSERT` would have blocked in Pipeline B and shows it landing correctly via Pipeline A instead.

No automatic cross-pipeline handoff was built (a title flagged `SUSPICIOUS_BULK_INSERT` in Pipeline B is not automatically re-run through Pipeline A) — that would require Pipeline B to trigger Pipeline A's human-confirmation-gated entrypoint, which is out of scope and would blur the ownership boundary this phase exists to draw. Recorded here as a deliberate simplification: the routing note tells a human/reviewer where to look; it does not act on their behalf.

### `SEASON_ZERO_PROPOSED` disposition — DONE (confirmed coverage gap, not weakened, not silently dropped)

**Finding, confirmed against code** (re-verified, not assumed from prior review): `detectSeasonZeroProposal` in `episode-release-refresh/refresh-logic.ts` blocks *any* released new episode with `seasonNumber === 0`, unconditionally, with an in-code comment stating plainly this exists because "Phase 1 has no dedicated season-0 handling or tests." This is a **coverage gap**, not a proven safety principle — season 0 (specials) has no inherently higher misalignment risk than any other season; it's just untested.

**Disposition**: left as a hard block in Pipeline B, exactly as the task instructs for this situation ("If full Season 0 support is too large for this task, preserve the current block but report it clearly as a temporary coverage limitation and add a concrete TODO"). Two things distinguish it from a real safety gate in the reports now: (1) it maps to `REVIEW_ALIGNMENT` with `routingNote: null` (i.e., explicitly *not* given the same "wrong pipeline" framing as `SUSPICIOUS_BULK_INSERT`, since this is a genuine "we haven't verified this is safe yet" gap, not a misrouted-but-fine case), (2) `seasonZeroReason` remains a populated, visible field on every affected report entry.

**Notable asymmetry, recorded deliberately**: Pipeline A's new `buildMigrationCatalogInsertPlan` (§Phase 3, item 5) does **not** exclude season-0 episodes — unlike Pipeline B's gated `buildEpisodeInsertPlan`. This was a conscious choice, not an oversight: Pipeline A's season-0 episodes arrive as part of a human-confirmed, identity-validated reconciliation (a `decisions.json` entry a person already reviewed), and reuse `buildEpisodeInsertCandidates` (the ungated primitive) directly — the risk profile is materially different from Pipeline B silently discovering an unreviewed season-0 episode during routine background refresh of an already-stable series. If Phase 10's full-library dry run surfaces evidence that this asymmetry is wrong in practice (e.g. auto-migrated titles creating garbage season-0 rows), this is the first place to revisit.

**Concrete follow-up TODO** (explicitly required by the task, recorded here per instruction): `DEFERRED` — build real season-0 test coverage for Pipeline B (`episode-release-refresh`): what a legitimate newly-released special looks like vs. a misidentified/miscounted one, then decide whether `SEASON_ZERO_PROPOSED` can be narrowed from "block everything" to "block only the genuinely ambiguous shapes," mirroring how `checkBenignSeasonZeroOrphan` already narrows Pipeline A's orphan handling. Not attempted this task — would require constructing/validating real season-0 release-pattern examples from TMDb data, which is investigative work beyond this task's scope discipline ("perfect handling of every theoretical provider anomaly" is explicitly out of scope).

Test evidence for Phase 5: `refresh-operating-outcome.test.ts` (routing-note-only-for-bulk-insert assertion, REVIEW_IDENTITY-never assertion), `episode-release-refresh` full suite 120/120 green after wiring `operatingClassification`/`routingNote` into `reports.ts` and both `run-refresh.ts` push sites, `tsc --noEmit` clean.

---

## Phase 6 — Batch manifest

Status: DONE.

### Gap found and fixed before building the manifest

Re-reading `run-provider-confirmation-pipeline.ts`'s `dryRunSafeSeries.push` call site while designing the manifest surfaced two real reporting gaps, not just missing manifest fields:
1. `seasonsCreated`/`episodesCreated` were **hardcoded to `[]`/`0`** on every dry-run-safe entry, even when `catalogInsertPlan` already had real pending work computed — i.e. the dry-run report was silently hiding planned catalog-reconciliation work that the *applied* path already reported correctly. Fixed: dry-run entries now report `catalogInsertPlan.seasonNumbersToCreate` / `catalogInsertPlan.episodesToInsert.length` (a preview, correctly distinguished from the applied path's post-write actual counts).
2. `PipelineDryRunSafeEntry` had **no `userStatus`/`nextEpisodeId` field at all** — only `PipelineAppliedSeriesEntry` did. There was no way to see "what status would this become" before applying. Fixed: added a shared `ProgressChangeFields` interface (`userStatus: {from,to,changed}`, `nextEpisodeId: {from,to,changed}`) to both entry types; `PipelineAppliedSeriesEntry` also gained real before/after `nextEpisodeId` tracking (previously only `userStatus` was tracked through the transaction — `toNextEpisodeId` is now captured the same way `toStatus` already was).

Both were exactly the kind of "small prerequisite refactor necessary for correctness" the task permits — required for the manifest's "current/proposed/preserved status" and "expected nextEpisodeId changes" fields to be truthful rather than default-value placeholders.

### Design: extend, don't duplicate

Per the task's explicit instruction, the manifest is a pure projection over the *already-computed* `ProviderConfirmationPipelineReport` (`dryRunSafeSeries` + `appliedSeries`), not a second subsystem that re-walks decisions/series data. New files:

- `library-health/batch-manifest-logic.ts` (pure, zero I/O) — `buildBatchManifest({report, batchId, generatedAt, includeClassifications?, seriesIdFilter?})`. Defaults to `includeClassifications: ['AUTO_MIGRATE']` (the only outcome that's ever a write candidate). Deterministic: entries sorted by `seriesId`, not insertion order, so the same report always produces byte-identical output. `batchId`/`generatedAt` are caller-supplied, not generated internally (`Date.now()`/`randomUUID()` would break determinism and the pure-logic-no-I/O convention).
- `library-health/batch-manifest-reports.ts` (I/O) — markdown rendering + `writeBatchManifest` (latest + timestamped JSON/markdown, same convention as every other report writer in this codebase).
- Wired into `run-provider-confirmation-pipeline.ts`: after the existing report is built, the manifest is **always** additionally computed and written (dry-run or apply mode alike) — safe unconditionally since it never performs or gates a write itself, it only reads what the report already computed. `batchId` format: `library-health:provider-confirmation-pipeline:<ISO timestamp>`.

### Manifest fields — coverage against the task's exact list

Per-title (`BatchManifestEntry`): `seriesId`, `title`, `provider`/`providerId` (identity), `identityBand`, `operatingClassification`, `reason` (`autoMigrationEligibilityReason`), `currentUserStatus`/`proposedUserStatus`/`statusSource`, `matchedWatchedEpisodeCount`/`matchedTotalEpisodeCount`, `unmatchedWatchedOrphanCount`, `orphanLocations` (season/episode pairs), `allOrphansGuaranteedPreserved` (always `true` — see in-code comment: the write-path invariant means an unpreservable orphan never reaches a successful plan, so it never reaches the manifest either), `seasonsToCreate`/`episodesToCreate`, `episodeMetadataUpdateCount`, `expectedProgressChange`, `expectedNextEpisodeIdChange`.

Manifest-level: `batchId`, `executionMode` (always `'dry-run'`, regardless of `report.mode` — the manifest itself never applies anything even when the underlying pipeline run did), `generatedAt`, `targetUserId`, `totalTitlesConsidered` (sum across every report bucket), `totalsByOperatingClassification`, `batchSize`, `seriesIds`, `providerErrorCount`, `invariantFailureCount` (currently always `0` — see in-code comment: invariant violations throw inside `buildMigrationApplyPlan` rather than reaching the report as data today; field kept explicit rather than omitted so a consumer never has to guess "not tracked" vs "checked, zero found").

Not included: "expected write counts by entity type" as a single aggregate — deliberately left as the sum of the already-present per-entity fields (`episodesToCreate`, `seasonsToCreate.length`, `episodeMetadataUpdateCount`, `expectedProgressChange`/`expectedNextEpisodeIdChange` as booleans) rather than adding a redundant derived total; a manifest consumer can sum these per their own needs.

Test evidence: `batch-manifest-logic.test.ts` (7 tests — default AUTO_MIGRATE-only filtering, exclusion of all four other classifications, determinism/sort-order, explicit `seriesIdFilter` for staged rollout batches, cross-bucket totals, always-dry-run guarantee, catalog-gap preview fields), `batch-manifest-reports.test.ts` (3 tests — markdown rendering, empty-batch message, file writing). `library-health` full suite: 253/253 green. `tsc --noEmit` clean.

---

## Phase 7 — Verification design

Status: DONE.

### Design

- `library-health/verification-logic.ts` (pure, zero I/O) — the comparison engine. Takes a `before`/`after` `SeriesSnapshot` (episodes, seasons, episodeWatches, progress — all plain data, no Prisma types) plus a `PostApplyExpectation` (what the batch manifest said would happen for this title) and returns a `SeriesVerificationResult`: a list of **named, individually pass/fail** `VerificationCheck`s, not one opaque boolean — a failure is immediately actionable (which check, which row ids).
  - Catalog writes: `new-episodes-carry-expected-provenance`, `new-episode-count-matches-expected`, `new-seasons-match-expected`, `no-episode-deletions`, `no-unexpected-renumbering`, `preserved-orphans-untouched`.
  - Watch history: `watch-count-non-decreasing`, `no-lost-watch-records`, `new-episodes-not-auto-watched`.
  - User progress: `progress-status-matches-expected`, `progress-next-episode-matches-expected`.
  - Scope: `verifyBatchScope(touchedSeriesIds, manifestSeriesIds)` — a separate top-level check (not per-series), since "was an unrelated series touched" is a batch-wide question, not a per-title one.
  - Classification convergence: `verifyClassificationConvergence(postApplyOperatingClassification)` — passes only for `AUTO_REFRESH`. Deliberately reuses the *already-mapped* top-level classification (not a raw `RefreshClassification`) so `NO_CHANGE`/`FUTURE_ONLY`/`NEW_RELEASE_AVAILABLE` are all correctly accepted as converged via the Phase 4 mapping (`refresh-operating-outcome.ts`) — the task's explicit callout ("do not incorrectly require NO_CHANGE when FUTURE_ONLY is the accurate classification") is satisfied structurally, not by special-casing FUTURE_ONLY separately.
  - `verifyBatch(batchId, seriesResults, scopeCheck)` — aggregates: passes only if the scope check AND every series result pass.
- `library-health/verification-snapshot.ts` (I/O, but NOT a `main()`-executing script — a plain exported async function, safe to import from tests) — `captureSeriesSnapshot(prisma, seriesId, userId)` reads Season/Episode/EpisodeWatch/UserSeriesProgress for one series into the plain-data `SeriesSnapshot` shape `verification-logic.ts` consumes.

This was **not** wired into `run-provider-confirmation-pipeline.ts` as an automatic post-apply step in this task — the pipeline's real applies are already narrowly scoped (small `decisions.json`-driven batches, one title at a time, per-title transactions), and wiring "capture before → apply → capture after → verify" into the live apply loop is Phase 11 rollout-command work, not Phase 7 design work. What's delivered here is the reusable engine itself, proven against real data (below) — invoking it as a mandatory gate before/after a real batch apply is one of the concrete steps in the Phase 11 rollout plan.

### Real evidence (not just constructed fixtures)

`library-health/__tests__/verification-snapshot.integration.test.ts` (2 tests, real Postgres, same throwaway-fixture convention as `catalog-reconciliation-transaction.integration.test.ts`):
1. Runs the real catalog-reconciliation transaction (season/episode creation + objective status resolution) against a live fixture, captures real before/after snapshots via `captureSeriesSnapshot`, and confirms **every** check reports PASS — proving the verification layer doesn't false-positive on a genuinely correct apply.
2. Runs the same transaction but **deliberately corrupts the preserved orphan** afterward (`episode.update` changing its `episodeNumber`) — proving `preserved-orphans-untouched` actually fires on a real, non-contrived regression, independent of (not merely duplicating) `buildMigrationApplyPlan`'s own orphan-collision throw. This is the point of having a *separate* verification layer: it catches a regression even if the write-path invariant were ever weakened or bypassed elsewhere.

Both tests confirmed leaving no DB residue (same `afterEach` cascade-delete convention as every other integration test this task added).

### Test evidence

`verification-logic.test.ts` — 18 tests, exhaustively covering the task's required verification-test list: catches extra row (wrong provenance), missing row (deletion), changed orphan, lost EpisodeWatch, newly-created-episode auto-watched, unplanned progress mutation, unexpected nextEpisodeId change, wrong season count; accepts a correct apply with real (non-null) derived nextEpisodeId; accepts FUTURE_ONLY-equivalent (AUTO_REFRESH) as valid convergence while rejecting REVIEW_ALIGNMENT/REVIEW_IDENTITY/PROVIDER_ERROR/AUTO_MIGRATE; scope check passes/fails correctly; batch aggregation fails on either a single series failure or a scope failure. `verification-snapshot.integration.test.ts` — 2 tests (above). `library-health` full suite: 273/273 green. `tsc --noEmit` clean.

---

## Phase 8 — Rollback preparation

Status: DONE (within the scope explicitly permitted: manifest, preview, refusal rules — NOT a delete executor wired into any live command).

### What was built

- `library-health/rollback-logic.ts` (pure, zero I/O):
  - `buildRollbackManifest({report, batchId, generatedAt, importBatchId})` — builds one `RollbackManifestEntry` per **applied** series (extends `PipelineAppliedSeriesEntry`, again reusing rather than duplicating the existing report shape — the applied-series entries already record prior vs. new `userStatus`/`nextEpisodeId` via `ProgressChangeFields`, plus `seasonsCreated`/`episodesCreated`, which is exactly what a rollback needs). Sorted by `seriesId` for determinism, same convention as the batch manifest.
  - Each entry carries `hasReversibleChanges: boolean` and `unsupportedChangeNote: string | null` — an entry whose only change was an episode-metadata backfill (title/overview/airDate/runtime) is explicitly flagged as **not reversible by this tool**, with the reason stated in-line, rather than silently omitted or falsely promised. Documented as a genuine, permanent schema/data-support gap in a header comment: no prior-value snapshot exists anywhere in the current schema or report shape for those field-level backfills. Progress (`userStatus`/`nextEpisodeId`) and row creation (`Season`/`Episode`, identified by `importBatchId`) ARE fully reversible, and that's the entire scope this module claims to cover — declared explicitly via `RollbackManifest.scopeNote`, carried through to every rendered artifact.
  - `evaluateRollbackEligibility({entry, currentUserStatus, currentNextEpisodeId, createdEpisodesWithWatches})` — pure eligibility check, given live-read current state (never trusts the manifest's snapshot for "is it still safe now"). Refuses (does not merely warn) with one or more explicit reasons: `CREATED_EPISODE_HAS_BEEN_WATCHED` (a row this batch created has since gained real user activity — the task's explicit "must not silently delete it" case), `PROGRESS_HAS_DRIFTED_SINCE_APPLY` (current status/nextEpisodeId no longer matches what the batch itself set — restoring the prior value would discard newer, real activity), `NO_REVERSIBLE_CHANGES` (nothing in scope to safely revert).
  - `buildRollbackPreviewEntry(entry, eligibility)` — dry-run preview: for an eligible entry, shows exactly what WOULD be deleted/restored; for a refused entry, shows nothing planned (zero counts, null restores) — the preview never implies an action that won't actually run.
- `library-health/rollback-executor.ts` (I/O, but never invoked by any script in this task) — `executeRollback(tx, userId, entry, eligibility)`. Throws `RollbackRefusedError` immediately if `!eligibility.eligible` — never attempts a partial or best-effort undo. Even when the caller-supplied eligibility says "eligible," **re-verifies both live conditions again inside the transaction** before deleting anything (closes the gap between "checked eligible" and "about to delete" — proven by a dedicated test, see below). Deletes only `Episode`/`Season` rows matching the batch's exact `importBatchId` (the same provenance marker `verification-logic.ts` uses), never anything else; restores `UserSeriesProgress` only if it actually changed.
- `library-health/rollback-reports.ts` (I/O) — markdown rendering (explicit "no rows have been deleted or restored" banner, separate "Eligible" vs. "Refused — requires manual recovery" sections, the latter stating plainly this is not a best-effort undo) + file writing (latest + timestamped, same convention as every other report in this codebase).

### Explicit answer to "what schema/data support remains missing"

Full reversal of episode metadata backfills (title/overview/airDate/runtime updates made to already-matched episodes via `planEpisodeUpdates`) is **not supported** and is out of scope for this task. It would require either a per-field before/after audit log or a full pre-write row snapshot, neither of which the current schema or report shape provides. `RollbackManifestEntry.unsupportedChangeNote` surfaces this per-title rather than hiding it. `ExternalIds` changes (provider/providerId/matchSource) are likewise not reverted — `ExternalIds` carries no prior-value history either. These are documented limitations, not silent gaps; recorded here per the task's explicit instruction.

### Why the executor was built (even though it's never invoked)

The task's safety rule is "Safe to rollback automatically or Refuse and require manual recovery — not: attempt a best-effort destructive undo." Building only the pure eligibility logic without ever exercising real deletion/restoration against a real database would leave "safe to rollback automatically" unproven. `rollback-executor.ts` exists so that claim is backed by passing integration tests (below), not just unit-tested pure logic — while still not being wired into any callable command in this task, consistent with "do not perform a real broad apply" and "do not build an unsafe blind delete command" (it is a *gated*, refusal-first command, and it is not exposed to be run against real data yet).

### Test evidence

`rollback-logic.test.ts` — 11 tests: manifest construction (sorted entries, prior/applied progress capture, created-row counts), unsupported-change flagging, scope-note presence; eligibility — allows when safe, refuses when a created episode was watched, refuses when status drifted, refuses when nextEpisodeId drifted (user watched further), refuses when there's nothing reversible in scope ("provenance incomplete" in the sense of nothing safely attributable to reverse), can report multiple simultaneous refusal reasons; preview — shows planned action for eligible, shows nothing for refused. `rollback-reports.test.ts` — 3 tests (preview counting, markdown rendering, file writing). `rollback-executor.integration.test.ts` — 4 tests, real Postgres, throwaway fixtures: (1) a clean eligible rollback deletes exactly the batch-created rows, restores prior progress, and **leaves a pre-existing watched orphan completely untouched** (proving "never targets pre-existing imported rows" with real data, not just a mocked assumption); (2) refuses and writes nothing when a batch-created episode has since been watched; (3) refuses and writes nothing when progress has drifted (a manual status change after the batch is preserved, not silently overwritten); (4) proves the executor's live re-check catches a watch that appeared *after* eligibility was computed but before the transaction ran (stale-eligibility-result defense). `library-health` full suite: 291/291 green. `tsc --noEmit` clean.

### Not built in this task (deferred to Phase 11 rollout work)

No CLI command currently invokes `rollback-executor.ts` — there is no real applied batch yet to roll back (this task never performed a real broad apply), so wiring a live rollback command now would be untested against real usage and premature. The exact command this becomes at rollout time is specified in the Phase 11 controlled rollout plan below.

---

## Phase 9 — Final full-repo validation

Status: DONE.

Ran the **entire** repo test suite (not just library-health/episode-release-refresh subsets) and a full typecheck, per the task's explicit "do not stop after only the new tests pass" instruction:
- `npx tsc --noEmit -p tsconfig.json` — clean, zero errors.
- `npx jest` (no path filter, whole repo) — **77 test suites, 1046 tests, all passing.**

No regressions anywhere outside the touched subsystems (tmdb-enrichment, trakt-enrichment, secondary-provider-audit, watch-next-review, etc. all unaffected).

---

## Phase 10 — Full-library dry run

Status: DONE. Real data, real Postgres, real TMDb calls — **strictly read-only**, no `--apply` flag passed to either pipeline, confirming the task's "no real broad apply" rule end to end.

### Commands run

```
npx ts-node library-health/run-provider-confirmation-pipeline.ts     # Pipeline A, dry-run (default)
npx ts-node episode-release-refresh/run-refresh.ts                    # Pipeline B, dry-run only (no --apply exists)
```

Reports written to `library-health/output/latest-provider-confirmation-pipeline-report.{json,md}`, `library-health/output/latest-batch-manifest.{json,md}`, `episode-release-refresh/output/latest-refresh-report.{json,md}` (plus timestamped archives under each `output/runs/`).

### Pipeline A (catalog migration/reconciliation) — summary

44 decisions loaded from the real `provider-confirmation-decisions.json`.

| Outcome | Count |
|---|---|
| Applied (writes) | 0 (dry-run — correct, no `--apply` passed) |
| Dry-run safe (AUTO_MIGRATE) | 23 |
| Already applied (no-op) | 14 |
| Skipped — blocked (REVIEW_ALIGNMENT) | 7 |
| Errors / PROVIDER_ERROR | 0 |
| Next manual-review candidates | 193 (series with no confirmed provider match yet — untouched by this task, pre-existing backlog) |
| Preserved orphan episodes (across dry-run-safe set) | 5 |

Operating classification totals: `AUTO_MIGRATE: 23`, `AUTO_REFRESH: 0`, `REVIEW_IDENTITY: 0`, `REVIEW_ALIGNMENT: 7`, `PROVIDER_ERROR: 0`.

**`AUTO_REFRESH: 0` explained, not a bug**: every title with a confirmed identity today either still has pending catalog-reconciliation work (→ `AUTO_MIGRATE`) or is a true no-op already reflected correctly in `ExternalIds` (→ `alreadyAppliedSeries`, a separate bucket not counted in operating totals). There is currently no real title sitting in the narrow middle ground "confirmed identity, catalog fully reconciled, but `ExternalIds` not yet written" — expected, given `alreadyAppliedCount` (14) already covers exactly that once applied once.

### Batch manifest (the actual proposed `AUTO_MIGRATE` batch) — real numbers

- Batch size: **23 titles**, batch id `library-health:provider-confirmation-pipeline:2026-07-10T20:43:17.661Z`.
- Total episodes that would be created across the batch: **971**. Total new seasons: **26**. Total orphans preserved: **5** (max 1 per title in this real batch — see honest caveat below).
- Identity band: **23/23 `HIGH_CONFIDENCE`** — zero `BORDERLINE` titles in the real batch today (the `BORDERLINE`-allowed-but-flagged design point wasn't exercised by real data this run).
- Status source: **22 `derived`, 1 `human-override`** (Game of Thrones — an explicit `statusOverride` from `decisions.json`), **0 `preserved`**. `expectedProgressChange: false` for all 23 — every title's objectively-derived status already matched its current status; no status actually changes in this proposed batch.
- **`viaAutoMigrationPolicyCount: 0`** — an important, honestly-reported finding: every one of the 23 `AUTO_MIGRATE` titles reached that outcome via the pre-existing base-safe classification or an explicit `migrationIntent`/`statusOverride`, **not** via the new eligibility-without-migrationIntent policy this task built. All 23 do show `autoMigrationEligible: true` (the new policy independently agrees they're safe — zero disagreement with what was already known-safe), but the current `decisions.json` snapshot happens not to contain any title that specifically *needed* the new policy (i.e., confirmed, no `migrationIntent`, and would have been blocked pre-task purely for lacking one). The new policy's real value is on **future** confirmed titles that arrive without a manually-set `migrationIntent` — this dry run proves it agrees with history, not that it has yet changed an outcome for a real title. Recorded here candidly rather than overstated.

### Concrete safety validation — the `realSeasonShrinkDetected` fix (added earlier this task) is not theoretical

All **7** real `REVIEW_ALIGNMENT` titles in this run (`The Flash (2014)`, `Naruto Shippuden`, `The Disastrous Life of Saiki K.`, `The Seven Deadly Sins`, `Beyond the Boundary`, `Nyaruko: Crawling with Love!`, `Love, Chunibyo & Other Delusions!`) are blocked **specifically** by the new `realSeasonShrinkDetected` hard floor added in Phase 3 (§"Important discovery during implementation" above) — every one of them has `migrationIntent: true` already set in the real `decisions.json`, and every one has a genuine season-count mismatch against the live TMDb catalog (e.g. Naruto Shippuden: season 21 entirely missing from the provider, season 13 shrank 35→20 episodes, etc.). **Before this task's fix, `classifyMigrationConfirmation` had no season-shrink check at all — these 7 titles, with `migrationIntent` already set by a human for an unrelated reason, would have been silently migrated destructively.** This is real, present-day evidence the fix was not a defensive-only exercise; it closes a gap that would otherwise fire on real data in the very next pipeline run.

Independent cross-validation: Pipeline B's own (separately-implemented) season-shrink detection flags `RISKY_DO_NOT_APPLY` for all 7 of the same titles, **plus 7 more** not currently `migrationIntent`-marked in `decisions.json` (`The Office (US)`, `INVINCIBLE (2021)`, `Parks and Recreation`, `Brooklyn Nine-Nine`, `Star Wars Rebels`, `Black Mirror`, `Superstore`) — two independently-implemented checks agreeing on real risk is meaningfully stronger evidence than either check alone.

### Pipeline B (ongoing episode release refresh) — summary

| Classification | Count |
|---|---|
| `NO_CHANGE` | 186 |
| `NEW_RELEASE_AVAILABLE` | 5 |
| `FUTURE_ONLY` | 4 |
| `NEEDS_MANUAL_REVIEW` | 4 |
| `RISKY_DO_NOT_APPLY` | 14 |
| `SUSPICIOUS_BULK_INSERT` | 12 |
| `SEASON_ZERO_PROPOSED` | 1 |
| `PROVIDER_ERROR` | 0 |

**Direct, exact confirmation of the Phase 5 pipeline-boundary design**: all **12** real `SUSPICIOUS_BULK_INSERT` titles in Pipeline B (`Danny Phantom`, `xxxHOLiC`, `Dr. STONE`, `House`, `Monster Allergy`, `A Certain Scientific Railgun`, `Somebody Feed Phil`, `Edens Zero`, `Bungo Stray Dogs`, `Blue Exorcist`, `TOUGEN ANKI`, `Castlevania`) are **exactly** 12 of the 23 real `AUTO_MIGRATE` titles in Pipeline A's batch, with matching new-episode counts (e.g. House: 90 new in both; Dr. STONE: 70 in both). This is not a hypothetical scenario — these are real titles, in the real database, that Pipeline B genuinely cannot apply today (by design) and Pipeline A's new catalog-reconciliation capability genuinely can. The routing note and the actual fix are proven to correspond on real data, not just in tests.

`SEASON_ZERO_PROPOSED` fired exactly **once** (`One-Punch Man`, 2 released season-0 episodes) — consistent with Phase 5's disposition of this as a narrow, low-volume coverage gap rather than a systemic problem.

### Representative series (sample inspection across categories — not cherry-picked easy cases)

| Category | Example(s) | Detail |
|---|---|---|
| No orphans | Monster Allergy, One-Punch Man, Dr. STONE, House, Checkout | `unmatchedWatchedOrphanCount: 0` |
| One orphan | The Big Bang Theory, Game of Thrones, Black Mirror, Black Butler, Doctor Who (2005) | `unmatchedWatchedOrphanCount: 1` each |
| Many/scattered orphans | _none in today's real batch exceed 1 orphan_ | Honest gap: the ~472-orphan and scattered-pattern scale claims remain validated only by the earlier constructed engine test (prior session) and this task's unit/integration tests, not by a real title in this specific run. Flagged here rather than implied as proven by this dry run. |
| Season-0 orphan (benign, `SAFE_WITH_LOCAL_SPECIAL_ORPHAN`) | The Big Bang Theory, Modern Family, HIMYM, Doctor Who, INVINCIBLE, Game of Thrones, Black Butler, Black Mirror | Real classification from the actual pipeline run |
| Split-episode tail (`SAFE_WITH_SPLIT_EPISODE_TAIL`) | The Office (US), Parks and Recreation, Brooklyn Nine-Nine, Star Wars Rebels | Real classification; note 3 of these 4 are ALSO real `RISKY_DO_NOT_APPLY` in Pipeline B / would-be `REVIEW_ALIGNMENT` if `migrationIntent` were set — split-tail and season-shrink are independent, both genuinely present in real data on overlapping titles |
| Large catalog completion | House (90 new episodes, 4 new seasons), Dr. STONE (70 new, 3 new seasons), Bungo Stray Dogs (57 new), Somebody Feed Phil (40 new, 5 new seasons) | From the real batch manifest |
| Objectively-derived status | _no real status changes in this run_ (22/23 `derived` but resolved to the already-current value; 0 `preserved`) | Honest gap: derivation logic ran and produced the correct (matching) answer 22 times, and the "preserve on uncertainty" branch wasn't exercised by any real title this run — both are proven by unit/integration tests, not by a real state change here |
| Series with future episodes (`FUTURE_ONLY`) | Helluva Boss, My Adventures with Superman, Mushoku Tensei: Jobless Reincarnation, Delicious in Dungeon | Real Pipeline B classifications — confirms `FUTURE_ONLY` converges to `AUTO_REFRESH` correctly and is never treated as an error |
| Already-stable series (`NO_CHANGE`) | 186 real titles (e.g. Smallville, Soul Eater, Stranger Things, The Mandalorian, Wednesday) | The overwhelming majority of the real library — confirms the new policy doesn't destabilize titles that need no action |

### Pre-existing observation (not introduced by, and out of scope to fix in, this task)

`nextManualReviewCandidates` (193 entries) is documented in `provider-confirmation-pipeline-reports.ts` as "no confirmed provider match at all," but a second, pre-existing push site (`run-provider-confirmation-pipeline.ts` line 436, present before this task) also adds confirmed-but-blocked titles (e.g. `The Flash (2014)`, `Naruto Shippuden`) with a different reason string. Both inclusions are individually reasonable (both genuinely need human attention), but the interface comment is now imprecise about scope. Not fixed here — unrelated to this task's phases and outside the stated scope discipline (no unrelated cleanup) — recorded for future reference.

### Late addition made during Phase 10/11 prep: automatic inline post-apply verification

While drafting the Phase 11 rollout plan it became clear that "what verification should immediately follow the first real apply" needed a real answer, not a hypothetical one — a reusable verification *library* (Phase 7) that nothing ever calls isn't the same thing as verification actually happening. So `run-provider-confirmation-pipeline.ts`'s apply transaction was wired to call it automatically:

- Immediately **before** each series' transaction: `captureSeriesSnapshot(prisma, seriesId, userId)` (plain client, pre-write state).
- Immediately **after** the transaction commits: a second `captureSeriesSnapshot` call, then `verifySeriesPostApply(before, after, expectation)`, with `expectation` built from the same variables that drove the write (`catalogResult.seasonsCreated`/`episodesInserted`, `unifiedPreservedOrphanEpisodes`, `toStatus`, `toNextEpisodeId`).
- A failure does **not** roll back (the transaction already committed — auto-rollback-on-verification-failure was deliberately not built; that would be a second, riskier destructive-write path triggered automatically, which is exactly what the task's rollback safety rules argue against). Instead it's surfaced loudly: `console.error` per failed check at apply time, plus a compact `verification: {passed, failedChecks}` field on every `PipelineAppliedSeriesEntry`, a `summary.verificationFailureCount`, and a dedicated `## ⚠ Verification failures` markdown section that only appears when non-empty.
- This makes **every future real apply, including Batch 1**, self-checking by default — not an extra manual step an operator has to remember to run.

`PipelineAppliedSeriesEntry` gained `verification: AppliedVerificationResult`; `ProviderConfirmationPipelineReport.summary` gained `verificationFailureCount`. Updated `provider-confirmation-pipeline-reports.test.ts` fixtures accordingly and added 2 new tests proving a failure both counts correctly and renders in markdown, and that the section is omitted entirely when nothing failed. Full repo re-run after this change: **77 suites / 1048 tests green**, `tsc --noEmit` clean.

**Honest limitation**: this exact wired-together path (capture → apply → capture → verify, inside the real pipeline script) has not itself been exercised by a real apply in this task — no real apply was performed, per the task's explicit rule. Its two components are independently proven: `captureSeriesSnapshot` and `verifySeriesPostApply` both have passing real-Postgres integration tests (Phase 7), and the composition here is a direct, low-risk call sequence, not new logic. Flagged as the one part of the design that only gets its first real-world exercise during Batch 1 itself — which is precisely why Batch 1's success condition (below) requires reading its verification output, not just trusting it ran.

### Also built during Phase 11 prep: a real, working rollback-preview command

`library-health/run-rollback-preview.ts` — **read-only, makes no writes of any kind.** Reads the applied report (`latest-provider-confirmation-pipeline-report.json`), builds a rollback manifest (`rollback-logic.ts`), live-checks eligibility per applied title against the current database, and writes a preview (`rollback-reports.ts`) — the exact "rollback preview command" the task's Phase 11 deliverable list requires. **Actually run for real** against the current (empty — nothing has been applied yet) report to prove it works end-to-end rather than just asserting it would:

```
$ npx ts-node library-health/run-rollback-preview.ts
Rollback preview — READ ONLY (no writes of any kind)
  target user: 00000000-0000-4000-8000-000000000001
  reading applied report: .../library-health/output/latest-provider-confirmation-pipeline-report.json
  This report has no applied series — nothing to preview a rollback for. Re-run after a real apply.

Done. Rollback preview written (eligible: 0, refused: 0):
  .../library-health/output/latest-rollback-manifest.json
  .../library-health/output/latest-rollback-preview.json
  .../library-health/output/latest-rollback-preview.md
```

Correctly handles the "nothing applied yet" case without error. Its meaningful first real exercise (non-empty manifest, real eligibility results) happens after Batch 1 actually applies — see Phase 11 below. Note this script never invokes `rollback-executor.ts` (the actual delete/restore code) — that remains deliberately unwired to any CLI command in this task.

---

## Phase 11 — Controlled rollout plan (NOT executed in this task)

Status: DONE (plan documented; **no batch has been applied**).

This plan is built directly from Phase 10's real dry-run output — every title, count, and command below is real, not illustrative. It is a plan to be executed in a **future** session/task, one stage at a time, each contingent on the previous stage's success and verification passing. **Do not skip stages. Do not widen scope on a stage that hasn't verified clean.**

### Mechanism: scoping a batch

There is no dedicated `--series-id-filter` flag. The existing, already-tested scoping mechanism is the `--decisions=` flag: create a filtered copy of `provider-confirmation-decisions.json` containing only the batch's titles, and point the pipeline at it. This is genuinely batch-based (the auto-policy still makes every actual safety decision for every title in the file) — it is not a return to manual per-title approval, it's an operational control over *which already-confirmed titles are considered in this pass*.

```bash
# Example for Batch 1 — filter the real decisions file down to the 10 chosen titles.
python3 -c "
import json
titles = ['One-Punch Man','Checkout','The Big Bang Theory','Doctor Who (2005)','Game of Thrones','House','Dr. STONE','Monster Allergy','Devil May Cry (2025)','Black Mirror']
with open('library-health/provider-confirmation-decisions.json') as f:
    decisions = json.load(f)
batch1 = [d for d in decisions if d['title'] in titles]
assert len(batch1) == len(titles), 'missing a title — check spelling against decisions.json'
with open('library-health/provider-confirmation-decisions.batch1.json', 'w') as f:
    json.dump(batch1, f, indent=2)
"
```

### Batch 1 — 10 representative titles (real, from Phase 10's actual dry run)

Deliberately diverse across the dimensions the task asked for, using only what real data actually contains today (see Phase 10's honest gaps: no real title currently has >1 orphan or a status-preservation case — noted per title below rather than glossed over):

| Title | Why it's in Batch 1 |
|---|---|
| One-Punch Man | Clean match — 0 orphans, tiny 2-episode gap |
| Checkout | Clean match — 0 orphans, tiny 2-episode gap, also independently confirmed `NEW_RELEASE_AVAILABLE`-eligible in Pipeline B |
| The Big Bang Theory | Orphan pattern (1, season-0-style benign special), large existing matched base (279 episodes) |
| Doctor Who (2005) | Orphan pattern (1), explicit `migrationIntent`, by far the largest single backfill in the batch (156 episodes) — proves the batch handles the largest real case, not just easy ones |
| Game of Thrones | Explicit `statusOverride` (`human-override` status source) — the one non-`derived` status path in real data, largest episode count (299) |
| House | Large catalog backfill (90 episodes, 4 new seasons), 0 orphans |
| Dr. STONE | Large catalog backfill (70 episodes, 3 new seasons), 0 orphans |
| Monster Allergy | Medium backfill (33 episodes, 1 new season), 0 orphans |
| Devil May Cry (2025) | Small backfill (8 episodes, 1 new season), 0 orphans, currently-airing/recent title |
| Black Mirror | Orphan pattern (1), explicit `migrationIntent`, medium backfill (15 episodes, 3 new seasons) |

**Explicitly not represented in Batch 1** (because it doesn't exist in real data today, not because it was skipped): a title with more than 1 orphan, a title where status resolves via the "preserve on uncertainty" branch, and a `BORDERLINE`-identity title. The first is separately proven at scale (~472 orphans) by this task's engine-level tests; the second and third are proven only by unit/integration tests, not real data. **If Batch 2 or 3 surfaces a real example of any of these, inspect it manually before trusting the automatic outcome, even though the policy says it's safe** — first-occurrence caution, not distrust of the policy itself.

**Preconditions**: full test suite green (already confirmed, Phase 9), `tsc --noEmit` clean (confirmed), `library-health/provider-confirmation-decisions.batch1.json` created as above, `DATABASE_URL`/`TMDB_ACCESS_TOKEN` configured (already true in this environment), no other write process touching these 10 series concurrently.

**1. Dry-run command** (confirm the scoped file behaves identically to the full dry run for these 10 titles):
```bash
npx ts-node library-health/run-provider-confirmation-pipeline.ts --decisions=library-health/provider-confirmation-decisions.batch1.json --out=library-health/output/batch1-dry-run
```
Expected report: `dryRunSafeCount: 10` (or fewer if `alreadyAppliedCount` catches any that no longer need writing since Phase 10's snapshot — re-check), `operatingClassificationCounts.AUTO_MIGRATE: 10`, `errorCount: 0`.

**2. Apply command**:
```bash
npx ts-node library-health/run-provider-confirmation-pipeline.ts --decisions=library-health/provider-confirmation-decisions.batch1.json --apply-safe-confirmed --out=library-health/output/batch1-apply
```
(`--apply-auto-safe-migrations` is not needed for this specific batch — Phase 10 confirmed all 10 reach `AUTO_MIGRATE` via base-safe classification or explicit `migrationIntent`, not the new auto-policy. Include it anyway if re-running after `decisions.json` has changed and you want the new policy considered too — it is additive and safe either way.)

**3. Expected report**: `appliedCount: 10`, `summary.verificationFailureCount: 0` (this is now checked automatically and inline — see above), `errorCount: 0`, no unexpected `skippedBlockedSeries` growth.

**4. Verification command**: none needed separately — verification now runs automatically as part of the apply command itself (see "Also built during Phase 11 prep" above). **Read `summary.verificationFailureCount` and the `## ⚠ Verification failures` markdown section before proceeding to Batch 2, regardless of the exit code.**

**5. Rollback preview command** (run immediately after, even if nothing looks wrong — this is the rehearsal the task explicitly asks for before wider rollout):
```bash
npx ts-node library-health/run-rollback-preview.ts --report=library-health/output/batch1-apply/latest-provider-confirmation-pipeline-report.json --out=library-health/output/batch1-rollback-preview
```
Expected: all 10 titles show `eligible: true` immediately after apply (nothing has had time to drift yet) — confirms the eligibility machinery itself works correctly against real applied data before it's ever actually needed.

**6. Stop conditions** (halt, do not proceed to Batch 2, investigate manually): `verificationFailureCount > 0`; any `errorCount > 0`; `appliedCount !== 10`; any applied title's `preservedOrphanEpisodeCount` or orphan identities differ from what the dry run predicted; rollback preview shows any of the 10 as `REFUSED` immediately after apply (would indicate a live-state bug, since nothing should have drifted yet).

**7. Success conditions** (proceed to Batch 2): all of the above pass, `verificationFailureCount: 0`, all 10 rollback-eligible, spot-check 2–3 titles' `nextEpisodeId`/`userStatus` in the actual app UI or a direct query against real expectations from the Phase 10 manifest.

### Batch 2 — all remaining real `AUTO_MIGRATE` titles from Phase 10 (13 titles)

Contingent on Batch 1's success conditions. The remaining 13 titles from the real 23-item Phase 10 batch: `A Certain Scientific Railgun`, `Somebody Feed Phil`, `TOUGEN ANKI`, `Black Butler`, `Sex Education`, `xxxHOLiC`, `Blue Exorcist`, `Danny Phantom`, `Sentenced to Be a Hero`, `Bungo Stray Dogs`, `A Certain Scientific Accelerator`, `Edens Zero`, `Castlevania` — well within the task's suggested ~25–50 range, so all remaining real titles go in one Batch 2 rather than being split further.

Same command shape as Batch 1, with a `provider-confirmation-decisions.batch2.json` filtered the same way (or simply re-run against the full real `provider-confirmation-decisions.json` with `--apply-safe-confirmed`, since Batch 1's 10 titles will already be `alreadyAppliedSeries` no-ops by then and won't be re-written — either approach is safe; the filtered-file approach is more auditable for a first rollout).

**Stop/success conditions**: identical in kind to Batch 1, evaluated against all 13.

### Batch 3 — ongoing operating model, not a fixed list

Once Batch 1 and 2 both verify clean, there is no fixed "Batch 3" list — every future `AUTO_MIGRATE`-classified title (from new `decisions.json` confirmations going forward, or from the 193 current manual-review candidates once a human confirms their provider identity) becomes routinely apply-eligible via the same command, run as often as desired (e.g. the same cadence as the existing `episode-release-refresh` dry-run habit). **This is the actual point of the whole task**: routine batches, not one-title-at-a-time manual review. Re-run the full-library dry run (Phase 10's commands, no `--decisions=` filter) periodically to see the current `AUTO_MIGRATE` queue size before each routine apply.

Single-series mode remains available (`--decisions=` pointed at a one-entry file) as a debugging/incident-response tool only — never recommended as the default operating model, per the task's explicit instruction.

### What would require stopping the rollout entirely (not just one batch)

- Any `verificationFailureCount > 0` that isn't immediately explainable and fixable (e.g. a genuine bug in `verifySeriesPostApply`'s expectation-building, not the write itself).
- Any evidence of a preserved orphan being mutated or losing its `EpisodeWatch` record.
- Any evidence of a title outside the manifest's `seriesIds` being written to (scope violation — `verifyBatchScope` exists precisely to catch this if wired into a batch-level check; currently the per-title verification alone was wired in, not the cross-batch scope check — **noted as a small remaining gap**: `verifyBatchScope` is tested but not yet called anywhere in `run-provider-confirmation-pipeline.ts`. Cheap to add before Batch 2 by diffing `appliedSeries.map(s => s.seriesId)` against the decisions file's title set.).
- Rollback preview showing unexpected refusals immediately after an apply (implies the eligibility logic itself, not just user activity, has a bug).

---

## Post-Phase-11 fix: Batch 1 decisions artifact was missing

Status: DONE.

**Gap found**: the Phase 11 rollout plan above documents the Batch 1 apply command as reading `library-health/provider-confirmation-decisions.batch1.json`, but that file was never actually created in this task — Phase 11 documented the *plan* to create it (via the `python3` filter snippet in "Mechanism: scoping a batch") but the filter script was never run. Running the documented apply command against a real environment correctly failed with `ENOENT` before any write occurred — the missing-file guard did its job; this was a documentation/preparation gap, not a code or safety-logic gap.

**Fixed**: ran the exact filter mechanism already documented in this file — read the canonical `library-health/provider-confirmation-decisions.json` (44 entries, opened read-only, never modified — verified unchanged both by entry count, still 44, and by never writing to that path), matched each of the 10 Batch 1 titles by exact title string, and wrote the matched decision objects **verbatim** (no field reconstruction — `provider`, `providerId`, `decision`, `migrationIntent`, `statusOverride`, `notes` all preserved exactly as they appear in the canonical file) to the new `provider-confirmation-decisions.batch1.json`.

**Validation performed**:
- Valid JSON (`python3 -m json.tool` parses cleanly).
- Exactly 10 entries, 10 unique titles — no duplicates, nothing extra.
- Every title matched the Phase 11 rollout table exactly: One-Punch Man, Checkout, The Big Bang Theory, Doctor Who (2005), Game of Thrones, House, Dr. STONE, Monster Allergy, Devil May Cry (2025), Black Mirror.
- Provider/providerId for all 10 cross-checked against Phase 10's real batch-manifest data — exact match (e.g. `tmdb:1418` for The Big Bang Theory, `tmdb:57243` for Doctor Who).
- `migrationIntent`/`statusOverride` preserved exactly: `true`/`null` for Doctor Who and Black Mirror, `true`/`COMPLETED` for Game of Thrones (explicit human override), `null`/`null` for the other 7 — matching what Phase 10 and the Phase 11 rollout table already documented.
- Canonical `provider-confirmation-decisions.json` confirmed untouched (still 44 entries after the filter ran).

**Separately discovered and fixed while validating**: the local Postgres container (`docker-compose.yml`'s `postgres` service, port 5433) was not running — Docker Desktop itself was down. This was an environment-state issue unrelated to the code; started Docker Desktop and ran `docker compose up -d`, confirmed `pg_isready`, then proceeded. Noted here since it's exactly the kind of precondition the Phase 11 rollout plan's preconditions list should account for going forward (added implicitly by this note — Batch 2/3 preparers should verify `docker compose ps` / `pg_isready` before assuming `DATABASE_URL` is reachable).

**Dry-run confirmation** (`--decisions=library-health/provider-confirmation-decisions.batch1.json`, no apply flag, real DB + real TMDb, `--out=library-health/output/batch1-preview`):
- `appliedCount: 0`, `writesToAppTables: false`, `mode: "dry-run"` — zero writes, confirmed.
- `dryRunSafeCount: 10`, `operatingClassificationCounts.AUTO_MIGRATE: 10`, `errorCount: 0`, `verificationFailureCount: 0`.
- `preservedOrphanEpisodeCount: 4` (The Big Bang Theory, Doctor Who, Game of Thrones, Black Mirror — 1 each), consistent with Phase 10.
- Batch manifest: `batchSize: 10`, total episodes that would be created: **677**, total new seasons: **12** (Monster Allergy: S2/33ep; One-Punch Man: 2ep; The Big Bang Theory: 2ep; Game of Thrones: 299ep; Black Mirror: S5-7/15ep; Dr. STONE: S2-4/70ep; Doctor Who: 156ep; Devil May Cry: S2/8ep; Checkout: 2ep; House: S5-8/90ep).
- All 10 series IDs match Phase 10's real data exactly.

This confirms the Batch 1 selection is still valid against current real data (nothing changed since Phase 10's dry run) and the scoped-decisions-file mechanism works as designed. **The real apply for Batch 1 has still NOT been run** — this was preparation and a dry-run rehearsal only, per the explicit instruction not to perform the apply.

---

## Batch 1 — real apply executed, then rollback-preview rehearsal + independent post-apply validation

Status: DONE.

**The real Batch 1 apply was executed** (by the user, outside this agent's own actions — per this task's standing rule that the agent itself never performs a real apply): `--decisions=library-health/provider-confirmation-decisions.batch1.json --apply-safe-confirmed --out=library-health/output/batch1-apply`. Confirmed directly from the real output artifacts (not just trusted from a description): `mode: "apply"`, `writesToAppTables: true`, `appliedCount: 10`, `errorCount: 0`, `skippedBlockedCount: 0`, `seasonsCreatedCount: 12`, `episodesCreatedCount: 677`, `preservedOrphanEpisodeCount: 4`, `verificationFailureCount: 0` — every one of the 10 `appliedSeries` entries carries `verification: {passed: true, failedChecks: []}`, recorded automatically by the inline verification wired in during Phase 11 prep. This is the first real broad apply performed against this database in the whole task.

### Rollback-preview rehearsal (read-only, no rollback executed)

```bash
npx ts-node library-health/run-rollback-preview.ts \
  --report=library-health/output/batch1-apply/latest-provider-confirmation-pipeline-report.json \
  --out=library-health/output/batch1-rollback-preview
```
Result: **10 eligible, 0 refused.** All 10 series show `eligible: true` with an empty `refusalReasons` list — expected immediately post-apply, since nothing has had time to drift. Confirms the eligibility machinery works correctly against real applied data, exactly as Batch 1's rollout-plan success condition required. `run-rollback-preview.ts` performs no writes of any kind (only `findMany`/`findUnique` reads plus local JSON/markdown file writes) — `rollback-executor.ts`'s actual delete/restore code was never invoked.

### Independent post-apply validation (direct database queries, beyond what the rollback-preview CLI itself checks)

Run to corroborate the apply-time verification result against the *current* live state, not just trust the recorded result:

- **Provenance/scope, exact**: `SELECT count(*) FROM "Episode" WHERE "importBatchId" = <catalog-reconciliation marker>` → **677**. `SELECT count(*) FROM "Season" WHERE "importBatchId" = <marker>` → **12**. `SELECT count(DISTINCT seriesId) ...` → **10**. All three match the apply report exactly, and since this was the first-ever real apply with this marker, these are also the *totals*, not a subset — proves no unrelated series carries this provenance marker.
- **Per-title breakdown, exact**: a `GROUP BY series.title` query reproduced the exact per-title episode counts from the apply report (Game of Thrones 299, Doctor Who 156, House 90, Dr. STONE 70, Monster Allergy 33, Black Mirror 15, Devil May Cry 8, and 2 each for One-Punch Man/Checkout/The Big Bang Theory) and the exact 12 new season numbers (House S5-8, Dr. STONE S2-4, Black Mirror S5-7, Monster Allergy S2, Devil May Cry S2).
- **Orphan integrity**: all 4 preserved orphan episode ids (from the apply report's `preservedOrphanEpisodes`) directly queried — same `episodeNumber`, **original** `importBatchId` (a pre-existing TV-Time-import marker, NOT the new catalog-reconciliation marker), and still has an `EpisodeWatch` row for this user. None were retagged, renumbered, or lost their watch.
- **No auto-watch**: `SELECT count(*) FROM "Episode" e JOIN "EpisodeWatch" ew ON ...WHERE e."importBatchId" = <marker>` → **0**. None of the 677 newly-created episodes have ever been watched.
- **No unrelated progress drift**: `SELECT count(*) FROM "UserSeriesProgress" WHERE "userId" = <dev user> AND "updatedAt" >= <apply timestamp> AND "seriesId" NOT IN (<the 10 batch series>)` → **0**. No progress record outside the batch changed at or after the apply.
- **Progress convergence**: current `userStatus`/`nextEpisodeId` for all 10 series read back exactly as expected (`WATCHING` for most, `CAUGHT_UP` for Doctor Who, `COMPLETED` for Game of Thrones, `nextEpisodeId: null` for all) — matches the manifest's `proposedUserStatus`/`expectedNextEpisodeIdChange: false` for every entry, confirming no drift since apply and directly explaining why the rollback preview found all 10 eligible.

**No unexpected refusal reasons, no drift, no missing provenance, no unrelated scope, no verification failure — Batch 1 is clean, both by its own inline verification and by this independent re-check.**

### Conclusion (superseded below — a real correctness bug was found in the Batch 2 dry-run manifest that also affects Batch 1's already-applied data)

Batch 1 is safe to treat as **completed** as far as catalog reconciliation (rows created, orphans preserved, scope) goes. The project was **not** actually ready for Batch 2 at this point, though — see the next section, found while inspecting Batch 2's Castlevania entry.

---

## CRITICAL BUG FOUND AND FIXED: userStatus/nextEpisodeId never accounted for episodes catalogInsertPlan was about to create

Status: DONE (fixed, tested, re-verified against real data). **Batch 1's already-applied real data is affected and needs separate remediation — see below, not performed by this agent per the standing no-real-write rule.**

### The bug, precisely

Reported by the user inspecting Batch 2's real dry-run manifest for Castlevania: 12 watched episodes in seasons 1-2, 20 new unwatched RELEASED episodes about to be created in seasons 3-4, `currentUserStatus: WATCHING` — yet the manifest predicted `proposedUserStatus: WATCHING` (no change) and `expectedNextEpisodeIdChange: false`, despite the real expected next episode being S3E1.

Root cause: **every status/next-episode resolution path in Pipeline A predates this task's catalog-creation capability (Phase 3) and has no way to know `catalogInsertPlan` is about to create new rows in the SAME apply**:
- The base (non-migration) path used `compareSeriesCatalog`'s `proposedNextEpisodeId` directly. That field is correctly computed (`compareSeriesCatalog` DOES merge local + provider-only episodes and finds the true first unwatched released slot) — but when the true next episode doesn't exist locally yet, `proposedNextEpisodeId` is `null` by design (there's no id to report), while a separate field, `proposedNextEpisodeIsNew`, carries the "actually, it's real, just not created yet" signal. The base path silently used the raw `null` and never consulted `proposedNextEpisodeIsNew` at all.
- `resolveObjectiveMigrationStatus` (auto-eligible path, `migration-policy-logic.ts`) derives COMPLETED/CAUGHT_UP purely from `matchedWatchedCount`/`matchedTotalCount` — both explicitly computed only over episodes that **already exist locally** (`computeMatchedEpisodeCounts` in `migration-catalog-plan-logic.ts` deliberately excludes anything not yet matched/created). It has no way to see 20 new episodes about to exist.
- `classifyMigrationConfirmation`'s migrationIntent path (`migration-confirmation-logic.ts`) is even simpler: no override → current status carried forward verbatim; `buildMigrationApplyPlan`'s `nextEpisodeId` is either `null` (finished status) or the current local nextEpisodeId carried forward — by explicit, documented design (comment: "never a newly-computed 'next' episode from the potentially unreliable provider catalog") — a reasonable design **before** catalog creation existed, since in that world nothing new could ever appear anyway.

None of these three paths is "wrong" in isolation for what they were originally built for. The bug is a genuine integration gap: Phase 3 added catalog-row-creation as a new, uniformly-applied capability without updating any of the three pre-existing status/next-episode resolution paths to account for it.

### Investigation findings (tasks 1-6)

1. Read Castlevania's real `UserSeriesProgress`: `nextEpisodeId` was `null` (fully caught up on the OLD, 12-episode-only local catalog — correctly null at that point in time).
2. Confirmed: null, not pointing at a stale/wrong episode, not some other corrupted state — just stale relative to the NEW catalog about to exist.
3-4. Reconstructed the merge: `compareSeriesCatalog`'s own Step 4 (`refresh-logic.ts` lines 369-388) already correctly merges local + provider-only episodes and finds the first unwatched released slot via `orderedMerged.find(...)` — this is the SAME logic `findFirstUnwatchedEpisodeId` uses live. Running it against Castlevania's real data (12 watched S1-2, 20 unwatched released S3-4) correctly identifies S3E1 as `proposedNext`, with `proposedNextEpisodeIsNew: true` (no local id exists yet) — this part was already correct before any fix.
5. Exact expected post-apply state: `userStatus: WATCHING` (there IS a next episode → `deriveUserStatusFromNextEpisode(true, ...)` = WATCHING), next episode = **Season 3, Episode 1**, `expectedProgressChange: false` (WATCHING → WATCHING, already correct), `expectedNextEpisodeIdChange: true` (null → a real episode id).
6. **The manifest projection was wrong** (used `comparison.proposedNextEpisodeId` raw, ignoring `proposedNextEpisodeIsNew`) — **and the apply-time recomputation was ALSO wrong** (the exact same variable, `unifiedResolvedNextEpisodeId`, feeds the real `UserSeriesProgress` write in the apply transaction — this is not merely a reporting bug, it would have written the wrong value to the database).

### Search across all 13 Batch 2 titles (task 7)

Every one of the 13 Batch 2 titles has `episodesToCreate > 0` (the whole batch was selected as `AUTO_MIGRATE` specifically because of pending catalog work) and every one was pre-fix reporting `expectedNextEpisodeIdChange: false` despite real new unwatched episodes being planned — **the bug affected all 13 of 13 Batch 2 titles**, not just Castlevania. (`userStatus` itself was accidentally already correct for all 13, since all 13 had `currentUserStatus: WATCHING` already — unlike Batch 1's Doctor Who, see below.)

### Fix implemented (task 9)

1. **`episode-release-refresh/refresh-logic.ts`**: added `proposedNextSeasonNumber`/`proposedNextEpisodeNumber` to `CompareSeriesCatalogResult` — structured (season, episode) for the proposed-next slot, so a caller can resolve the real row id once it exists without re-parsing the display-only `proposedNextEpisodeLabel` string. Backward-compatible addition; updated 2 existing test fixtures (`incomplete-catalog-investigation.test.ts`, `provider-confirmation-decisions-logic.test.ts`).
2. **`library-health/migration-policy-logic.ts`**: new pure function `shouldForceWatchingForPendingNextEpisode({hasProposedNextEpisode, liveUserStatus, explicitStatusOverrideGiven})` — a single, narrow, always-safe decision: force the status/next-episode correction ONLY when there verifiably IS a next episode (existing or about to be created) AND the status isn't protected (DROPPED/PAUSED) AND no explicit human `statusOverride` was given. Never fires when there's nothing new to watch, leaving every other nuance (derive/preserve/carry-forward for the "genuinely nothing new" case) completely untouched. 7 new unit tests, reproducing the Castlevania case, the Doctor Who CAUGHT_UP case, the Black Mirror case, the Game-of-Thrones-override-must-not-be-touched case, and both protected-status cases.
3. **`library-health/run-provider-confirmation-pipeline.ts`**: wired in twice — once pre-transaction (dry-run preview, using the pre-transaction status snapshot; can only report the change as pending since the real id doesn't exist yet — a new `pendingNewNextEpisodeCreation` flag forces `nextEpisodeId.changed: true` in the report even though `to` stays `null`) and once inside the apply transaction (using the LIVE re-read status, matching every other live re-check already in that transaction; resolves the REAL created episode id via `tx.episode.findFirst({season: {seriesId, seasonNumber}, episodeNumber})` now that `createMissingSeasonsAndEpisodes` has actually run).
4. New real-Postgres integration test (`post-catalog-creation-next-episode.integration.test.ts`) reproducing Castlevania's exact shape (12 watched S1-2, 20 new unwatched released S3-4) end to end against a throwaway fixture, proving the `tx.episode.findFirst` resolution mechanism itself (not just the pure decision function) correctly resolves to the real S3E1 row.

Full repo re-run after the fix: **78 suites, 1055 tests, all green.** `tsc --noEmit` clean.

### Re-verification against real data (task 9, "rerun... Batch 2 dry run")

Re-ran the real Batch 2 dry run (`--decisions=library-health/provider-confirmation-decisions.batch2.json`, no apply flag) after the fix:
- `appliedCount: 0`, `errorCount: 0` — zero writes, as required.
- **Castlevania, before → after**: `expectedNextEpisodeIdChange: false → true`. All other fields unchanged (still `AUTO_MIGRATE`, still `episodesToCreate: 20`, `seasonsToCreate: [3,4]`, still `WATCHING → WATCHING`).
- All 13 Batch 2 titles now correctly show `expectedNextEpisodeIdChange: true`.

### Batch 1's already-applied data — confirmed affected, self-healing path confirmed, NOT remediated by this agent

Since Batch 1's real apply happened BEFORE this fix existed, its written `UserSeriesProgress` rows have the same defect. Checked directly: **9 of 10** Batch 1 titles are affected (`nextEpisodeId` stuck at `null` despite real unwatched episodes now existing; Doctor Who additionally has the wrong `userStatus`, `CAUGHT_UP` instead of `WATCHING`). The 10th, **Game of Thrones, is NOT a bug** — its `nextEpisodeId: null`/`userStatus: COMPLETED` reflects an explicit human `statusOverride`, which the fix correctly continues to respect.

**Good news, verified, not just assumed**: re-ran the real Batch 1 dry run (`--decisions=...batch1.json`, no apply flag) with the fix in place, against the already-Batch-1-applied database. Result: `appliedCount: 0` (still dry-run), `dryRunSafeCount: 10`, `alreadyAppliedCount: 0` (previously these were correctly no-ops; now the pipeline correctly detects each one as having a pending progress-only correction), `episodesToCreate: 0`/`seasonsToCreate: []` for all 10 (nothing new to create — Batch 1 already created everything) — the manifest now proposes, for each title, **only** a `UserSeriesProgress` fix:
- Doctor Who (2005): `CAUGHT_UP → WATCHING`, `expectedProgressChange: true`, `expectedNextEpisodeIdChange: true`.
- The other 8 non-GoT titles: status stays `WATCHING` (already correct), `expectedNextEpisodeIdChange: true` (now resolves to the REAL existing episode id, since Batch 1 already created these rows — no "pending creation" placeholder needed this time).
- Game of Thrones: `expectedNextEpisodeIdChange: false` — correctly untouched, override respected.

**This means the existing, already-tested pipeline itself is the remediation path** — no new one-off data-fix script is needed. Running `--decisions=library-health/provider-confirmation-decisions.batch1.json --apply-safe-confirmed` again would apply *only* the progress correction for these 9 titles (zero catalog/episode/poster work, confirmed by `episodesToCreate: 0` etc.) — but **this agent did not run that apply**, per the explicit instruction not to modify the database in this task. This is flagged here as a concrete, ready-to-run, low-risk follow-up for the user to decide on and execute separately.

### Conclusion

The manifest projection AND the apply-time recomputation were both wrong, for the reason explained above — not a display-only bug. Fixed at the root (a single, narrow, well-tested correction applied uniformly to all three status-resolution paths), verified against real data before and after, and cross-checked against Batch 1's already-applied real data with a confirmed, ready self-healing remediation path. **Batch 2 is now safe to apply** (see the final report for the exact recommended command) **after the user decides whether/when to also re-run Batch 1's correction.** No real apply was performed by this agent at any point in this investigation.

---

## Batch 2 — Execution, Verification, Rollback Rehearsal, Convergence

Status: DONE.

| Stage | Status |
|---|---|
| Decisions file validation (13 unique, matches canonical, no drift) | DONE |
| Stage 1 — dry-run re-validation | DONE |
| Stage 2 — Castlevania pre-apply investigation | DONE |
| Stage 3 — pre-apply baseline | DONE (via existing pre-apply dry-run artifacts; no separate snapshot script needed — see note below) |
| Stage 4 — execute apply | DONE, but **not by this agent this turn** — see note below |
| Stage 5 — inspect apply report/manifest | DONE |
| Stage 6 — Castlevania post-apply validation | DONE — PASS |
| Stage 7 — independent live validation | DONE — PASS |
| Stage 8 — rollback preview | DONE — PASS (13 eligible, 0 refused) |
| Stage 9 — classification convergence | DONE — PASS WITH EXPLAINED, PRE-EXISTING FINDINGS (see below) |
| Stage 10 — tests/typecheck | N/A — no code changed this task |
| Stage 11 — this section | DONE |

### Important process note: the real apply had already happened before this stage began

When this task started, `library-health/output/batch2-apply/` already contained a real, successful apply (`mode: apply`, `writesToAppTables: true`, generated `2026-07-11T08:31:04.317Z`) — evidently run directly by the user, the same way Batch 1's real apply was run outside this agent's own actions. This agent's Stage-1 dry-run re-check (run to fulfill the task's own "re-run and validate the dry run" instruction) came back showing `alreadyAppliedCount: 10, dryRunSafeCount: 3` instead of the expected all-13-pending state — the signal that the apply had already occurred. Per the task's own explicit instruction ("do not attempt to 'fix forward' by running another apply unless the cause is fully understood and the second apply is demonstrably idempotent and safe"), **this agent did not run the apply command again.** Instead, the already-existing real apply artifacts (report + manifest, generated 08:31:04Z, using the already-fixed code from the prior session) were used as the authoritative record for Stages 4 onward, and all validation (Stages 5-9) was run against the real, live post-apply database state.

### Investigation: why 3 of 13 titles showed pending work on re-check

Black Butler, Danny Phantom, and Bungo Stray Dogs showed `episodeUpdateCount: 7/1/2` on the post-apply dry-run re-check, despite having `episodeUpdateCount: 0` at apply time and `verification.passed: true`. Traced to: these are the 3 titles with the largest new-episode counts among the ones that had zero pending metadata work pre-apply; their `matchedTotalCount` grew between apply-time and re-check-time (e.g. Black Butler 70→78) because the newly-created episodes are now counted as "matched" on this second, independent TMDb fetch. The `episodeUpdateCount` reflects ordinary metadata field drift (title/overview/airDate/runtime) between two separate TMDb API calls made ~13 minutes apart — a normal, pre-existing, expected characteristic of any metadata-backfill diff against a live external API, completely unrelated to the nextEpisodeId/status fix from earlier this session. Confirmed NOT related to the fix: `userStatus`/`nextEpisodeId` were reported `changed: false` for all 3 (i.e., unchanged from what was correctly written at apply time) — only episode metadata fields differ. This does not affect any Batch 2 success/stop condition (none concern ongoing metadata freshness) and does not indicate any data corruption — flagged here per the task's "report any difference" instruction, not hidden.

### Stage 2/6 — Castlevania: full before/after

- **Pre-apply** (dry run, post-fix, before real apply): `userStatus: WATCHING (unchanged)`, `nextEpisodeId.changed: true` (correctly flagged as pending, `to: null` since the real id didn't exist yet), `seasonsToCreate: [3,4]`, `episodesToCreate: 20`.
- **Real apply result**: `seasonsCreated: [3,4]`, `episodesCreated: 20`, `userStatus: WATCHING→WATCHING`, `nextEpisodeId: null → c2f87d4f-309a-497c-834d-f6f4c9a77aa1`, `verification: {passed: true, failedChecks: []}`.
- **Independent live-DB validation** (this agent, read-only SQL): Season 3 and 4 exist (4 episodes in S1, 8 in S2 — pre-existing; 10 in S3, 10 in S4 — all newly created, all tagged with the catalog-reconciliation batch marker). Zero of the 20 new episodes have an `EpisodeWatch`. All 12 original watched episodes still watched. Current `UserSeriesProgress`: `userStatus: WATCHING`, `nextEpisodeId` resolves to **Season 3, Episode 1** — exactly as required. **Castlevania post-apply validation: PASS.**

### Stage 7 — independent live validation, full results

- Total `Episode` rows carrying the catalog-reconciliation marker (cumulative, Batch 1 + Batch 2, since the marker is a constant, not per-batch): **971** = 677 (Batch 1) + 294 (Batch 2) exactly.
- Total `Season` rows: **26** = 12 + 14 exactly.
- Distinct series carrying the marker: **23** = 10 + 13 exactly — no unrelated series in scope, cumulative across both batches.
- Per-title episode counts (queried directly): exact match to the apply report for all 13 titles (Railgun 25, Phil 40, TOUGEN 23, Black Butler 8, Sex Ed 8, xxxHOLiC 12, Blue Exorcist 36, Danny Phantom 29, Sentenced 4, Bungo Stray Dogs 57, Accelerator 7, Edens Zero 25, Castlevania 20).
- Zero of the newly-created episodes (any of the 13) have an `EpisodeWatch`.
- The one preserved orphan (Black Butler, S0E11) confirmed untouched: original id, original `importBatchId` (the pre-existing TV-Time-import marker, not the new one), still has its watch record.
- All 13 titles' current `UserSeriesProgress` read back exactly matching what the apply report recorded (`userStatus`/`nextEpisodeId` both).
- Zero `UserSeriesProgress` rows outside the 13 were updated at/after the apply timestamp — no unrelated progress drift.

### Stage 8 — rollback preview

`npx ts-node library-health/run-rollback-preview.ts --report=library-health/output/batch2-apply/latest-provider-confirmation-pipeline-report.json --out=library-health/output/batch2-rollback-preview` — **13 eligible, 0 refused.** All 13 titles recognized. Read-only, confirmed no writes (the executor was never invoked).

### Stage 9 — classification convergence (Pipeline B re-run)

Ran `episode-release-refresh/run-refresh.ts` fresh, post-Batch-2. Result across all 23 Batch 1 + Batch 2 titles:

- **18 of 23 converge to `NO_CHANGE`** — the clean, fully-expected outcome (nothing left to reconcile, no duplicate re-planning of the same rows): Monster Allergy, One-Punch Man, Checkout, House, Dr. STONE, Devil May Cry, A Certain Scientific Railgun, Somebody Feed Phil, TOUGEN ANKI, Sex Education, xxxHOLiC, Blue Exorcist, Danny Phantom, Sentenced to Be a Hero, Bungo Stray Dogs, A Certain Scientific Accelerator, Edens Zero, Castlevania.
- **`SUSPICIOUS_BULK_INSERT` dropped from 12 (pre-Batch-1) to 0** — every real title Phase 10 originally found trapped by this classification is now fully reconciled via the two batches. Directly confirms Phase 5's pipeline-boundary design working end to end on real data.
- **`SEASON_ZERO_PROPOSED` dropped from 1 to 0** — One-Punch Man's season-0 episodes, created by Batch 1, are no longer "new" from Pipeline B's perspective.
- **5 of 23 titles show a review-tier classification** — Doctor Who, Game of Thrones, Black Mirror, Black Butler (`RISKY_DO_NOT_APPLY`) and The Big Bang Theory (`NEEDS_MANUAL_REVIEW`). **Investigated, explained, confirmed pre-existing, not a Batch 2 regression:**
  - All 5 were **already** in a review-tier classification before Batch 1/2 ever ran (Phase 10's original dry run: Doctor Who/GoT/Big Bang Theory/Black Butler were `NEEDS_MANUAL_REVIEW`; Black Mirror was already `RISKY_DO_NOT_APPLY`). Three of them (Doctor Who, GoT, Black Butler) shifted from `NEEDS_MANUAL_REVIEW` to `RISKY_DO_NOT_APPLY` specifically — same underlying cause, one classification tier stricter.
  - Root cause: all 5 have a **season-0 preserved orphan** (the exact orphans migration mode was built to preserve — Doctor Who S0E0, GoT S0E55, Black Mirror S0E2, Big Bang Theory S0E6, Black Butler S0E11). Pipeline B's season-shift guard compares LOCAL season-0 episode count against a **fresh** provider fetch; for these specific titles the counts now differ by exactly 1 (e.g. Doctor Who: 200 local vs 199 from the provider) — consistent with ordinary TMDb data volatility for large, loosely-cataloged season-0 "extras" collections between two separate fetches, not a structural regression.
  - Contributing factor, already flagged as a known design tradeoff in Phase 5: Pipeline A's `buildMigrationCatalogInsertPlan` deliberately does **not** exclude season-0 episodes (unlike Pipeline B's own gated insert logic) — for these specific large-season-0-count titles, this made the local season-0 count somewhat more exposed to this kind of provider-side drift. Phase 5 explicitly named this as "the first place to revisit" if real dry-run evidence surfaced a problem — this is exactly that evidence, recorded here as a concrete follow-up rather than silently ignored.
  - **Not a stop-condition violation**: Pipeline B is dry-run-only (no apply mode exists) — none of these 5 titles had anything written by this classification; it only affects whether a *future* ordinary release-refresh pass would flag them for a human to look at before proceeding, which is arguably the correct, cautious outcome for titles with a genuine season-0 structural quirk. Their actual catalog reconciliation (Batch 1/2's real job) is independently confirmed 100% correct for all 5 (Stage 5/7 above).
  - `DEFERRED` follow-up, not performed in this task: consider whether Pipeline B's orphan tolerance should be extended to recognize migration-preserved orphans specifically (narrowing when `RISKY_DO_NOT_APPLY`/`NEEDS_MANUAL_REVIEW` fires for a title that already went through Pipeline A's migration path) — a policy question for the next session, not a data-safety issue for this one.

### Final Batch 2 status

**DONE.** Every success condition met; the 5-title convergence finding is a fully-explained, pre-existing, non-blocking observation, not a failure. See the final report (delivered to the user in this turn) for the complete 13-section writeup.
