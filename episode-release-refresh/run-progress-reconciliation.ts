// Progress reconciliation — system-wide audit + safe apply
// (docs/progress-reconciliation-architecture-todo.md Phase 6/7).
//
// Entirely local/offline — no TMDb call anywhere in this script, unlike
// run-refresh.ts/run-apply-refresh.ts. That's the point: this is the
// standalone, first-class "is UserSeriesProgress correct given what's
// already in the database" check, decoupled from any catalog-sync concern.
//
// Dry-run by default (no writes of any kind). Pass --apply to actually
// write — only for entries classified safe to auto-apply (a real mismatch,
// on a tracked non-protected series, not on the known risk list — see
// progress-reconciliation-logic.ts::checkAutoApplySafety). Anything
// ambiguous is reported but never written; --apply never touches it.
//
// Usage:
//   npx ts-node episode-release-refresh/run-progress-reconciliation.ts                    # dry run, full library
//   npx ts-node episode-release-refresh/run-progress-reconciliation.ts --series=<id>       # dry run, one series
//   npx ts-node episode-release-refresh/run-progress-reconciliation.ts --apply             # apply, full library
//   npx ts-node episode-release-refresh/run-progress-reconciliation.ts --apply --series=<id>

import 'dotenv/config';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { applyProgressReconciliation } from './apply-progress-reconciliation';
import { buildReconciliationEntry, loadReconciliationCandidates } from './local-release-activation';
import {
  AuditMismatchCategory,
  buildProgressReconciliationAuditReport,
  buildProgressReconciliationMarkdownReport,
  writeProgressReconciliationReports,
} from './progress-reconciliation-reports';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');
const APPLY_FLAG = '--apply';

interface CliOptions {
  userId: string;
  outDir: string;
  apply: boolean;
  series?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { userId: DEV_USER_ID, outDir: DEFAULT_OUT_DIR, apply: argv.includes(APPLY_FLAG) };
  for (const arg of argv) {
    if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
    else if (arg.startsWith('--series=')) options.series = arg.slice('--series='.length);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  const generatedAt = new Date();

  console.log(`Progress reconciliation — mode: ${options.apply ? 'APPLY (writes will happen for safe mismatches)' : 'DRY RUN (no writes)'}`);
  console.log(`  target user: ${options.userId}`);
  if (options.series) console.log(`  scoped to series: ${options.series}`);

  const candidates = await loadReconciliationCandidates(prisma, options.userId, options.series);
  console.log(`  rows inspected: ${candidates.length}`);

  const entries = candidates.map(buildReconciliationEntry);

  const applyErrors: { seriesId: string; seriesTitle: string; message: string }[] = [];
  if (options.apply) {
    for (const entry of entries) {
      if (!entry.safeToApply) continue;
      try {
        const result = await applyProgressReconciliation(prisma, { userId: options.userId, seriesId: entry.seriesId });
        entry.applied = result.progressRecomputed;
        if (result.progressRecomputed) {
          console.log(`  [APPLIED] ${entry.seriesTitle} — ${entry.storedUserStatus}/${entry.storedNextEpisodeId ?? 'null'} -> ${entry.computedUserStatus}/${entry.computedNextEpisodeId ?? 'null'}`);
        } else {
          console.log(`  [NO-OP AT WRITE TIME] ${entry.seriesTitle} — ${result.progressSkippedReason ?? result.writeSkippedReason}`);
        }
      } catch (err) {
        entry.applied = false;
        const message = (err as Error).message;
        applyErrors.push({ seriesId: entry.seriesId, seriesTitle: entry.seriesTitle, message });
        console.log(`  [ERROR] ${entry.seriesTitle} — ${message}`);
      }
    }
  } else {
    const skipCategories: AuditMismatchCategory[] = ['protected-manual-status-skipped', 'no-tmdb-id-skipped'];
    for (const entry of entries) {
      if (entry.category === 'no-mismatch') continue;
      const label = skipCategories.includes(entry.category)
        ? 'SKIPPED'
        : entry.safeToApply
          ? 'SAFE MISMATCH'
          : 'UNSAFE MISMATCH — MANUAL REVIEW';
      console.log(`  [${label}] ${entry.seriesTitle} — ${entry.category}: ${entry.storedUserStatus}/${entry.storedNextEpisodeId ?? 'null'} -> ${entry.computedUserStatus ?? '—'}/${entry.computedNextEpisodeId ?? '—'}`);
    }
  }

  const report = buildProgressReconciliationAuditReport({
    generatedAt,
    apply: options.apply,
    targetUserId: options.userId,
    onlySeriesId: options.series ?? null,
    entries,
    applyErrors,
  });
  const markdown = buildProgressReconciliationMarkdownReport(report);
  const paths = writeProgressReconciliationReports(options.outDir, report, markdown);

  console.log('');
  console.log(`Done. Safe mismatches: ${report.safeMismatchCount}, unsafe/manual-review: ${report.unsafeMismatchCount}${options.apply ? `, applied: ${report.appliedCount}` : ''}`);
  console.log(`  ${paths.latestJsonPath}`);
  console.log(`  ${paths.latestMarkdownPath}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
