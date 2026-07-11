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
  → series disappears from the Workbench once the CLI report cache is refreshed
```

Every step reuses the same canonical logic the `library-health` CLI pipeline already used — no second migration engine exists. `library-health/run-provider-confirmation-for-decision.ts` is the single function both the CLI (`run-provider-confirmation-pipeline.ts`) and the app (`MigrationWorkbenchService`) call to classify and apply a migration.

## 2. Provider identity confirmation

Identity confirmation (which TMDb/TVmaze show a local series actually is) is **permanently human-owned** — no code anywhere in this app or pipeline ever auto-selects an identity, even a high-confidence one. What changed in this task: identity confirmation is no longer CLI/JSON-file-only.

- `GET /migration-workbench/:seriesId/candidates` — live TMDb search + score, reusing `library-health/search-provider-candidates-for-series.ts` (extracted from `run-missing-provider-candidates.ts`, same scoring/season-structure-tiebreak logic).
- `POST /migration-workbench/:seriesId/confirm-identity` — saves the user's explicit choice. Does **not** apply a migration; it only makes the series eligible for a real proposal, exactly like a CLI-confirmed decision.

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
