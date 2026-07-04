// Pure decision logic for whether it's safe to run the destructive demo
// seed. No I/O — testable without a database. Lives in its own file so both
// seed.ts (the `npx prisma db seed` entrypoint) and seed-demo.ts (the actual
// destructive logic, also runnable directly) share the exact same rule and
// can never independently drift on what "safe" means.
//
// Exists because of a real incident (2026-07-04): a seed script that wiped
// all app tables unconditionally ran against a database holding real
// TV-Time-imported data, destroying it with no backup. This is the fix:
// the destructive path now refuses to run at all unless BOTH (a) no
// real-data signal is present, AND (b) the operator explicitly opted in.

export interface SeedSafetyInput {
  allowDestructiveFlagSet: boolean;
  // Any row at all in ImportBatch means some real import/enrichment pipeline
  // has run against this database — those pipelines are the only code in
  // this repo that ever creates one.
  importBatchCount: number;
  // Any Series/Episode/EpisodeWatch/etc. row carrying a non-null
  // importBatchId is real imported data, even if the ImportBatch row itself
  // was somehow since removed — a second, independent signal.
  taggedRowCount: number;
}

export interface SeedSafetyResult {
  safe: boolean;
  reason: string;
}

export function evaluateSeedSafety(input: SeedSafetyInput): SeedSafetyResult {
  // Checked first and unconditionally — real-data presence blocks the run
  // even if ALLOW_DESTRUCTIVE_SEED is set. The flag means "I intend to wipe
  // a demo/empty database," never "delete real data anyway."
  if (input.importBatchCount > 0 || input.taggedRowCount > 0) {
    return {
      safe: false,
      reason:
        `Refusing to run: this database contains real imported data ` +
        `(${input.importBatchCount} ImportBatch row(s), ${input.taggedRowCount} row(s) tagged with an importBatchId). ` +
        `This destructive demo seed must never run against a database with real data, regardless of ALLOW_DESTRUCTIVE_SEED.`,
    };
  }

  if (!input.allowDestructiveFlagSet) {
    return {
      safe: false,
      reason:
        'Refusing to run: ALLOW_DESTRUCTIVE_SEED is not set to "true". This script deletes all Series/Season/Episode/' +
        'EpisodeWatch/EpisodeNote/UserSeriesProgress/WatchlistItem/ExternalIds/User data before reseeding demo data. ' +
        'Set ALLOW_DESTRUCTIVE_SEED=true to run it intentionally against an empty/demo database.',
    };
  }

  return { safe: true, reason: 'No real-data signals found and ALLOW_DESTRUCTIVE_SEED=true — safe to proceed.' };
}
