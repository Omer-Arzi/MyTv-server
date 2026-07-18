# My TV — Server

Personal TV-series tracking backend: NestJS (Express) + TypeScript + PostgreSQL/Prisma. `cd` into `server/` before working — this is its own git repo, separate from the sibling `mobile/` and `client/` directories under `my-tv/` (see `mobile/CLAUDE.md` for the cross-repo picture and mobile-side conventions). Full narrative API reference for the mobile client: `API_CONTRACT.md` (orientation only — `/docs` on the running server is the live source of truth). Setup/scripts: `README.md`.

## Stack & running it

- NestJS + Express, PostgreSQL via Prisma (`prisma/schema.prisma`), Swagger at `/docs`.
- Local Postgres via `docker-compose.yml` on host port **5433** (not 5432 — avoids clashing with other local Postgres containers).
- Server listens on **3001** by default (`src/main.ts`) — deliberately not 3000, which the sibling `nemesh/client` Next.js project defaults to.
- No real auth: `DevUserMiddleware` (`src/common/middleware/dev-user.middleware.ts`) attaches a fixed dev user (`src/common/constants.ts`'s `DEV_USER_ID`) to every request. Every service reads the user id from `req.user` — swapping in real auth later only touches this one file.
- Env vars: `DATABASE_URL`, `PORT`, plus enrichment credentials `TMDB_ACCESS_TOKEN`/`TMDB_API_KEY`/`TRAKT_CLIENT_ID` (`.env.example`).

## App module shape

Root wiring: `src/app.module.ts`. Each live module under `src/modules/` follows the same shape: `*.controller.ts` (routing + Swagger docs only), `*.service.ts` (Prisma queries + orchestration), `*-logic.ts`/`*-helpers.ts` (pure functions, no I/O, unit-tested without a DB), `dto/` (validated request/response shapes). Modules: `home` (GET /home), `me` (recently-watched/watch-next/stale-series), `watchlist`, `episodes` (mark watched/unwatch/watch-all), `series` (library + detail + status), `search` (federated TMDb+TVmaze search, `src/modules/search/search-provider-fanout.ts`), `migration-workbench` (in-app UI for Pipeline A decisions, below), `sync` + `sync-scheduler` (automatic catalog refresh, below).

"Pure logic separated from I/O" is a hard convention across the *whole* repo, not just `src/` — every offline tool directory below follows it too (`*-logic.ts` files, unit-tested; `run-*.ts` CLI entrypoints do the I/O).

## Data model essentials (`prisma/schema.prisma`)

The schema's own comments are unusually thorough (read them in place before changing a model) — the essentials:

- **`Series.releaseStatus`** (`UNKNOWN`/`RETURNING`/`ENDED`/`CANCELLED`/`IN_PRODUCTION`) is the show's own provider-derived public status — never user-editable, defaults to `UNKNOWN` (not a confident guess; see `docs/status-model-plan.md` §3 for the bug an `ONGOING`-by-default value used to cause).
- **`UserSeriesProgress.userStatus`** (`UNKNOWN`/`WATCHLIST`/`WATCHING`/`PAUSED`/`DROPPED`/`CAUGHT_UP`/`COMPLETED`) is this user's personal relationship with a series — independent of `releaseStatus`. `WATCHLIST`/`PAUSED`/`DROPPED` are user-controlled; `WATCHING`/`CAUGHT_UP`/`COMPLETED` are derived (`src/common/derive-user-status.ts`'s `deriveUserStatusFromNextEpisode`). `PAUSED`/`DROPPED` are protected: no automated pipeline (enrichment apply, watch-all, migration) may silently override them — a fresh watch is the one thing that always clears them.
- **`UserSeriesProgress.nextEpisodeId`** is a cached pointer, recomputed on every watch/unwatch/refresh — keeps `/me/watch-next` a cheap read. "Next episode" always means "first released, not-yet-watched episode in (season, episode) order" (`src/common/is-episode-released.ts`, reused everywhere this decision is made — never reimplemented per call site).
- **`EpisodeWatch.watchSource`** (`SINGLE`/`BATCH`) distinguishes a deliberate per-episode mark-watched from the "mark all released" bulk escape hatch (`src/common/watch-all-logic.ts`) — `BATCH` rows are hidden from Recently Watched but otherwise completely normal (counted in progress/completion/next-episode). Individually re-marking a batch-watched episode flips it back to `SINGLE` and restores visibility.
- **`SeriesSyncStatus`** (one row per series) and **`LibraryRefreshJob`** (one row per manual full-library refresh) are the automatic scheduler's bookkeeping tables — see "Automatic catalog refresh" below.
- **`ProviderIdentityDecision`** is the live, runtime source of truth for "which provider identity has a human confirmed for this series" — supersedes `library-health/provider-confirmation-decisions.json`, which is now historical only (one-time-backfilled via `library-health/run-backfill-provider-decisions.ts`). Both the CLI pipeline and the in-app Migration Workbench read/write this same table.
- **`MigrationHistory`** is a durable, transactional audit record of every Migration Workbench apply, storing enough before/after state to build a rollback plan without re-deriving it later.

