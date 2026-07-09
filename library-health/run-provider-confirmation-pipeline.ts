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
import { PrismaClient, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { MAX_APPEND_TO_RESPONSE_ITEMS, TmdbClient, TmdbRequestError } from '../tmdb-enrichment/tmdb-client';
import { getAppendedSeason } from '../tmdb-enrichment/tmdb-types';
import { mapTmdbStatusToReleaseStatus } from '../tmdb-enrichment/release-status-mapping';
import { tmdbImageUrl } from '../tmdb-enrichment/apply-plan-writes';
import { decideUserStatusUpdate } from '../tmdb-enrichment/apply-plan-writes';
import { TvMazeClient, TvMazeRequestError } from '../secondary-provider-audit/tvmaze-client';
import { chunkArray, compareSeriesCatalog, LocalEpisodeInput, ProviderEpisodeInput } from '../episode-release-refresh/refresh-logic';
import { buildSeasonShape } from '../tmdb-enrichment/season-structure-tiebreak';
import { loadSeriesHealthInputs } from './load-series-health-inputs';
import { checkTitleYearSanity, classifyProviderConfirmationDryRun, ProviderConfirmationDecision } from './provider-confirmation-decisions-logic';
import { checkBenignSeasonZeroOrphan, detectRealSeasonShrink, findOrphanedWatchedEpisodes } from './season-zero-orphan-logic';
import { checkSplitEpisodeTailOnly } from './split-episode-tail-logic';
import { buildConfirmedSeriesApplyPlan, ExternalIdsUpdate, isSafeApplyClassification, resolvePreservedOrphanEpisodes } from './apply-confirmed-provider-logic';
import { buildMigrationApplyPlan, classifyMigrationConfirmation, isProtectedMigrationStatus } from './migration-confirmation-logic';
import { EpisodeUpdatePlan, LocalEpisodeForApply, ProviderEpisodeForApply } from './apply-friends-tvmaze-logic';
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
const DEFAULT_DECISIONS_PATH = path.join(__dirname, 'provider-confirmation-decisions.json');
const DEFAULT_MAX_SEASON_ZERO_ORPHANS = 1;
const APPLY_FLAG = '--apply-safe-confirmed';

interface CliOptions {
  userId: string;
  outDir: string;
  decisionsPath: string;
  maxSeasonZeroOrphans: number;
  apply: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('--apply') && !argv.includes(APPLY_FLAG)) {
    console.log(`Note: bare --apply is not the trigger for this script. Re-run with ${APPLY_FLAG} to actually write. Continuing as dry-run.`);
  }

  const options: CliOptions = {
    userId: DEV_USER_ID,
    outDir: DEFAULT_OUT_DIR,
    decisionsPath: DEFAULT_DECISIONS_PATH,
    maxSeasonZeroOrphans: DEFAULT_MAX_SEASON_ZERO_ORPHANS,
    apply: argv.includes(APPLY_FLAG),
  };
  for (const arg of argv) {
    if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
    else if (arg.startsWith('--decisions=')) options.decisionsPath = path.resolve(arg.slice('--decisions='.length));
    else if (arg.startsWith('--max-season-zero-orphans=')) options.maxSeasonZeroOrphans = Number(arg.slice('--max-season-zero-orphans='.length));
  }
  return options;
}

function loadDecisions(decisionsPath: string): ProviderConfirmationDecision[] {
  const raw = JSON.parse(readFileSync(decisionsPath, 'utf-8'));
  if (!Array.isArray(raw)) throw new Error(`decisions file ${decisionsPath} must contain a JSON array`);
  for (const entry of raw) {
    if (typeof entry.title !== 'string' || !entry.title) throw new Error(`decisions file entry missing a string "title": ${JSON.stringify(entry)}`);
    if (!['confirm', 'skip', 'defer'].includes(entry.decision)) throw new Error(`decisions file entry for "${entry.title}" has an unsupported "decision": ${entry.decision}`);
    if (entry.provider !== undefined && !['tmdb', 'tvmaze'].includes(entry.provider)) throw new Error(`decisions file entry for "${entry.title}" has an unsupported "provider": ${entry.provider}`);
  }
  return raw as ProviderConfirmationDecision[];
}

