# Migration Workbench — Lifecycle, Rollback, and Provider Confirmation

This doc explains the in-app Migration Workbench (`src/modules/migration-workbench/`), how it relates to the pre-existing `library-health/` CLI pipeline, and the operational recovery path if something goes wrong. It is a companion to `docs/stable-version-migration-todo.md` (the original policy design) — this doc covers what changed to make the Workbench a real, safe, in-app feature.

## 1. Lifecycle

```
Needs Attention (Migration Workbench)
  → Ready Automatic / Ready for Confirmation / Needs Episode Review / No Reliable Provider
  → select a series
  → [No Reliable Provider only] Find Provider → search candidates → confirm identity
  → review migration proposal (GET /migration-workbench/:seriesId/proposal — always a live fetch)
  → Confirm Migration (POST /migration-workbench/:seriesId/confirm — a real write)
  → catalog corrected, watch history mapped, status re-derived, MigrationHistory record created
  → series disappears from the Workbench immediately — see "List staleness invalidation" below
```

Every step reuses the same canonical logic the `library-health` CLI pipeline already used — no second migration engine exists. `library-health/run-provider-confirmation-for-decision.ts` is the single function both the CLI (`run-provider-confirmation-pipeline.ts`) and the app (`MigrationWorkbenchService`) call to classify and apply a migration.

### List staleness invalidation

`GET /migration-workbench` still reads the CLI pipeline's cached manifest/report (fast, no live provider calls for most items — see §2 below), but it no longer serves that cache verbatim. `MigrationWorkbenchService.invalidateStaleItems()` corrects it against canonical DB state before returning:

- **A non-rolled-back `MigrationHistory` row for a series removes it from the list entirely**, regardless of what category the cache says — cheap DB-only check, no live call. This is what fixes "I already confirmed a candidate and migrated it, but it's still stuck in Needs Attention": confirming identity and applying a migration in-app never used to touch the two cache files (only a manual CLI pipeline re-run regenerates them), so the item sat there unchanged until someone remembered to re-run the CLI. A rolled-back migration does the opposite — the item is deliberately NOT removed, since rollback un-resolves the series.
- **A `NO_RELIABLE_PROVIDER` item with a confirmed `ProviderIdentityDecision` (or already-matched `ExternalIds`) on file is a direct contradiction** — that category means "no confirmed decision" by construction — and triggers a live recompute via `getProposal()`'s own canonical logic (never a second classification path), replacing the cached category/reason with the live result. In practice this always lands on `NEEDS_EPISODE_REVIEW` or a fully-resolved drop, never silently on "still no reliable provider" — matching the product rule that identity confirmation alone never skips a genuinely-needed catalog review. Bounded to 10 live recomputes per list load (`MAX_LIVE_RECOMPUTE_PER_LIST`) so a screen load can never turn into an unbounded TMDb call burst; a recompute failure (missing `TMDB_ACCESS_TOKEN`, a transient network error) keeps the cached item rather than failing the whole list.