## The Stable Version Migration initiative

Cross-cutting effort spanning `library-health/`, `episode-release-refresh/`, and `src/modules/migration-workbench` + `src/modules/sync*`. Live, continuously-updated status doc: **`docs/stable-version-migration-todo.md`** — read it before touching any of this (all phases are currently DONE, but it's the record of *why* every safety rule below exists). Two deliberately separate pipelines:

- **Pipeline A — `library-health/`** (one-time catalog migration / provider-identity confirmation). Classifies every series' data health (`health-logic.ts`), finds/scores TMDb+TVmaze candidates for series with no confirmed provider match, and runs a human-reviewed confirm → dry-run → apply pipeline that migrates a series onto a confirmed identity (backfilling seasons/episodes/metadata; never deletes watched data). CLI entrypoints (`npm run library-health:*`, see `package.json`): `run-health-report.ts` (read-only), `run-missing-provider-candidates.ts` / `run-provider-confirmation.ts` (read-only candidate search), `run-provider-confirmation-pipeline.ts` (the general repeatable dry-run/`--apply-safe-confirmed` pipeline), `run-backfill-tmdb-external-ids.ts` / `run-backfill-provider-decisions.ts` (narrow one-time fixes).
- **Pipeline B — `episode-release-refresh/`** (ongoing freshness). For series that already have a confirmed `tmdbId`, periodically re-fetches TMDb and inserts newly-released episodes / updates changed fields — purely additive, insert-only, never reshapes. `refresh-operating-outcome.ts`'s `classifyRefreshOperatingOutcome` explicitly routes large/suspicious catalog gaps (`SUSPICIOUS_BULK_INSERT`) back to Pipeline A instead of bulk-inserting — a real release burst and "this catalog was always incomplete" are different problems with different remedies. CLI: `episode-refresh:dry-run` / `episode-refresh:apply[-dry-run]`, `progress-reconciliation:dry-run`/`:apply` (fixes `nextEpisodeId`/`userStatus` for a series whose future-dated episode's air date has since passed but never got recomputed — see `docs/progress-reconciliation-architecture-todo.md`).

**Both pipelines' logic is imported directly by the live NestJS app** — this is not a one-way "offline tool feeds the DB, app just reads it" relationship. `src/modules/migration-workbench/migration-workbench.service.ts` imports `library-health/run-provider-confirmation-for-decision.ts`, `library-health/migration-rollback-logic.ts`, etc. verbatim; `src/modules/sync/series-refresh-orchestrator.service.ts` imports `episode-release-refresh/refresh-logic.ts`, `refresh-one-series.ts`, `local-release-activation.ts`, etc. verbatim; `src/modules/search` imports `tmdb-enrichment/tmdb-client.ts` and `secondary-provider-audit/tvmaze-client.ts`. Treat every top-level tool directory as a library the app depends on, not a sandbox — changing its exported functions' behavior can change live HTTP responses.