async function loadFullLocalEpisodes(prisma: PrismaClient, userId: string, seriesId: string): Promise<LocalEpisodeInput[]> {
  const seasons = await prisma.season.findMany({
    where: { seriesId },
    select: {
      seasonNumber: true,
      episodes: {
        select: { id: true, episodeNumber: true, title: true, overview: true, airDate: true, imageUrl: true, runtimeMinutes: true, watches: { where: { userId }, select: { id: true } } },
      },
    },
  });

  return seasons.flatMap((season) =>
    season.episodes.map((ep) => ({
      id: ep.id,
      seasonNumber: season.seasonNumber,
      episodeNumber: ep.episodeNumber,
      title: ep.title,
      overview: ep.overview,
      airDate: ep.airDate,
      imageUrl: ep.imageUrl,
      runtimeMinutes: ep.runtimeMinutes,
      watched: ep.watches.length > 0,
    })),
  );
}

interface ProviderFetchResult {
  candidateTitle: string;
  candidateYear: number | null;
  posterUrl: string | null;
  episodes: ProviderEpisodeInput[];
  releaseStatus: ReleaseStatus;
}

async function fetchTmdbCandidate(tmdb: TmdbClient, tmdbId: string, localSeasonNumbers: number[]): Promise<ProviderFetchResult> {
  const details = await tmdb.getShowDetails(tmdbId);
  const releaseStatus = mapTmdbStatusToReleaseStatus(details.status);
  const providerSeasonNumbers = Array.from({ length: details.number_of_seasons ?? 0 }, (_, i) => i + 1);
  const seasonNumbers = [...new Set([...localSeasonNumbers, ...providerSeasonNumbers])].sort((a, b) => a - b);

  const episodes: ProviderEpisodeInput[] = [];
  for (const batch of chunkArray(seasonNumbers, MAX_APPEND_TO_RESPONSE_ITEMS)) {
    const response = await tmdb.getSeasonsBatch(tmdbId, batch);
    for (const seasonNumber of batch) {
      const season = getAppendedSeason(response, seasonNumber);
      if (!season?.episodes) continue;
      for (const ep of season.episodes) {
        episodes.push({
          seasonNumber: ep.season_number,
          episodeNumber: ep.episode_number,
          title: ep.name ?? null,
          overview: ep.overview ?? null,
          airDate: ep.air_date ? new Date(ep.air_date) : null,
          imageUrl: tmdbImageUrl(ep.still_path),
          runtimeMinutes: null,
        });
      }
    }
  }

  return {
    candidateTitle: details.name,
    candidateYear: details.first_air_date ? Number(details.first_air_date.slice(0, 4)) : null,
    posterUrl: tmdbImageUrl(details.poster_path),
    episodes,
    releaseStatus,
  };
}

function mapTvmazeStatusToReleaseStatus(status: string | null): ReleaseStatus {
  if (!status) return ReleaseStatus.UNKNOWN;
  switch (status.toLowerCase()) {
    case 'running':
      return ReleaseStatus.RETURNING;
    case 'ended':
      return ReleaseStatus.ENDED;
    case 'to be determined':
    case 'in development':
      return ReleaseStatus.IN_PRODUCTION;
    default:
      return ReleaseStatus.UNKNOWN;
  }
}

