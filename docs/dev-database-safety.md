# Dev database safety

## The incident this doc exists because of

On 2026-07-04, `prisma/seed.ts` — at the time, an unconditional
wipe-and-reseed (`deleteMany()` on every app table, then insert a handful of
synthetic demo rows) — ran against a database holding real, TV-Time-imported
data (430 series, ~18,900 episode watches, TMDb enrichment, months of watch
history). It was the configured `npx prisma db seed` entrypoint, and got
triggered by an ordinary verification command. Every real row was deleted
with no backup. Recovering it required re-running the TV Time importer from
source CSVs, replaying a saved TMDb enrichment plan, and re-running the
next-episode backfill — hours of work that a guard would have prevented in
seconds.

This doc — and the guard it describes — exists so that can't happen again.

## Which command is safe, which is destructive

| Command | What it does | Safe against real data? |
|---|---|---|
| `npm run prisma:seed` (= `npx prisma db seed`) | Upserts the dev user row. Nothing else. Never deletes anything. | **Yes, always.** Safe to run against any database at any time. |
| `npm run seed:demo:destructive` | Wipes `Series`/`Season`/`Episode`/`EpisodeWatch`/`EpisodeNote`/`UserSeriesProgress`/`WatchlistItem`/`ExternalIds`/`User`, then inserts synthetic demo series (`Quantum Kitchen`, `Signal & Noise`). | **No.** Refuses unless both conditions below are met. |

`npm run prisma:migrate` (`prisma migrate dev`) auto-triggers whatever
`npx prisma db seed` runs, per Prisma's own CLI behavior. Because
`prisma/seed.ts` is now always the safe, non-destructive path, running
migrations can never accidentally trigger a wipe — there's no destructive
code left in that chain to trigger.

## How the guard works

`npm run seed:demo:destructive` (`prisma/seed-demo.ts`) refuses to do
anything unless **both**:

1. **No real-data signal is present.** Checked via `prisma/seed-guard.ts`'s
   `evaluateSeedSafety()`: any row at all in `ImportBatch` (only ever created
   by a real import/enrichment/backfill script), or any `Series`/`Episode`/
   `EpisodeWatch` row carrying a non-null `importBatchId`, blocks the run —
   **unconditionally, regardless of the flag below.**
2. **`ALLOW_DESTRUCTIVE_SEED=true`** is set in the environment.

Both checks live in one pure, unit-tested function
(`prisma/__tests__/seed-guard.test.ts`) shared by every entrypoint, so there
is no code path that can independently decide "safe" differently.

## How to seed a fresh demo database on purpose

```bash
ALLOW_DESTRUCTIVE_SEED=true npm run seed:demo:destructive
```

Only do this against a database you're certain has no real imported data —
the guard will refuse otherwise. If you actually need to wipe a database
that currently holds real data (e.g. resetting a scratch/throwaway dev
environment on purpose), export the real data first if it's worth keeping —
there is no seed-script escape hatch for that, by design.

## If you're touching `prisma/seed.ts` or `prisma/seed-demo.ts` again

- `prisma/seed.ts` must never regain a `deleteMany`/destructive call. If a
  future feature genuinely needs `npx prisma db seed` to do more, keep it
  strictly additive (upserts), never destructive.
- Any new destructive script (seed-related or not) that could plausibly run
  against a populated database should route through `evaluateSeedSafety` (or
  an equivalent guard), not trust its caller.
