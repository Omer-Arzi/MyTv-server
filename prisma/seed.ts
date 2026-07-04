// Entrypoint for `npx prisma db seed` (see package.json's "prisma.seed"
// config) — deliberately contains no destructive logic itself. The actual
// demo-data seed lives in seed-demo.ts, which is self-guarded (see
// seed-guard.ts) and refuses to run against a database holding real data or
// without ALLOW_DESTRUCTIVE_SEED=true explicitly set. This split exists
// because of a real incident (2026-07-04) where the old unconditional
// wipe-and-reseed here destroyed a real, TV-Time-imported database.
import './seed-demo';