async function fetchTvmazeCandidate(tvmaze: TvMazeClient, tvmazeId: string): Promise<ProviderFetchResult> {
  const show = await tvmaze.getShowWithEpisodes(tvmazeId);
  const rawEpisodes = show._embedded?.episodes ?? [];

  const episodes: ProviderEpisodeInput[] = rawEpisodes
    .filter((ep) => ep.number !== null)
    .map((ep) => ({
      seasonNumber: ep.season,
      episodeNumber: ep.number as number,
      title: ep.name ?? null,
      // TVmaze's summary is HTML — kept as-is here for compareSeriesCatalog's
      // plain field-change diffing; planEpisodeUpdate downstream (via
      // apply-friends-tvmaze-logic's stripHtml) is what actually strips it
      // before writing to the Episode.overview column, same as the Friends
      // apply script.
      overview: ep.summary ?? null,
      airDate: ep.airdate ? new Date(ep.airdate) : null,
      imageUrl: null,
      runtimeMinutes: ep.runtime ?? null,
    }));

  return {
    candidateTitle: show.name,
    candidateYear: show.premiered ? Number(show.premiered.slice(0, 4)) : null,
    posterUrl: show.image?.original ?? show.image?.medium ?? null,
    episodes,
    releaseStatus: mapTvmazeStatusToReleaseStatus(show.status),
  };
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
  console.log(`  decisions file: ${options.decisionsPath}`);

  const decisions = loadDecisions(options.decisionsPath);
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
    if (decision.decision !== 'confirm') {
      skippedDeferredSeries.push({
        title: decision.title,
        seriesId: null,
        classification: null,
        reason: `decision is "${decision.decision}" — not confirmed, never applied.`,
        migrationIntent: decision.migrationIntent === true,
        migrationClassification: null,
      });
      console.log(`  [${decision.decision.toUpperCase()}] ${decision.title}`);
      continue;
    }

    const local = healthInputs.find((s) => s.title === decision.title);
    if (!local) {
      skippedBlockedSeries.push({
        title: decision.title,
        seriesId: null,
        classification: 'LOCAL_SERIES_NOT_FOUND',
        reason: `no local series titled "${decision.title}" was found.`,
        migrationIntent: decision.migrationIntent === true,
        migrationClassification: null,
      });
      console.log(`  [LOCAL_SERIES_NOT_FOUND] ${decision.title}`);
      continue;
    }

    if (!decision.provider || decision.providerId === undefined) {
      skippedBlockedSeries.push({
        title: decision.title,
        seriesId: local.seriesId,
        classification: 'BLOCKED_RISK',
        reason: 'decision is "confirm" but is missing a "provider" and/or "providerId".',
        migrationIntent: decision.migrationIntent === true,
        migrationClassification: null,
      });
      console.log(`  [BLOCKED_RISK] ${decision.title} — missing provider/providerId`);
      continue;
    }

    const providerId = String(decision.providerId);
    const bySeason = new Map<number, number>();
    for (const ep of local.episodes) bySeason.set(ep.seasonNumber, (bySeason.get(ep.seasonNumber) ?? 0) + 1);
    const localSeasonNumbers = [...bySeason.keys()];

    try {
      const fetched =
        decision.provider === 'tmdb' ? await fetchTmdbCandidate(tmdb, providerId, localSeasonNumbers) : await fetchTvmazeCandidate(tvmaze, providerId);

      const sanity = checkTitleYearSanity({ localTitle: decision.title, candidateTitle: fetched.candidateTitle, candidateYear: fetched.candidateYear });
      const fullLocalEpisodes = await loadFullLocalEpisodes(prisma, options.userId, local.seriesId);
      const comparison = compareSeriesCatalog({
        localEpisodes: fullLocalEpisodes,
        providerEpisodes: fetched.episodes,
        currentReleaseStatus: local.releaseStatus,
        providerReleaseStatus: fetched.releaseStatus,
        currentUserStatus: local.progress?.userStatus ?? UserSeriesStatus.UNKNOWN,
        currentNextEpisodeId: local.progress?.nextEpisodeId ?? null,
        now: generatedAt,
      });

      const orphanedWatchedEpisodes = findOrphanedWatchedEpisodes(fullLocalEpisodes, fetched.episodes);
      const realSeasonShrinkDetected = detectRealSeasonShrink(fullLocalEpisodes, fetched.episodes);
      const seasonZeroOrphanCheck = checkBenignSeasonZeroOrphan({
        localTitle: decision.title,
        orphanedWatchedEpisodes,
        realSeasonShrinkDetected,
        maxOrphanCount: options.maxSeasonZeroOrphans,
      });
      const splitEpisodeTailCheck = checkSplitEpisodeTailOnly({
        localTitle: decision.title,
        localEpisodes: fullLocalEpisodes,
        providerEpisodes: fetched.episodes,
        orphanedWatchedEpisodes,
      });

      const decisionResult = classifyProviderConfirmationDryRun({ titleYearSanity: sanity, comparison, seasonZeroOrphanCheck, splitEpisodeTailCheck });

      // --- Migration mode: only ever reachable when a human has
      // explicitly set migrationIntent: true for this title (task
      // requirement 6). Every other title takes the exact code path it
      // always has, byte for byte. See migration-confirmation-logic.ts. --
      const migrationIntent = decision.migrationIntent === true;
      const migrationResult = migrationIntent
        ? classifyMigrationConfirmation({
            baseClassification: decisionResult.classification,
            baseReason: decisionResult.reason,
            titleYearSanityPassed: sanity.passed,
            orphanedWatchedEpisodes,
            currentUserStatus: local.progress?.userStatus ?? UserSeriesStatus.UNKNOWN,
            migration: { migrationIntent: true, statusOverride: decision.statusOverride },
          })
        : null;
      // migrationResult is only ever non-null when migrationIntent is
      // true, in which case classifyMigrationConfirmation's passthrough
      // branch is unreachable — its classification is always one of the
      // 3 MigrationClassification values here, never a bare
      // DryRunClassification. Safe to narrow for reporting.
      const migrationClassificationForReport = migrationResult ? (migrationResult.classification as 'SAFE_MIGRATION_WITH_PRESERVED_ORPHANS' | 'SAFE_MIGRATION_WITH_STATUS_OVERRIDE' | 'BLOCKED_DESTRUCTIVE_RISK') : null;
      const isMigrationSafe = migrationClassificationForReport === 'SAFE_MIGRATION_WITH_PRESERVED_ORPHANS' || migrationClassificationForReport === 'SAFE_MIGRATION_WITH_STATUS_OVERRIDE';
      const isBaseSafe = isSafeApplyClassification(decisionResult.classification);

      console.log(`  [${decisionResult.classification}] ${decision.title} (${decision.provider}:${providerId})${migrationResult ? ` [migration: ${migrationResult.classification}]` : ''}`);

      if (!isBaseSafe && !isMigrationSafe) {
        const reason = migrationResult ? migrationResult.reason : decisionResult.reason;
        skippedBlockedSeries.push({
          title: decision.title,
          seriesId: local.seriesId,
          classification: decisionResult.classification,
          reason,
          migrationIntent,
          migrationClassification: migrationClassificationForReport,
        });
        if (decisionResult.classification === 'BLOCKED_RISK' || decisionResult.classification === 'NEEDS_MANUAL_REVIEW' || migrationClassificationForReport === 'BLOCKED_DESTRUCTIVE_RISK') {
          nextManualReviewCandidates.push({ title: decision.title, seriesId: local.seriesId, reason: `classified ${migrationClassificationForReport ?? decisionResult.classification} — ${reason}` });
        }
        continue;
      }

      // --- Safe classification from here (either the ordinary pipeline or
      // migration mode): build the plan (always — this is the preview even
      // in dry-run mode). -----------------------------------------------
      const localEpisodesForApply: LocalEpisodeForApply[] = fullLocalEpisodes.map((e) => ({
        id: e.id,
        seasonNumber: e.seasonNumber,
        episodeNumber: e.episodeNumber,
        title: e.title,
        overview: e.overview,
        airDate: e.airDate ? e.airDate.toISOString() : null,
        runtimeMinutes: e.runtimeMinutes,
      }));
      const providerEpisodesForApply: ProviderEpisodeForApply[] = fetched.episodes.map((e) => ({
        seasonNumber: e.seasonNumber,
        episodeNumber: e.episodeNumber,
        title: e.title,
        overviewHtml: e.overview,
        airDate: e.airDate ? e.airDate.toISOString() : null,
        runtimeMinutes: e.runtimeMinutes,
      }));

      // Unify the two possible plan shapes (ordinary vs. migration) behind
      // a small common view so the idempotency check, dry-run reporting,
      // and apply transaction below don't need to be duplicated.
      let unifiedExternalIdsUpdate: ExternalIdsUpdate;
      let unifiedPosterUpdate: { from: string | null; to: string; wouldChange: boolean } | null;
      let unifiedEpisodeUpdates: EpisodeUpdatePlan[];
      let unifiedEpisodeUpdateCount: number;
      let unifiedPreservedOrphanEpisodes: ReturnType<typeof findOrphanedWatchedEpisodes>;
      let unifiedResolvedUserStatus: UserSeriesStatus;
      let unifiedResolvedNextEpisodeId: string | null;
      let unifiedStatusSource: 'derived' | 'human-override';

      if (isMigrationSafe && migrationResult) {
        const migrationPlan = buildMigrationApplyPlan({
          seriesId: local.seriesId,
          title: decision.title,
          provider: decision.provider,
          providerId,
          userId: options.userId,
          currentPosterUrl: local.posterUrl,
          providerPosterUrl: fetched.posterUrl,
          localEpisodes: localEpisodesForApply,
          providerEpisodes: providerEpisodesForApply,
          orphanedWatchedEpisodes,
          resolvedUserStatus: migrationResult.resolvedUserStatus,
          statusSource: migrationResult.statusSource,
          currentNextEpisodeId: local.progress?.nextEpisodeId ?? null,
        });
        unifiedExternalIdsUpdate = migrationPlan.externalIdsUpdate;
        unifiedPosterUpdate = migrationPlan.posterUpdate;
        unifiedEpisodeUpdates = migrationPlan.episodeUpdates;
        unifiedEpisodeUpdateCount = migrationPlan.episodeUpdateCount;
        unifiedPreservedOrphanEpisodes = migrationPlan.preservedOrphanEpisodes;
        unifiedResolvedUserStatus = migrationPlan.progressUpdate.userStatus;
        unifiedResolvedNextEpisodeId = migrationPlan.progressUpdate.nextEpisodeId;
        unifiedStatusSource = migrationPlan.progressUpdate.statusSource;
      } else {
        const preservedOrphanEpisodes = resolvePreservedOrphanEpisodes({
          classification: decisionResult.classification,
          orphanSeasonZeroEpisodes: seasonZeroOrphanCheck.orphanSeasonZeroEpisodes,
          tailOrphanedEpisodes: decisionResult.tailOrphanedEpisodes,
        });
        const plan = buildConfirmedSeriesApplyPlan({
          seriesId: local.seriesId,
          title: decision.title,
          provider: decision.provider,
          providerId,
          userId: options.userId,
          currentPosterUrl: local.posterUrl,
          providerPosterUrl: fetched.posterUrl,
          localEpisodes: localEpisodesForApply,
          providerEpisodes: providerEpisodesForApply,
          preservedOrphanEpisodes,
          proposedUserStatus: comparison.proposedUserStatus,
          proposedNextEpisodeId: comparison.proposedNextEpisodeId,
        });
        unifiedExternalIdsUpdate = plan.externalIdsUpdate;
        unifiedPosterUpdate = plan.posterUpdate;
        unifiedEpisodeUpdates = plan.episodeUpdates;
        unifiedEpisodeUpdateCount = plan.episodeUpdateCount;
        unifiedPreservedOrphanEpisodes = preservedOrphanEpisodes;
        unifiedResolvedUserStatus = comparison.proposedUserStatus;
        unifiedResolvedNextEpisodeId = comparison.proposedNextEpisodeId;
        unifiedStatusSource = 'derived';
      }

      // Idempotency check: has this exact provider/providerId already been
      // written to ExternalIds, with nothing left for the plan to change?
      // If so this is a pure re-confirmation — report it separately and
      // skip opening a transaction entirely, rather than re-reporting it
      // as "safe, pending apply" forever or rewriting ExternalIds.matchedAt
      // for no reason on every apply run.
      const alreadyMatchedProvider = local.externalIds?.provider === decision.provider && local.externalIds?.providerId === providerId;
      const wouldChangeProgress =
        (local.progress?.userStatus ?? UserSeriesStatus.UNKNOWN) !== unifiedResolvedUserStatus || (local.progress?.nextEpisodeId ?? null) !== unifiedResolvedNextEpisodeId;
      const isNoOp = alreadyMatchedProvider && unifiedEpisodeUpdateCount === 0 && unifiedPosterUpdate === null && !wouldChangeProgress;
      if (isNoOp) {
        alreadyAppliedSeries.push({
          title: decision.title,
          seriesId: local.seriesId,
          provider: decision.provider,
          providerId,
          classification: decisionResult.classification,
          migrationIntent,
          migrationClassification: migrationClassificationForReport,
        });
        console.log(`  [ALREADY_APPLIED] ${decision.title} — ExternalIds already matches, nothing new to write.`);
        continue;
      }

      if (!options.apply) {
        dryRunSafeSeries.push({
          title: decision.title,
          seriesId: local.seriesId,
          provider: decision.provider,
          providerId,
          classification: decisionResult.classification,
          episodeUpdateCount: unifiedEpisodeUpdateCount,
          wouldUpdatePoster: unifiedPosterUpdate !== null,
          preservedOrphanEpisodeCount: unifiedPreservedOrphanEpisodes.length,
          preservedOrphanEpisodes: unifiedPreservedOrphanEpisodes,
          migrationIntent,
          statusSource: unifiedStatusSource,
          migrationClassification: migrationClassificationForReport,
        });
        continue;
      }

      // --- Apply mode: write this ONE series in its own transaction so a
      // failure here never blocks or rolls back any other series. ---------
      const fromStatus = local.progress?.userStatus ?? UserSeriesStatus.UNKNOWN;
      let toStatus = fromStatus;
      const usingMigrationPlan = isMigrationSafe && migrationResult !== null;

      await prisma.$transaction(async (tx) => {
        await tx.externalIds.upsert({
          where: { seriesId: unifiedExternalIdsUpdate.seriesId },
          create: {
            seriesId: unifiedExternalIdsUpdate.seriesId,
            provider: unifiedExternalIdsUpdate.provider,
            providerId: unifiedExternalIdsUpdate.providerId,
            // Only ever set for a tmdb match — mirrors the dedicated,
            // uniquely-constrained column health-logic.ts,
            // episode-release-refresh, and the app's series.service.ts all
            // actually read. undefined (not written) for tvmaze, which has
            // no dedicated column of its own — see
            // docs/library-health-provider-confirmation-runbook.md.
            tmdbId: unifiedExternalIdsUpdate.tmdbId,
            matchSource: usingMigrationPlan ? 'library-health:provider-confirmation-pipeline:migration' : 'library-health:provider-confirmation-pipeline',
            matchConfidence: 1,
            matchedAt: generatedAt,
          },
          update: {
            provider: unifiedExternalIdsUpdate.provider,
            providerId: unifiedExternalIdsUpdate.providerId,
            tmdbId: unifiedExternalIdsUpdate.tmdbId,
            matchSource: usingMigrationPlan ? 'library-health:provider-confirmation-pipeline:migration' : 'library-health:provider-confirmation-pipeline',
            matchConfidence: 1,
            matchedAt: generatedAt,
          },
        });

        if (unifiedPosterUpdate) {
          await tx.series.update({ where: { id: local.seriesId }, data: { posterUrl: unifiedPosterUpdate.to } });
        }

        // Never touches an episode with no update — and, by construction
        // (planEpisodeUpdates), never touches an episode with no provider
        // counterpart at all (the preserved orphan/tail rows above). Only
        // ever an UPDATE on an existing row — no create, no delete.
        for (const update of unifiedEpisodeUpdates) {
          const data: Record<string, unknown> = {};
          if (update.changes.title !== undefined) data.title = update.changes.title;
          if (update.changes.overview !== undefined) data.overview = update.changes.overview;
          if (update.changes.airDate !== undefined) data.airDate = new Date(update.changes.airDate);
          if (update.changes.runtimeMinutes !== undefined) data.runtimeMinutes = update.changes.runtimeMinutes;
          if (Object.keys(data).length === 0) continue;
          await tx.episode.update({ where: { id: update.episodeId }, data });
        }

        // Re-reads the LIVE status inside the transaction rather than
        // trusting the snapshot read at the top of the loop.
        const liveProgress = await tx.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId: options.userId, seriesId: local.seriesId } } });
        const liveStatus = liveProgress?.userStatus ?? UserSeriesStatus.UNKNOWN;

        let finalStatus: UserSeriesStatus;
        let finalNextEpisodeId: string | null;
        if (usingMigrationPlan) {
          // Migration mode's own protected-status re-check (task
          // requirement 8) — re-verified fresh here, not trusted from the
          // classification-time snapshot, exactly like the non-migration
          // path's decideUserStatusUpdate re-check below.
          finalStatus = isProtectedMigrationStatus(liveStatus) ? liveStatus : unifiedResolvedUserStatus;
          finalNextEpisodeId = unifiedResolvedNextEpisodeId;
        } else {
          // Same protected-status re-check the tmdb-enrichment apply step uses.
          const statusDecision = decideUserStatusUpdate(liveStatus, unifiedResolvedUserStatus);
          finalStatus = statusDecision.shouldUpdate ? unifiedResolvedUserStatus : liveStatus;
          finalNextEpisodeId = unifiedResolvedNextEpisodeId;
        }
        toStatus = finalStatus;

        await tx.userSeriesProgress.upsert({
          where: { userId_seriesId: { userId: options.userId, seriesId: local.seriesId } },
          create: { userId: options.userId, seriesId: local.seriesId, userStatus: finalStatus, nextEpisodeId: finalNextEpisodeId },
          update: { userStatus: finalStatus, nextEpisodeId: finalNextEpisodeId },
        });
      });

      appliedSeries.push({
        title: decision.title,
        seriesId: local.seriesId,
        provider: decision.provider,
        providerId,
        classification: decisionResult.classification,
        episodeUpdateCount: unifiedEpisodeUpdateCount,
        posterUpdated: unifiedPosterUpdate !== null,
        preservedOrphanEpisodeCount: unifiedPreservedOrphanEpisodes.length,
        preservedOrphanEpisodes: unifiedPreservedOrphanEpisodes,
        userStatus: { from: fromStatus, to: toStatus, changed: fromStatus !== toStatus },
        migrationIntent,
        statusSource: unifiedStatusSource,
        migrationClassification: migrationClassificationForReport,
      });
    } catch (err) {
      const isNotFound = (err instanceof TmdbRequestError || err instanceof TvMazeRequestError) && err.status === 404;
      const message = err instanceof TmdbRequestError || err instanceof TvMazeRequestError ? err.message : (err as Error).message;
      errors.push({ title: decision.title, message });
      console.log(`  [ERROR] ${decision.title} — ${message}`);
      if (isNotFound) {
        nextManualReviewCandidates.push({ title: decision.title, seriesId: local.seriesId, reason: `provider candidate ${decision.provider}:${providerId} was not found — decision may need updating.` });
      }
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
    decisionsFilePath: options.decisionsPath,
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

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
