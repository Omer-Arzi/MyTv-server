// One-time backfill — Migration Workbench provider-decision persistence.
// Reads the historical library-health/provider-confirmation-decisions.json
// (the sole source of truth until now) and upserts every entry into the new
// ProviderIdentityDecision table (prisma/schema.prisma), scoped to
// DEV_USER_ID (the only real user this app has today). Idempotent — safe to
// re-run; each run upserts on (userId, seriesId), so re-running after
// editing the JSON file re-syncs the DB rather than duplicating rows.
//
// After this runs successfully, ProviderIdentityDecision is the LIVE
// decision source for both the CLI pipeline and the app — see
// library-health/run-provider-confirmation-pipeline.ts and
// src/modules/migration-workbench/migration-workbench.service.ts, both of
// which now read loadDecisionsFromDb() instead of the JSON file directly.
// The JSON file itself is left in place, untouched, as a historical
// artifact/compatibility fallback — never deleted by this script.

import 'dotenv/config';
import path from 'path';
import { readFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { ProviderConfirmationDecision } from './provider-confirmation-decisions-logic';

const DECISIONS_PATH = path.join(__dirname, 'provider-confirmation-decisions.json');

function loadJsonDecisions(): ProviderConfirmationDecision[] {
  const raw = JSON.parse(readFileSync(DECISIONS_PATH, 'utf-8'));
  if (!Array.isArray(raw)) throw new Error(`decisions file ${DECISIONS_PATH} must contain a JSON array`);
  return raw as ProviderConfirmationDecision[];
}

async function main() {
  const prisma = new PrismaClient();
  const userId = process.argv.find((a) => a.startsWith('--user='))?.slice('--user='.length) ?? DEV_USER_ID;

  const decisions = loadJsonDecisions();
  console.log(`Loaded ${decisions.length} decisions from ${DECISIONS_PATH}`);

  let matched = 0;
  let skippedNoLocalSeries = 0;
  let upserted = 0;

  for (const decision of decisions) {
    const series = await prisma.series.findFirst({ where: { title: decision.title } });
    if (!series) {
      skippedNoLocalSeries += 1;
      console.log(`  [SKIP — no local series] ${decision.title}`);
      continue;
    }
    matched += 1;

    await prisma.providerIdentityDecision.upsert({
      where: { userId_seriesId: { userId, seriesId: series.id } },
      create: {
        userId,
        seriesId: series.id,
        decision: decision.decision,
        provider: decision.provider ?? null,
        providerId: decision.providerId !== undefined ? String(decision.providerId) : null,
        migrationIntent: decision.migrationIntent === true,
        statusOverride: decision.statusOverride ?? null,
        notes: decision.notes ?? null,
        source: 'cli-decisions-file',
      },
      update: {
        decision: decision.decision,
        provider: decision.provider ?? null,
        providerId: decision.providerId !== undefined ? String(decision.providerId) : null,
        migrationIntent: decision.migrationIntent === true,
        statusOverride: decision.statusOverride ?? null,
        notes: decision.notes ?? null,
        // Never overwrite source on a re-run — a decision made via the app
        // (source: 'app-confirmation') must never be silently reclassified
        // back to 'cli-decisions-file' just because the JSON file happens
        // to also list that title.
      },
    });
    upserted += 1;
    console.log(`  [OK] ${decision.title} (${decision.decision})`);
  }

  console.log(`\nDone. ${upserted} upserted, ${matched} matched a local series, ${skippedNoLocalSeries} skipped (no local series found).`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
