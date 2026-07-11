// Provider Confirmation Pipeline — the single, repeatable command that
// takes the whole provider-confirmation workflow from "research" to
// "operational": reads the human-maintained decisions file
// (provider-confirmation-decisions.json), classifies every confirmed
// decision fresh (same pipeline as library-health:provider-confirmation-dry-run:
// title/year sanity, compareSeriesCatalog, season-zero-orphan check,
// split-episode-tail check), and — in apply mode — automatically applies
// every classification this task defines as safe:
//   SAFE_TO_APPLY_LATER, SAFE_WITH_LOCAL_SPECIAL_ORPHAN, SAFE_WITH_SPLIT_EPISODE_TAIL
// (see apply-confirmed-provider-logic.ts's SAFE_APPLY_CLASSIFICATIONS —
// the one and only place that list is defined; nothing else in this
// script decides what's safe).
//
// What this pipeline deliberately does NOT do: it never invents a
// provider identity for a series that has no confirmed decision yet.
// Identity confirmation (which candidate is actually the right show) stays
// a human-owned step via provider-confirmation-decisions.json — that's a
// hard safety boundary, not a missing feature. Local series with no
// "confirm" decision are surfaced in the report's
// nextManualReviewCandidates list, to be investigated separately via
// library-health:missing-provider-candidates and
// library-health:provider-confirmation, then added to the decisions file
// by a human. See docs/library-health-provider-confirmation-runbook.md.
//
// Every classification that is NOT in the safe list — BLOCKED_RISK,
// NEEDS_MANUAL_REVIEW, PROVIDER_NOT_FOUND, LOCAL_SERIES_NOT_FOUND — is
// skipped, never written, and reported under skippedBlockedSeries.
// decision === 'defer' or 'skip' entries are never even classified against
// a provider; they're reported under skippedDeferredSeries.
//
// Apply-mode guarantees (identical in spirit to
// run-apply-provider-confirmation-friends.ts, generalized to any confirmed
// series): never deletes an Episode or EpisodeWatch row, never overwrites
// EpisodeWatch.watchedAt, never touches a series with no confirmed safe
// classification, only backfills episode metadata for
// (seasonNumber, episodeNumber) pairs that exist on both sides, and always
// reports every orphan/tail episode it intentionally left untouched. Each
// series applies in its own transaction — one series failing never rolls
// back or blocks another.
//
// Default mode is DRY RUN. Apply mode requires the explicit
// --apply-safe-confirmed flag.

import 'dotenv/config';
import path from 'path';
import { readFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { TmdbClient } from '../tmdb-enrichment/tmdb-client';
import { TvMazeClient } from '../secondary-provider-audit/tvmaze-client';
import { loadSeriesHealthInputs } from './load-series-health-inputs';
import { ProviderConfirmationDecision } from './provider-confirmation-decisions-logic';
import { loadDecisionsFromDb } from './provider-identity-decisions-store';
import { runProviderConfirmationForDecision } from './run-provider-confirmation-for-decision';
import { buildBatchManifest } from './batch-manifest-logic';
import { buildBatchManifestMarkdown, writeBatchManifest } from './batch-manifest-reports';
import {
  buildProviderConfirmationPipelineMarkdownReport,
  buildProviderConfirmationPipelineReport,
  PipelineAlreadyAppliedSeriesEntry,
  PipelineAppliedSeriesEntry,
  PipelineDryRunSafeEntry,
  PipelineErrorEntry,
  PipelineManualReviewCandidate,
  PipelineSkippedSeriesEntry,
  writeProviderConfirmationPipelineReports,
} from './provider-confirmation-pipeline-reports';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');
const DEFAULT_MAX_SEASON_ZERO_ORPHANS = 1;
const APPLY_FLAG = '--apply-safe-confirmed';
const APPLY_AUTO_SAFE_MIGRATIONS_FLAG = '--apply-auto-safe-migrations';

interface CliOptions {
  userId: string;
  outDir: string;
  // Null (the default) means "read the live ProviderIdentityDecision DB
  // table" — see provider-identity-decisions-store.ts, the same table the
  // in-app Migration Workbench reads/writes. Only set when --decisions=
  // is passed explicitly, for one-off testing against a filtered/ad hoc
  // JSON file (e.g. a batch-N split) without touching the live DB decisions.
  decisionsPath: string | null;
  maxSeasonZeroOrphans: number;
  apply: boolean;
  // Modifier, not a standalone trigger — only takes effect when `apply` is
  // also true. Expands what gets written beyond the existing safe-confirmed
  // set to also include titles the new objective auto-migration policy
  // (migration-policy-logic.ts) finds eligible without an explicit
  // migrationIntent flag. Kept separate from APPLY_FLAG so rollout can
  // stay staged: existing --apply-safe-confirmed behavior is byte-for-byte
  // unchanged unless this is also passed.
  applyAutoSafeMigrations: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('--apply') && !argv.includes(APPLY_FLAG)) {
    console.log(`Note: bare --apply is not the trigger for this script. Re-run with ${APPLY_FLAG} to actually write. Continuing as dry-run.`);
  }

  const options: CliOptions = {
    userId: DEV_USER_ID,
    outDir: DEFAULT_OUT_DIR,
    decisionsPath: null,
    maxSeasonZeroOrphans: DEFAULT_MAX_SEASON_ZERO_ORPHANS,
    apply: argv.includes(APPLY_FLAG),
    applyAutoSafeMigrations: argv.includes(APPLY_AUTO_SAFE_MIGRATIONS_FLAG),
  };
  for (const arg of argv) {
    if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
    else if (arg.startsWith('--decisions=')) options.decisionsPath = path.resolve(arg.slice('--decisions='.length));
    else if (arg.startsWith('--max-season-zero-orphans=')) options.maxSeasonZeroOrphans = Number(arg.slice('--max-season-zero-orphans='.length));
  }
  return options;
}

