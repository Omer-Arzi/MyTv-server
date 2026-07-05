// Entrypoint for `npx prisma db seed` (see package.json's "prisma.seed"
// config). Prisma's CLI auto-runs this after `prisma migrate dev` — so
// this file must be safe to run at ANY time, against ANY database,
// including a fully-populated real one, with zero opt-in required.
//
// It does exactly one thing: ensures the dev user row exists (upsert, never
// delete). Nothing else. It never touches Series/Season/Episode/
// EpisodeWatch/UserSeriesProgress/WatchlistItem/ExternalIds.
//
// The destructive demo-data seed lives entirely separately in
// prisma/seed-demo.ts, run only via its own explicit `npm run
// seed:demo:destructive` command — never wired into `prisma db seed` or
// `prisma migrate dev`'s auto-trigger, and self-guarded on top of that
// (see seed-guard.ts). This split exists because of a real incident
// (2026-07-04) where an unconditional wipe-and-reseed in this exact file
// destroyed a real, TV-Time-imported database. See
// docs/dev-database-safety.md for the full picture.

import { PrismaClient } from '@prisma/client';
import { DEV_USER_DISPLAY_NAME, DEV_USER_EMAIL, DEV_USER_ID } from '../src/common/constants';

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { id: DEV_USER_ID },
    create: { id: DEV_USER_ID, email: DEV_USER_EMAIL, displayName: DEV_USER_DISPLAY_NAME },
    update: {},
  });
  console.log(`Dev user ensured: ${user.email} (${user.id}). No other data was touched.`);
  console.log('For demo/fixture data on an empty database, run: npm run seed:demo:destructive');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
