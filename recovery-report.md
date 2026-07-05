# MyTv Backend Recovery Report

**Date**: 2026-07-04 – 2026-07-05
**Scope**: backend/server only. Mobile app not touched at any point.

## 1. Timeline of recovery steps

1. **Incident**: a verification command accidentally executed `prisma/seed.ts`, which at the time was an unconditional wipe-and-reseed. It deleted all real, TV-Time-imported data (430 series, ~18,900 watches, TMDb enrichment, Watch Next decisions) and replaced it with 2 synthetic demo series. No backup existed.
2. **Safety-first response**: confirmed no seed script would run again; took a forensic `pg_dump` of the broken state (`db-backups/`, gitignored); built the first version of the seed guard (`prisma/seed-guard.ts` + self-guarded `prisma/seed-demo.ts`, committed in isolation as `95619ce`).
3. **Step 1 — TV Time re-import**: cleaned the 2 leftover demo series, then ran `import-tvtime/run.ts` (dry-run, then real) from the original `tvtime-export/` CSVs. Result: 430 series, 18,913 episode watches, 23 watchlist items, 393 progress rows, 0 errors — resolved an apparent 430-vs-433 discrepancy (the "433" figure had included 3 now-removed demo series in an earlier snapshot; verified 0 occurrences of any demo title in the real CSVs).
4. **Step 2 — TMDb enrichment replay**: discovered the saved `tmdb-apply-plan.json` referenced stale pre-incident Series UUIDs (the re-import generates fresh ones). Built a title-based remap tool (`tmdb-enrichment/remap-apply-plan.ts` + `run-remap-apply-plan.ts`, 6 tests) that rewrites only `mytvSeriesId`, never touching any matching decision. Remapped all 184 candidates cleanly (0 unmatched, 0 ambiguous), dry-ran, then applied for real.
5. **Step A verification** (this session): re-confirmed all Step 2 numbers, plus `/series/:id` for Frieren.
6. **Step B — next-episode backfill**: dry-run showed exactly 7 rows moving `CAUGHT_UP → WATCHING` (the 5 confirmed-caught-up series + Kaiju No. 8 + Rurouni Kenshin) — matched the expected pattern exactly, so applied for real.
7. **Step C — Watch Next manual decisions**: discovered the same UUID-staleness problem in `watch-next-decisions.json` (both `mytvSeriesId` and `reviewedNextEpisodeId`). Built a second remap tool (`watch-next-review/remap-decisions.ts` + `run-remap-decisions.ts`, 7 tests) that remaps series by title and episode by (title, season, episode number) using the original review file's captured position — again, no new decision, only identity remapping. Dry-ran (all 5 `mark_caught_up` rows showed `would_apply`, confirming the rebuilt state matched exactly what was reviewed pre-incident), then applied for real.
8. **Step D — seed safety hardening**: rewrote `prisma/seed.ts` to be permanently safe (upserts the dev user only, never deletes). Moved all destructive logic to `prisma/seed-demo.ts`, reachable only via a new, separately-named `npm run seed:demo:destructive` command — never wired into `npx prisma db seed` or Prisma's `migrate dev` auto-seed trigger. Added `docs/dev-database-safety.md` and updated `README.md`.
9. **Step E — final verification and this report.**

## 2. Final database counts

| Table | Count |
|---|---|
| User | 1 |
| Series | 430 |
| Season | 1,083 |
| Episode | 19,132 |
| EpisodeWatch | 18,913 |
| WatchlistItem | 23 |
| UserSeriesProgress | 393 |
| ExternalIds | 184 |
| EpisodeNote | 0 |
| EpisodeRating | 0 |
| EpisodeEmotion | 0 |

Note: Episode/Season counts (19,132 / 1,083) are slightly higher than right after the raw import (18,913 / ~1,071) — TMDb enrichment adds each enriched series' full known episode catalog, including unwatched episodes and a small number of placeholder entries TMDb itself has no title/airDate for yet (these are the ~219 episodes not counted in the "5,188 with title" figure below). This is expected enrichment behavior, not a discrepancy.

## 3. Enrichment counts

| Field | Count |
|---|---|
| ExternalIds.tmdbId | 184 |
| Series.posterUrl | 184 |
| Series.backdropUrl | 184 |
| Episode.title | 5,188 |
| Episode.airDate | 5,188 |
| Episode.imageUrl | 5,177 (11 missing stills — normal TMDb gaps) |

## 4. Status distributions

**userStatus** (393 total):

| Status | Count |
|---|---|
| WATCHING | 154 |
| COMPLETED | 148 |
| DROPPED | 54 |
| CAUGHT_UP | 34 |
| WATCHLIST | 3 |

**releaseStatus** (430 total):

| Status | Count |
|---|---|
| UNKNOWN | 246 (unenriched) |
| ENDED | 140 |
| RETURNING | 34 |
| CANCELLED | 8 |
| IN_PRODUCTION | 2 |

## 5. Final `/me/watch-next`