function loadDecisionsFromJsonFile(decisionsPath: string): ProviderConfirmationDecision[] {
  const raw = JSON.parse(readFileSync(decisionsPath, 'utf-8'));
  if (!Array.isArray(raw)) throw new Error(`decisions file ${decisionsPath} must contain a JSON array`);
  for (const entry of raw) {
    if (typeof entry.title !== 'string' || !entry.title) throw new Error(`decisions file entry missing a string "title": ${JSON.stringify(entry)}`);
    if (!['confirm', 'skip', 'defer'].includes(entry.decision)) throw new Error(`decisions file entry for "${entry.title}" has an unsupported "decision": ${entry.decision}`);
    if (entry.provider !== undefined && !['tmdb', 'tvmaze'].includes(entry.provider)) throw new Error(`decisions file entry for "${entry.title}" has an unsupported "provider": ${entry.provider}`);
  }
  return raw as ProviderConfirmationDecision[];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const accessToken = process.env.TMDB_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('Missing TMDB_ACCESS_TOKEN — set it in .env (see .env.example). No request is made without it.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const tmdb = new TmdbClient({ accessToken });
  const tvmaze = new TvMazeClient();
  const generatedAt = new Date();

  console.log(`Provider Confirmation Pipeline — mode: ${options.apply ? 'APPLY (writes will happen for safe classifications)' : 'DRY RUN (no writes)'}`);
  console.log(`  target user: ${options.userId}`);
  console.log(`  decisions source: ${options.decisionsPath ?? 'ProviderIdentityDecision DB table (live)'}`);

  const decisions = options.decisionsPath ? loadDecisionsFromJsonFile(options.decisionsPath) : await loadDecisionsFromDb(prisma, options.userId);
  console.log(`  decisions loaded: ${decisions.length}`);

  const healthInputs = await loadSeriesHealthInputs(prisma, options.userId);

  const appliedSeries: PipelineAppliedSeriesEntry[] = [];
  const dryRunSafeSeries: PipelineDryRunSafeEntry[] = [];
  const alreadyAppliedSeries: PipelineAlreadyAppliedSeriesEntry[] = [];
  const skippedBlockedSeries: PipelineSkippedSeriesEntry[] = [];
  const skippedDeferredSeries: PipelineSkippedSeriesEntry[] = [];
  const errors: PipelineErrorEntry[] = [];
  const nextManualReviewCandidates: PipelineManualReviewCandidate[] = [];

  for (const decision of decisions) {
    const outcome = await runProviderConfirmationForDecision({
      prisma,
      tmdb,
      tvmaze,
      decision,
      healthInputs,
      userId: options.userId,
      generatedAt,
      apply: options.apply,
      applyAutoSafeMigrations: options.applyAutoSafeMigrations,
      maxSeasonZeroOrphans: options.maxSeasonZeroOrphans,
    });

    switch (outcome.kind) {
      case 'deferred':
        skippedDeferredSeries.push(outcome.entry);
        console.log(`  [${decision.decision.toUpperCase()}] ${decision.title}`);
        break;
      case 'local-not-found':
        skippedBlockedSeries.push(outcome.entry);
        console.log(`  [LOCAL_SERIES_NOT_FOUND] ${decision.title}`);
        break;
      case 'missing-provider-fields':
        skippedBlockedSeries.push(outcome.entry);
        console.log(`  [BLOCKED_RISK] ${decision.title} — missing provider/providerId`);
        break;
      case 'blocked':
        skippedBlockedSeries.push(outcome.entry);
        console.log(`  [${outcome.entry.classification}] ${decision.title} — ${outcome.entry.reason}`);
        if (outcome.nextManualReviewCandidate) nextManualReviewCandidates.push(outcome.nextManualReviewCandidate);
        break;
      case 'already-applied':
        alreadyAppliedSeries.push(outcome.entry);
        console.log(`  [ALREADY_APPLIED] ${decision.title} — ExternalIds already matches, nothing new to write.`);
        break;
      case 'dry-run-safe':
        dryRunSafeSeries.push(outcome.entry);
        console.log(
          `  [${outcome.entry.classification}] ${decision.title} (${outcome.entry.provider}:${outcome.entry.providerId})${outcome.entry.migrationClassification ? ` [migration: ${outcome.entry.migrationClassification}]` : ''}${outcome.entry.viaAutoMigrationPolicy ? ' [auto-migrate eligible]' : ''}`,
        );
        break;
      case 'applied':
        appliedSeries.push(outcome.entry);
        console.log(
          `  [${outcome.entry.classification}] ${decision.title} (${outcome.entry.provider}:${outcome.entry.providerId})${outcome.entry.migrationClassification ? ` [migration: ${outcome.entry.migrationClassification}]` : ''}${outcome.entry.viaAutoMigrationPolicy ? ' [auto-migrate eligible]' : ''}`,
        );
        if (outcome.entry.verification.failedChecks.length > 0) {
          console.error(`  [VERIFICATION FAILED] ${decision.title}:`);
          for (const f of outcome.entry.verification.failedChecks) console.error(`    - ${f}`);
        }
        break;
      case 'error':
        errors.push(outcome.entry);
        console.log(`  [ERROR] ${decision.title} — ${outcome.entry.message}`);
        if (outcome.nextManualReviewCandidate) nextManualReviewCandidates.push(outcome.nextManualReviewCandidate);
        break;
    }
  }

  // --- Local series with no confirmed decision at all — the discovery
  // pipeline's job, never this script's. --------------------------------
  const confirmedTitles = new Set(decisions.filter((d) => d.decision === 'confirm').map((d) => d.title));
  const decidedTitles = new Set(decisions.map((d) => d.title));
  for (const series of healthInputs) {
    if (series.externalIds?.provider && series.externalIds?.providerId) continue; // already has a confirmed match
    if (confirmedTitles.has(series.title)) continue; // confirmed but handled above (e.g. failed/blocked already listed)
    if (decidedTitles.has(series.title)) continue; // already deferred/skipped by a human — not a NEW candidate
    nextManualReviewCandidates.push({ title: series.title, seriesId: series.seriesId, reason: 'no confirmed provider match and no decisions-file entry at all.' });
  }

  const report = buildProviderConfirmationPipelineReport({
    generatedAt,
    mode: options.apply ? 'apply' : 'dry-run',
    targetUserId: options.userId,
    decisionsFilePath: options.decisionsPath ?? 'db:ProviderIdentityDecision',
    appliedSeries,
    dryRunSafeSeries,
    alreadyAppliedSeries,
    skippedBlockedSeries,
    skippedDeferredSeries,
    errors,
    nextManualReviewCandidates,
  });
  const markdown = buildProviderConfirmationPipelineMarkdownReport(report);
  const written = writeProviderConfirmationPipelineReports(options.outDir, report, markdown);

  console.log(`\nDone. Reports written:`);
  console.log(`  ${written.latestJsonPath}`);
  console.log(`  ${written.latestMarkdownPath}`);
  console.log(`  ${written.archivedJsonPath}`);
  console.log(`  ${written.archivedMarkdownPath}`);
  console.log('\nSummary:');
  console.log(JSON.stringify(report.summary, null, 2));

  // Always additionally build (and write) the batch manifest — Phase 6.
  // This NEVER writes to the database; it's a read-only projection of the
  // report above, restricted to the AUTO_MIGRATE subset, deterministically
  // ordered. Safe to compute on every run, apply or dry-run alike, since it
  // never gates or performs any write itself.
  const batchId = `library-health:provider-confirmation-pipeline:${generatedAt.toISOString()}`;
  const manifest = buildBatchManifest({ report, batchId, generatedAt });
  const manifestMarkdown = buildBatchManifestMarkdown(manifest);
  const writtenManifest = writeBatchManifest(options.outDir, manifest, manifestMarkdown);

  console.log(`\nBatch manifest written (proposed batch size: ${manifest.batchSize}):`);
  console.log(`  ${writtenManifest.latestJsonPath}`);
  console.log(`  ${writtenManifest.latestMarkdownPath}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