**The hard invariant that must never be bypassed**: a real season shrink/renumbering (`detectRealSeasonShrink`, `library-health/season-zero-orphan-logic.ts`) always blocks an automatic migration. The *only* way past it is an explicit, per-decision `ProviderIdentityDecision.seasonShrinkReviewed: true`, set via a deliberately separate action (`MigrationWorkbenchService.reviewSeasonShrink`) — never implied by confirming identity, never batch-defaulted. See the `seasonShrinkReviewed` field comment in `prisma/schema.prisma` and `docs/episode-numbering-and-season-shift-risk.md` for why: providers routinely disagree with the TV Time import source on season/episode boundaries, especially for anime — a title/year-confidence match can be exactly right while episode *boundaries* still silently collide with already-watched content.

## Automatic catalog refresh (`src/modules/sync`, `src/modules/sync-scheduler`)

`EpisodeSyncSchedulerService` ticks hourly, asks `episode-release-refresh/sync-frequency-policy.ts`'s `isRefreshDue` which series are due, then delegates every per-series attempt to **`SeriesRefreshOrchestratorService`** — the single shared entry point for scheduled, manual-single-series, manual-full-library (`LibraryRefreshJobService`), and series-page-stale-on-open refreshes. Never call `refreshOneSeries` or hand-roll refresh logic directly; going around the orchestrator desyncs locking/backoff/status bookkeeping. Concurrency is an atomic claim on `SeriesSyncStatus.refreshInProgress` (conditional `updateMany WHERE refreshInProgress=false OR refreshStartedAt < staleCutoff`, 15-minute stale-lock timeout for crash recovery) — a tick that finds a lock held just skips and moves on. Interval-on-success is urgency-aware (`smart-scheduling-policy.ts`, 1h–30d tiers by userStatus × episode urgency, fed by `src/common/release-date-policy.ts`'s `computeEpisodeUrgency`); interval-on-failure is exponential backoff (15min base, 1-day cap) — independent of urgency. `SyncTrigger` (`SCHEDULED`/`MANUAL_SERIES`/`MANUAL_LIBRARY`/`SERIES_PAGE_STALE`/`LOCAL_RELEASE_ACTIVATION`) records what triggered the most recent attempt.

**Local release activation** (`episode-release-refresh/local-release-activation.ts`) is a separate, provider-free pass that recomputes `UserSeriesProgress` purely from already-local data — a known future episode "activates" into Watch Next the moment its stored `airDate` passes, without waiting for the next TMDb-calling refresh (which can be hours away). Runs on its own hourly tick, after every orchestrator refresh, and inside every full-library job.

Everything provider-facing in this cluster runs sequentially, never `Promise.all` — deliberate, to keep TMDb call volume predictable and avoid cross-series write races.

Provider date-only air dates (`"YYYY-MM-DD"`, no time/timezone) parse as **UTC midnight**, not local time — `src/common/release-date-policy.ts` centralizes and documents this; a real episode's actual availability can differ by hours from when this app considers it "released." This app has no per-user timezone concept anywhere (single hardcoded dev user), so if one is ever added, this is the one file that needs to change.

## Metadata providers

- **TMDb** (`tmdb-enrichment/`) is primary and live — working, tested, applied for the majority of enriched series. `tmdb-client.ts` (Bearer auth, exponential backoff), `scoring.ts` (title 50 / year 30 / rank-based-relevance 20 points; `AUTO_MATCH` ≥85, `NEEDS_REVIEW` 50–84, `NO_MATCH` below). Apply steps never re-score at apply time — they only ever read a frozen, already-reviewed plan.
- **Trakt** (`trakt-enrichment/`) has a complete, working dry-run pipeline but is currently blocked: OAuth app registration is broken for this account (`docs/metadata-provider-strategy.md`) — that's *why* TMDb became the primary track instead.
- **TVmaze** (`secondary-provider-audit/`) is secondary/cross-check only — no API key needed, used for search fanout (`src/modules/search`) and for auditing cases where TMDb's season/episode structure might be wrong, never a primary source of truth.

## Data safety