Deliberately **not** gated on comparing timestamps (e.g. decision time vs. the cache's own `generatedAt`) — a whole-library CLI pipeline run can take hours between when it captures that timestamp and when it actually finishes writing a given series' entry, which was confirmed empirically against a real stale cache in this codebase's history and makes timestamp comparison an unreliable staleness signal on its own.

## 2. Provider identity confirmation

Identity confirmation (which TMDb/TVmaze show a local series actually is) is **permanently human-owned** — no code anywhere in this app or pipeline ever auto-selects an identity, even a high-confidence one. What changed in this task: identity confirmation is no longer CLI/JSON-file-only.

- `GET /migration-workbench/:seriesId/candidates` — live TMDb search + score, reusing `library-health/search-provider-candidates-for-series.ts` (extracted from `run-missing-provider-candidates.ts`, same scoring/season-structure-tiebreak logic).
- `POST /migration-workbench/:seriesId/confirm-identity` — saves the user's explicit choice. Does **not** apply a migration; it only makes the series eligible for a real proposal, exactly like a CLI-confirmed decision.

### Confidence contract

**One canonical representation, normalized `0 <= confidence <= 1`, everywhere outside `search-provider-candidates-for-series.ts`.** `tmdb-enrichment/scoring.ts`'s `totalScore` is a RAW 0-100 scale (title match up to 50 + year match up to 30 + rank relevance up to 20), calibrated against that file's own thresholds (`AUTO_MATCH_MIN_SCORE=85`, `NEEDS_REVIEW_MIN_SCORE=50`) — it stays 0-100 internally because `classifyMissingProviderSeries`/`detectCloseCompetitor`/`sameTotalEpisodeCountTieBreaker` are all calibrated against that scale, and changing it would ripple into the whole `tmdb-enrichment`/CLI missing-provider-candidates pipeline, out of scope for the app-facing feature.

`search-provider-candidates-for-series.ts::normalizeConfidenceScore` is the **one, single place** that raw 0-100 score is ever converted to the 0..1 domain representation, exposed as `SearchedProviderCandidate.normalizedConfidence` (never `confidenceScore`, which stays the raw internal value). Every layer past that point uses `normalizedConfidence`/its 0..1 equivalent:

| Layer | Field | Scale |
| --- | --- | --- |
| `search-provider-candidates-for-series.ts` (internal) | `SearchedProviderCandidate.confidenceScore` | 0-100 raw, internal only |
| `search-provider-candidates-for-series.ts` (external) | `SearchedProviderCandidate.normalizedConfidence` | 0..1 — the conversion boundary |
| `ProviderCandidateDto.confidenceScore` (API response) | via `toCandidateDto` | 0..1 |
| Mobile `ProviderCandidate.confidenceScore` (API type) | mirrors the DTO | 0..1 |
| Mobile display (`formatConfidencePercent`) | `Math.round(x * 100)}%` | converts 0..1 → percentage, display only |
| `ConfirmIdentityDto.confidence` (request body) | `@Min(0) @Max(1)` | 0..1 |
| `ProviderIdentityDecision.confidence` (persistence) | via `saveProviderIdentityDecision` | 0..1 |

**Real bug this fixed**: the mobile candidate screen displayed `confidenceScore` directly as a percentage (already looked correct, e.g. "80%", because the raw score coincidentally reads like a percentage) and then sent that SAME raw 0-100 value back as `confidence` in the confirm-identity request body, which the 0..1-validated DTO correctly rejected with `"confidence must not be greater than 1"`. The bug was a missing conversion at the `toCandidateDto` mapping boundary, not a validation bug — the validation was already correct. Fixed by introducing `normalizedConfidence` at the true source (`search-provider-candidates-for-series.ts`) so every downstream consumer reads an already-correct value, rather than expecting each consumer to remember to divide by 100 itself.

## 3. Decision source of truth

`library-health/provider-confirmation-decisions.json` is now a **historical artifact only**. The live source of truth is the `ProviderIdentityDecision` Postgres table (`prisma/schema.prisma`), read/written through `library-health/provider-identity-decisions-store.ts` — the one module both the CLI and the app import.

- One-time backfill: `npm run library-health:backfill-provider-decisions` (already run against the dev DB — all 44 JSON entries migrated, idempotent to re-run).
- `run-provider-confirmation-pipeline.ts` defaults to reading the DB; pass `--decisions=<path>` to override with an ad hoc JSON file for one-off testing (e.g. a batch-N split) without touching the live DB.
- `source` column distinguishes `'cli-decisions-file'` (backfilled) from `'app-confirmation'` (made through the in-app flow).
- User isolation: `@@unique([userId, seriesId])` — two users can independently decide about the same catalog `Series` row without collision (verified in `provider-identity-decisions-store.integration.test.ts`).
- Staleness: not a separate rejection mechanism. Every proposal/apply always re-verifies live against TMDb regardless of how old the decision is — a stale decision simply produces a fresh, re-classified result, never a blind reuse of an old confidence score.

## 4. Migration proposal & apply

`GET /migration-workbench/:seriesId/proposal` is always a live fetch (no caching) for a series with a confirmed decision. `POST /migration-workbench/:seriesId/confirm` performs the real write — same transaction the CLI's `--apply-safe-confirmed --apply-auto-safe-migrations` flags run, scoped to one series.

**Known pre-existing gap, found and worked around in this task:** the pipeline's older ("base") write path derives `proposedUserStatus` via `compareSeriesCatalog`'s generic `deriveUserStatusFromNextEpisode`, which has no concept of protected statuses — it can *preview* `PAUSED → WATCHING`. The real apply-time write (`decideUserStatusUpdate`) already refuses this correctly, so it's a preview-accuracy bug, not a data-corruption risk. `migration-workbench-logic.ts::correctProposedStatusForProtection` corrects the *displayed* proposal to match what will actually happen, so the Workbench never shows a misleading preview.

## 5. Migration history

Every successful apply writes a `MigrationHistory` row **inside the same transaction** as the write it describes (`run-provider-confirmation-for-decision.ts`) — a successful apply can never exist without a matching history record. Stores full before/after state (provider, release status, user status, `nextEpisodeId`, inserted/updated/preserved-orphan episode ids, watched-mapping count) so rollback never has to re-derive anything.

- `GET /migration-workbench/history` — list, most recent first.
- `GET /migration-workbench/history/:migrationId` — full detail.

## 6. Rollback

**Rollback is real and wired in** (Part 2 of this task) — `library-health/migration-rollback-logic.ts` (pure eligibility/preview) + `migration-rollback-executor.ts` (the transactional executor). This is a **new**, `MigrationHistory`-scoped rollback path, not the pre-existing `rollback-logic.ts`/`rollback-executor.ts` (Phase 8, still unwired into anything) — that older pair scopes deletion by `CATALOG_RECONCILIATION_IMPORT_BATCH_ID`, a single constant shared by *every* migration ever run. If the same series were migrated twice, rolling back the second migration via the old mechanism could delete episodes the *first* migration inserted. The new path scopes deletion to the exact `episodesInsertedIds` recorded on one `MigrationHistory` row instead — strictly more precise.

Rollback always requires:
1. **Preview** (`POST .../rollback-preview`) — read-only, live re-checks eligibility every call.
2. **Explicit confirmation** — enforced by the mobile UI's confirmation dialog, not by the API itself.
3. **Revalidation at apply time** (`POST .../rollback`) — re-checks eligibility again, live, inside the transaction. Never trusts a client-supplied preview result.

Refusal reasons (`ALREADY_ROLLED_BACK`, `EPISODE_HAS_BEEN_WATCHED`, `PROGRESS_HAS_DRIFTED_SINCE_MIGRATION`, `NO_REVERSIBLE_CHANGES`) each carry a human-readable explanation surfaced verbatim by the API and mobile UI.

**Rollback never**: deletes an `EpisodeWatch` row, deletes an episode that has been watched, restores progress that has since drifted, or re-runs on an already-rolled-back migration (idempotent — refused, not repeated). Order of operations inside the executor matters: progress is restored to its "before" value *before* any episode is deleted, so a live `nextEpisodeId` can never point at a row about to be removed.

**Scope limitation, inherited from the pipeline's own design**: episode *metadata* backfills (title/overview/airDate/runtime updates on already-matched episodes) have no prior-value snapshot anywhere in the schema and are never reversed by rollback — same limitation the original `rollback-logic.ts` documented. `ExternalIds` and progress restoration, and inserted-episode removal, are fully reversible.

## 7. Protected statuses

`PAUSED` and `DROPPED` are protected everywhere in this pipeline — `migration-confirmation-logic.ts::isProtectedMigrationStatus`, reused directly by `resolveObjectiveMigrationStatus`, `shouldForceWatchingForPendingNextEpisode`, the real apply transaction, and the new rollback logic. No migration or rollback ever silently overrides them.

## 8. Remaining CLI-only operations

- Whole-library batch runs (`npm run library-health:pipeline[-apply]`) — the app only ever acts on one series at a time, by design (an explicit user action, never a background batch).
- `rollback-logic.ts`/`rollback-executor.ts` (the older, batch/importBatchId-scoped pair) — still unwired into any command; superseded by the per-migration rollback above for anything the Workbench applied, but left in place for the historical whole-batch report use case it was originally built for.
- Missing-provider-candidates *whole-library* report (`npm run library-health:missing-provider-candidates`) — the app's `GET /:seriesId/candidates` only searches one series at a time; the CLI report still exists for a full-library scan.
- `Series.releaseStatus` is not written by this pipeline at all (pre-existing gap, not introduced by this task) — a migration corrects the episode catalog and status but never touches the show's own broadcast-status column.

## 9. Operational recovery

If a real apply produces an unexpected result:
1. Check `GET /migration-workbench/history/:migrationId` for the exact before/after state.
2. Call `POST .../rollback-preview` — if eligible, the preview shows exactly what will be restored/removed.
3. Call `POST .../rollback` after explicit confirmation.
4. If rollback is refused (e.g. `EPISODE_HAS_BEEN_WATCHED`), the refusal `explanations` field states exactly why — manual review is needed at that point; there is no override.
5. Episode metadata backfills are never reversible (see §6) — if a backfill wrote something wrong, it requires a manual `UPDATE` against the specific `Episode` row(s), informed by `MigrationHistory.episodesUpdatedIds`.
