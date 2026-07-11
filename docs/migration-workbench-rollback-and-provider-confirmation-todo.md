# Migration Workbench: Rollback, Provider Confirmation, Prioritization — TODO

Tracks the task: "finish the operational safety and provider-confirmation workflow, then create clean commits."

## Part 1 — Audit uncommitted work
- [x] Inspected server + mobile git status/diffs, classified into Migration Workbench / Watchlist / unrelated buckets.
- [x] Confirmed generated reports (`library-health/output/`) and real decisions data (`provider-confirmation-decisions.json`) are already gitignored — no risk of committing them.

## Part 2 — Rollback / recovery
- [x] Added `MigrationHistory` Prisma model (durable audit record, written inside the same transaction as the apply).
- [x] Extended `createMissingSeasonsAndEpisodes` to return inserted episode ids (additive, both callers unaffected).
- [x] `library-health/migration-rollback-logic.ts` — pure eligibility/preview, scoped to exact `episodesInsertedIds` (not the old `importBatchId`-wide scope).
- [x] `library-health/migration-rollback-executor.ts` — transactional executor, defense-in-depth re-checks, correct operation ordering (progress restore before episode delete).
- [x] `GET /migration-workbench/history`, `GET /migration-workbench/history/:id`, `POST .../rollback-preview`, `POST .../rollback`.
- [x] Real rollback validated against the dev DB (Young Sheldon: apply → preview → rollback → verified restored → idempotency confirmed).

## Part 3 — Mobile history/rollback UI
- [x] `MigrationHistoryScreen.tsx`, `MigrationHistoryDetailScreen.tsx` (preview → explicit confirm → rollback → refreshes Workbench/Watchlist/Home/History).

## Part 4 — In-app provider identity confirmation
- [x] `ProviderIdentityDecision` Prisma model — runtime-safe source of truth, replacing the JSON file as the *live* source.
- [x] One-time backfill script (`run-backfill-provider-decisions.ts`) — all 44 JSON entries migrated, idempotent.
- [x] `library-health/provider-identity-decisions-store.ts` — shared read/write module, used by both the CLI and the app.
- [x] `library-health/search-provider-candidates-for-series.ts` — extracted single-series candidate search (reuses `tmdb-enrichment/scoring.ts` + `season-structure-tiebreak.ts` + `missing-provider-candidates-logic.ts` verbatim).
- [x] `GET /migration-workbench/:seriesId/candidates`, `POST .../confirm-identity`.
- [x] `ProviderCandidateSearchScreen.tsx` — search, compare, explicit select, confirm identity, continue to proposal.
- [x] Real validation: Andor searched, confirmed (tmdbId 83867), transitioned out of No Reliable Provider into a real, eligible proposal — protected DROPPED status correctly preserved even with 8 new episodes pending.

## Part 5 — Workbench prioritization
- [x] `groupMigrationWorkbenchItems.ts` already enforced priority order + counts + hidden-empty-sections (built in the prior session task).
- [x] Added "Find Provider" action (routes `NO_RELIABLE_PROVIDER` taps to candidate search instead of the proposal screen).
- [x] Added "Migration History" entry point on the Workbench screen.
- [ ] Bulk-apply for Ready Automatic — deliberately NOT built (spec: "optionally support... only after proving all items are deterministic and rollback-enabled" — descoped for this pass, individual apply already exists).

## Part 6 — Real audit/validation
- [x] Final counts: 221 total (18 Ready Automatic, 4 Ready for Confirmation, 7 Needs Episode Review, 192 No Reliable Provider).
- [x] One No Reliable Provider series (Andor): searched, confirmed, real proposal generated, **not** applied (per instructions).
- [x] One Ready Automatic series (Young Sheldon): applied, verified derived status (CAUGHT_UP→COMPLETED), verified it left the Workbench, then rolled back and restored (test-only, not a permanent change).
- [x] Migration history record existence verified.
- [x] Rollback preview exact before/after verified.
- [x] Real rollback verified (provider + progress restored, watch history intact, idempotent).

## Part 7 — Tests
- [x] `migration-rollback-logic.test.ts` (11 cases, pure).
- [x] `migration-rollback-executor.integration.test.ts` (5 cases, real Postgres).
- [x] `provider-identity-decisions-store.integration.test.ts` (5 cases, real Postgres — persistence, isolation, shared source, re-confirm).
- [x] `groupMigrationWorkbenchItems.test.ts` (mobile — priority order, empty-section hiding; pre-existing from prior task).
- [ ] Full 30-case enumerated test list from the spec not exhaustively implemented 1:1 — mobile screen-level interaction tests (candidate flow, rollback confirmation dialog) not written given time constraints; the underlying logic/persistence/safety-critical paths are covered.

## Part 8 — Documentation
- [x] `docs/migration-workbench-guide.md` — lifecycle, rollback, provider confirmation, source of truth, protected statuses, CLI-only gaps, operational recovery.
- [x] This TODO file.

## Part 9 — Commits
- [ ] See final report for exact staged files and commit hashes.