- **`npm run prisma:seed` is always safe** (upserts the dev user row, nothing else) — this is also what `prisma migrate dev` auto-triggers. **`npm run seed:demo:destructive` wipes every app table** and refuses to run unless `ALLOW_DESTRUCTIVE_SEED=true` *and* `prisma/seed-guard.ts`'s `evaluateSeedSafety` detects no real-data signal (any `ImportBatch` row, or any `Series`/`Episode`/`EpisodeWatch` row with a non-null `importBatchId`, blocks it unconditionally). Read `docs/dev-database-safety.md` before touching either seed script — it exists because an earlier unconditional wipe-and-reseed destroyed a real populated dev database (430 series, ~18,900 watches) via the ordinary `prisma migrate dev` seed hook.
- **`tvtime-export/`** (the ~70-file raw TV Time CSV export, source data for `import-tvtime/`) contains real, unredacted credentials/PII and is gitignored — never suggest committing, copying, or exposing it. `import-tvtime/denylist.ts` is the sole enforcement point keeping that sensitive data out of Postgres: a file-level denylist wholesale-excludes 13 sensitive files, plus a column-level denylist redacts specific field names from every other file. Any new importer touching TV Time export files must extend this denylist, never bypass it.

## Testing conventions

`npm test` runs Jest (`jest.config.js`, `testMatch: **/__tests__/**/*.test.ts`) across unit and integration tests together — integration tests self-skip via `const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip` rather than living in a separate suite. Integration tests hit a **real Postgres** (never mocked), create throwaway `User`/`Series`/etc. fixtures with `randomUUID()`-suffixed identifiers, and cascade-delete them in `afterEach` (delete the top-level `Series`/`User` row; Prisma's `onDelete: Cascade` relations handle the rest). Pure `*-logic.ts`/`*-helpers.ts` files are unit-tested with no DB at all — this split is why nearly every decision in this codebase (release-date policy, status derivation, migration classification, refresh eligibility) lives in its own no-I/O file.

Every dry-run/apply-pair tool in this repo (enrichment, library-health, episode-release-refresh, manual-progress-corrections) computes the *exact same plan* whether or not `--apply`/`dryRun` is set — dry-run only skips the final writes, so a report can never disagree with what actually happens on apply.

## Other one-shot/audit tool directories

Mostly one-time or point-in-time snapshots, not live pipelines — read-only, write report files under `<tool-dir>/output/`, never touch app tables directly:

- `import-tvtime/` — the original TV Time CSV importer (`npm run import:tvtime[:dry-run]`); dry-run wraps the whole import in a transaction and deliberately throws at the end to force rollback while still returning a report.
- `next-episode-backfill/` — one-time backfill of `nextEpisodeId` from already-settled data.
- `watch-next-audit/`, `watch-next-review/` — read-only correctness audits of Watch Next.
- `tvtime-parity-audit/`, `image-coverage-audit/`, `stale-series-audit/` — point-in-time snapshots cross-referencing DB state against cached provider reports (several of these deliberately match across runs by series **title**, not `seriesId`, since ids churn across DB rebuilds).
- `manual-progress-corrections/` — a deliberately non-generalized, one-shot plan for ~19 hand-investigated series corrections; not a reusable classifier.

## Key docs (`docs/`)

Long narrative markdown recording *why*, not just what — read the relevant one before touching adjacent code:
- `docs/stable-version-migration-todo.md` — the live authoritative status doc for the whole migration initiative (see above).
- `docs/status-model-plan.md` — the `releaseStatus`/`userStatus` design (referenced throughout the schema comments).
- `docs/episode-numbering-and-season-shift-risk.md` — why provider season/episode boundaries can silently disagree with the TV Time import, especially for anime.
- `docs/dev-database-safety.md` — the seed-wipe incident and guard (see "Data safety" above).
- `docs/metadata-provider-strategy.md` — TMDb-vs-Trakt-vs-TVmaze provider decision.
- `docs/progress-reconciliation-architecture-todo.md` — the `nextEpisodeId` staleness bug class and its fix.
- `docs/migration-workbench-guide.md`, `docs/library-health-provider-confirmation-runbook.md` — operational guides for the Migration Workbench / library-health CLI.