2 items:
- **Kaiju No. 8** (`WATCHING`, next episode still pending — TVmaze's own catalog also has no real data for what comes next, per the earlier audit)
- **Rurouni Kenshin** (`WATCHING`, flagged `POSSIBLE_REMAKE_COLLISION` — multiple adaptations exist; TMDb match itself should be manually confirmed)

The 5 confirmed-caught-up series (Frieren, DAN DA DAN, Shangri-La Frontier, Tokyo Revengers, Sket Dance) are `CAUGHT_UP` with `nextEpisodeId = null`, correctly absent from Watch Next.

## 6. Mock/demo series confirmed absent

`The Great Voyage`, `Old Town Mysteries`, `Quantum Kitchen`, `Signal & Noise` — **0 rows**, verified directly against the database.

## 7. Seed script safety

- `npm run prisma:seed` (`npx prisma db seed`, also auto-triggered by `prisma migrate dev`) is now **permanently safe** — it only upserts the dev user row, never deletes anything.
- All destructive logic lives in `prisma/seed-demo.ts`, reachable only via `npm run seed:demo:destructive` — never through Prisma's own seed-trigger mechanism.
- That script refuses to run unless **both** `ALLOW_DESTRUCTIVE_SEED=true` is set **and** no real-data signal exists (any `ImportBatch` row, or any `importBatchId`-tagged `Series`/`Episode`/`EpisodeWatch` row) — the real-data check is unconditional and cannot be bypassed by the flag alone.
- Guard logic (`prisma/seed-guard.ts`) is pure and unit-tested (6 tests), shared by every entrypoint.
- Documented in `docs/dev-database-safety.md` (includes the incident narrative) and `README.md`.

## 8. Remaining known gaps

- `EpisodeNote`/`EpisodeRating`/`EpisodeEmotion` are still 0 — the current `import-tvtime` importer version only normalizes `tracking-prod-records-v2.csv` (watches + watchlist); ratings/emotions/notes raw rows are preserved in `ImportRawRow` for a future normalization pass. Not a regression — this was already true before the incident.
- **Kaiju No. 8** and **Rurouni Kenshin** remain in Watch Next needing manual mapping/review (TBA placeholder next-episode data and a remake-collision risk, respectively).
- Broader manual review for the anime-numbering, specials-mismatch, and remake-collision categories surfaced by the earlier TVmaze secondary-provider audit remains future work — untouched this session.

## 9. Exact commands used

```bash
# Step 1 — TV Time re-import
npx ts-node import-tvtime/run.ts --dry-run
npx ts-node import-tvtime/run.ts

# Step 2 — TMDb enrichment replay
npx ts-node tmdb-enrichment/run-remap-apply-plan.ts --plan=tmdb-enrichment/output/1e1e7d41-226d-48f3-a339-6cce798c8586/tmdb-apply-plan.json
npx ts-node tmdb-enrichment/run-apply-plan.ts --plan=tmdb-enrichment/output/1e1e7d41-226d-48f3-a339-6cce798c8586/tmdb-apply-plan-remapped.json
npx ts-node tmdb-enrichment/run-apply-plan.ts --plan=tmdb-enrichment/output/1e1e7d41-226d-48f3-a339-6cce798c8586/tmdb-apply-plan-remapped.json --apply

# Step B — next-episode backfill
npm run next-episode:backfill
npm run next-episode:backfill -- --apply

# Step C — Watch Next manual decisions
npx ts-node watch-next-review/run-remap-decisions.ts
npx ts-node watch-next-review/run-apply-decisions.ts --decisions=watch-next-review/output/watch-next-decisions-remapped.json
npx ts-node watch-next-review/run-apply-decisions.ts --decisions=watch-next-review/output/watch-next-decisions-remapped.json --apply

# Step E — verification
npx tsc --noEmit
npm run build
npm test
```

## 10. Files changed this session

**New**:
- `docs/dev-database-safety.md`
- `prisma/seed-demo.ts`, `prisma/seed-guard.ts`, `prisma/__tests__/seed-guard.test.ts`
- `tmdb-enrichment/remap-apply-plan.ts`, `tmdb-enrichment/run-remap-apply-plan.ts`, `tmdb-enrichment/__tests__/remap-apply-plan.test.ts`
- `watch-next-review/remap-decisions.ts`, `watch-next-review/run-remap-decisions.ts`, `watch-next-review/__tests__/remap-decisions.test.ts`
- `secondary-provider-audit/`, `watch-next-audit/`, `watch-next-review/` (broader TVmaze-audit and Watch Next review tooling from earlier this session)
- `src/common/is-episode-released.ts`, `src/common/__tests__/is-episode-released.test.ts`, `src/modules/me/me-query-helpers.ts`, `src/modules/me/__tests__/`
- `db-backups/mytv-broken-state-20260705T001811.dump` (gitignored, kept on disk)

**Modified**:
- `prisma/seed.ts` (rewritten to be safe-by-default)
- `package.json` (added `seed:demo:destructive` script)
- `README.md` (seed data section updated)
- `src/modules/me/me.service.ts`, `src/modules/series/series-query-helpers.ts`, `src/modules/series/series.service.ts`, `src/modules/episodes/episode-watch.service.ts`, `next-episode-backfill/derive-next-episode.ts`, `next-episode-backfill/run-backfill.ts` (Watch Next future-episode fix, from earlier this session)

**Not committed yet** — everything above is in the working tree; only the initial seed-guard version (`95619ce`) was committed proactively when explicitly requested. The rest awaits your review before committing.
