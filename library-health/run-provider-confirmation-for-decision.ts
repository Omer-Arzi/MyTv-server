// The single, reusable "run the whole provider-confirmation pipeline for
// ONE decision" function — extracted from run-provider-confirmation-pipeline.ts's
// per-decision loop body so a live, single-series NestJS request handler
// (src/modules/migration-workbench/) and the CLI's whole-decisions-file
// loop share the exact same code path, never two implementations of this
// logic. Behavior-preserving extraction: every classification/plan-building
// call, every branch, and the apply transaction itself are unchanged from
// the original loop body — only the control flow (continue -> return) and
// the per-iteration local variables (loop-scoped -> function-scoped) changed.
//
// This function performs real I/O: one live TMDb or TVmaze fetch, then
// (only when apply/applyAutoSafeMigrations authorize it for this decision's
// resulting classification) one real Prisma transaction. Safe to call for
// exactly one decision from a live HTTP request — unlike the whole-library
// health/needs-attention list views, this is only ever invoked by an
// explicit, single-series user action, never on every screen load.

import { Prisma, PrismaClient, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { MAX_APPEND_TO_RESPONSE_ITEMS, TmdbClient, TmdbRequestError } from '../tmdb-enrichment/tmdb-client';
import { getAppendedSeason } from '../tmdb-enrichment/tmdb-types';
import { mapTmdbStatusToReleaseStatus } from '../tmdb-enrichment/release-status-mapping';
import { tmdbImageUrl, decideUserStatusUpdate } from '../tmdb-enrichment/apply-plan-writes';
import { TvMazeClient, TvMazeRequestError } from '../secondary-provider-audit/tvmaze-client';
import { chunkArray, compareSeriesCatalog, LocalEpisodeInput, ProviderEpisodeInput } from '../episode-release-refresh/refresh-logic';
import { createMissingSeasonsAndEpisodes } from '../episode-release-refresh/season-episode-writer';
import { SeriesHealthInput } from './health-logic';
import { checkTitleYearSanity, classifyProviderConfirmationDryRun, ProviderConfirmationDecision } from './provider-confirmation-decisions-logic';
import { checkBenignSeasonZeroOrphan, detectRealSeasonShrink, findOrphanedWatchedEpisodes } from './season-zero-orphan-logic';
import { checkSplitEpisodeTailOnly } from './split-episode-tail-logic';
import { buildConfirmedSeriesApplyPlan, ExternalIdsUpdate, isSafeApplyClassification, resolvePreservedOrphanEpisodes } from './apply-confirmed-provider-logic';
import { buildMigrationApplyPlan, classifyMigrationConfirmation, isProtectedMigrationStatus, StatusSource } from './migration-confirmation-logic';
import { EpisodeUpdatePlan, LocalEpisodeForApply, ProviderEpisodeForApply } from './apply-friends-tvmaze-logic';
import { titleSimilarity, extractTitleYearHint } from '../trakt-enrichment/scoring';
import { classifyIdentityConfidence, evaluateAutoMigrationEligibility, resolveObjectiveMigrationStatus, shouldForceWatchingForPendingNextEpisode } from './migration-policy-logic';
import { buildMigrationCatalogInsertPlan, CATALOG_RECONCILIATION_IMPORT_BATCH_ID, computeMatchedEpisodeCounts } from './migration-catalog-plan-logic';
import { classifyMigrationOperatingOutcome } from './migration-operating-outcome';
import { captureSeriesSnapshot } from './verification-snapshot';
import { verifySeriesPostApply } from './verification-logic';
import { PipelineAppliedSeriesEntry, PipelineDryRunSafeEntry, PipelineAlreadyAppliedSeriesEntry, PipelineSkippedSeriesEntry, PipelineErrorEntry } from './provider-confirmation-pipeline-reports';

export interface RunProviderConfirmationForDecisionInput {
  prisma: PrismaClient;
  tmdb: TmdbClient;
  tvmaze: TvMazeClient;
  decision: ProviderConfirmationDecision;
  healthInputs: SeriesHealthInput[];
  userId: string;
  generatedAt: Date;
  apply: boolean;
  applyAutoSafeMigrations: boolean;
  maxSeasonZeroOrphans: number;
}

export type ProviderConfirmationForDecisionOutcome =
  | { kind: 'deferred'; entry: PipelineSkippedSeriesEntry }
  | { kind: 'local-not-found' | 'missing-provider-fields'; entry: PipelineSkippedSeriesEntry }
  | { kind: 'blocked'; entry: PipelineSkippedSeriesEntry; nextManualReviewCandidate?: { title: string; seriesId: string; reason: string } }
  | { kind: 'already-applied'; entry: PipelineAlreadyAppliedSeriesEntry }
  | { kind: 'dry-run-safe'; entry: PipelineDryRunSafeEntry }
  | { kind: 'applied'; entry: PipelineAppliedSeriesEntry; migrationHistoryId: string | null }
  | { kind: 'error'; entry: PipelineErrorEntry; nextManualReviewCandidate?: { title: string; seriesId: string; reason: string } };

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

export async function runProviderConfirmationForDecision(input: RunProviderConfirmationForDecisionInput): Promise<ProviderConfirmationForDecisionOutcome> {
  const { prisma, tmdb, tvmaze, decision, healthInputs, userId, generatedAt, apply, applyAutoSafeMigrations, maxSeasonZeroOrphans } = input;

  if (decision.decision !== 'confirm') {
    return {
      kind: 'deferred',
      entry: {
        title: decision.title,
        seriesId: null,
        classification: null,
        reason: `decision is "${decision.decision}" — not confirmed, never applied.`,
        migrationIntent: decision.migrationIntent === true,
        migrationClassification: null,
        operatingClassification: 'REVIEW_IDENTITY',
      },
    };
  }

  const local = healthInputs.find((s) => s.title === decision.title);
  if (!local) {
    return {
      kind: 'local-not-found',
      entry: {
        title: decision.title,
        seriesId: null,
        classification: 'LOCAL_SERIES_NOT_FOUND',
        reason: `no local series titled "${decision.title}" was found.`,
        migrationIntent: decision.migrationIntent === true,
        migrationClassification: null,
        operatingClassification: 'REVIEW_IDENTITY',
      },
    };
  }

  if (!decision.provider || decision.providerId === undefined) {
    return {
      kind: 'missing-provider-fields',
      entry: {
        title: decision.title,
        seriesId: local.seriesId,
        classification: 'BLOCKED_RISK',
        reason: 'decision is "confirm" but is missing a "provider" and/or "providerId".',
        migrationIntent: decision.migrationIntent === true,
        migrationClassification: null,
        operatingClassification: 'REVIEW_IDENTITY',
      },
    };
  }

  const providerId = String(decision.providerId);
  const bySeason = new Map<number, number>();
  for (const ep of local.episodes) bySeason.set(ep.seasonNumber, (bySeason.get(ep.seasonNumber) ?? 0) + 1);
  const localSeasonNumbers = [...bySeason.keys()];

  try {
    const fetched = decision.provider === 'tmdb' ? await fetchTmdbCandidate(tmdb, providerId, localSeasonNumbers) : await fetchTvmazeCandidate(tvmaze, providerId);

    const sanity = checkTitleYearSanity({ localTitle: decision.title, candidateTitle: fetched.candidateTitle, candidateYear: fetched.candidateYear });
    const fullLocalEpisodes = await loadFullLocalEpisodes(prisma, userId, local.seriesId);
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
      maxOrphanCount: maxSeasonZeroOrphans,
    });
    const splitEpisodeTailCheck = checkSplitEpisodeTailOnly({
      localTitle: decision.title,
      localEpisodes: fullLocalEpisodes,
      providerEpisodes: fetched.episodes,
      orphanedWatchedEpisodes,
    });

    const decisionResult = classifyProviderConfirmationDryRun({ titleYearSanity: sanity, comparison, seasonZeroOrphanCheck, splitEpisodeTailCheck });

    const identitySimilarity = titleSimilarity(extractTitleYearHint(decision.title).bareTitle, fetched.candidateTitle);
    const identityBand = classifyIdentityConfidence({ titleYearSanityPassed: sanity.passed, similarity: identitySimilarity });
    const autoEligibility = evaluateAutoMigrationEligibility({ titleYearSanityPassed: sanity.passed, identityBand, realSeasonShrinkDetected });
    const matchedEpisodeCounts = computeMatchedEpisodeCounts(fullLocalEpisodes, fetched.episodes);
    const objectiveStatus = resolveObjectiveMigrationStatus({
      matchedWatchedCount: matchedEpisodeCounts.matchedWatchedCount,
      matchedTotalCount: matchedEpisodeCounts.matchedTotalCount,
      currentUserStatus: local.progress?.userStatus ?? UserSeriesStatus.UNKNOWN,
      providerReleaseStatus: fetched.releaseStatus,
    });

    const migrationIntent = decision.migrationIntent === true;
    const migrationResult = migrationIntent
      ? classifyMigrationConfirmation({
          baseClassification: decisionResult.classification,
          baseReason: decisionResult.reason,
          titleYearSanityPassed: sanity.passed,
          realSeasonShrinkDetected,
          orphanedWatchedEpisodes,
          currentUserStatus: local.progress?.userStatus ?? UserSeriesStatus.UNKNOWN,
          migration: { migrationIntent: true, statusOverride: decision.statusOverride },
        })
      : null;
    const migrationClassificationForReport = migrationResult
      ? (migrationResult.classification as 'SAFE_MIGRATION_WITH_PRESERVED_ORPHANS' | 'SAFE_MIGRATION_WITH_STATUS_OVERRIDE' | 'BLOCKED_DESTRUCTIVE_RISK')
      : null;
    const isMigrationSafe = migrationClassificationForReport === 'SAFE_MIGRATION_WITH_PRESERVED_ORPHANS' || migrationClassificationForReport === 'SAFE_MIGRATION_WITH_STATUS_OVERRIDE';
    const isBaseSafe = isSafeApplyClassification(decisionResult.classification);
    const isAutoMigrateEligible = !migrationIntent && !isBaseSafe && autoEligibility.eligible;

    if (!isBaseSafe && !isMigrationSafe && !isAutoMigrateEligible) {
      const reason = migrationResult ? migrationResult.reason : `${decisionResult.reason} (auto-migration policy: ${autoEligibility.reason})`;
      const entry: PipelineSkippedSeriesEntry = {
        title: decision.title,
        seriesId: local.seriesId,
        classification: decisionResult.classification,
        reason,
        migrationIntent,
        migrationClassification: migrationClassificationForReport,
        operatingClassification: classifyMigrationOperatingOutcome({
          providerFetchFailed: false,
          hasConfirmedIdentity: true,
          titleYearSanityPassed: sanity.passed,
          identityBand,
          realSeasonShrinkDetected,
          engineInvariantViolated: false,
          hasPendingCatalogWork: false,
        }),
      };
      const nextManualReviewCandidate =
        decisionResult.classification === 'BLOCKED_RISK' || decisionResult.classification === 'NEEDS_MANUAL_REVIEW' || migrationClassificationForReport === 'BLOCKED_DESTRUCTIVE_RISK'
          ? { title: decision.title, seriesId: local.seriesId, reason: `classified ${migrationClassificationForReport ?? decisionResult.classification} — ${reason}` }
          : undefined;
      return { kind: 'blocked', entry, nextManualReviewCandidate };
    }

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

    const localSeasonNumbersForCatalogPlan = [...new Set(fullLocalEpisodes.map((e) => e.seasonNumber))];
    const catalogInsertPlan = buildMigrationCatalogInsertPlan({
      newEpisodes: comparison.newEpisodes,
      providerEpisodes: fetched.episodes,
      localSeasonNumbers: localSeasonNumbersForCatalogPlan,
    });

    const usingMigrationOrAutoPlan = (isMigrationSafe && migrationResult !== null) || isAutoMigrateEligible;

    let unifiedExternalIdsUpdate: ExternalIdsUpdate;
    let unifiedPosterUpdate: { from: string | null; to: string; wouldChange: boolean } | null;
    let unifiedEpisodeUpdates: EpisodeUpdatePlan[];
    let unifiedEpisodeUpdateCount: number;
    let unifiedPreservedOrphanEpisodes: ReturnType<typeof findOrphanedWatchedEpisodes>;
    let unifiedResolvedUserStatus: UserSeriesStatus;
    let unifiedResolvedNextEpisodeId: string | null;
    let unifiedStatusSource: StatusSource;

    if (usingMigrationOrAutoPlan) {
      const resolvedUserStatus = isMigrationSafe && migrationResult ? migrationResult.resolvedUserStatus : objectiveStatus.resolvedUserStatus;
      const statusSource: StatusSource = isMigrationSafe && migrationResult ? migrationResult.statusSource : objectiveStatus.statusSource;
      const migrationPlan = buildMigrationApplyPlan({
        seriesId: local.seriesId,
        title: decision.title,
        provider: decision.provider,
        providerId,
        userId,
        currentPosterUrl: local.posterUrl,
        providerPosterUrl: fetched.posterUrl,
        localEpisodes: localEpisodesForApply,
        providerEpisodes: providerEpisodesForApply,
        orphanedWatchedEpisodes,
        resolvedUserStatus,
        statusSource,
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
        userId,
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

    const hasProposedNextEpisode = comparison.proposedNextEpisodeLabel !== null;
    const explicitStatusOverrideGiven = migrationIntent && decision.statusOverride !== undefined;
    let pendingNewNextEpisodeCreation = false;
    if (shouldForceWatchingForPendingNextEpisode({ hasProposedNextEpisode, liveUserStatus: local.progress?.userStatus ?? UserSeriesStatus.UNKNOWN, explicitStatusOverrideGiven })) {
      unifiedResolvedUserStatus = UserSeriesStatus.WATCHING;
      unifiedStatusSource = 'derived';
      if (comparison.proposedNextEpisodeIsNew) {
        unifiedResolvedNextEpisodeId = null;
        pendingNewNextEpisodeCreation = true;
      } else {
        unifiedResolvedNextEpisodeId = comparison.proposedNextEpisodeId;
      }
    }

    const alreadyMatchedProvider = local.externalIds?.provider === decision.provider && local.externalIds?.providerId === providerId;
    const wouldChangeProgress =
      (local.progress?.userStatus ?? UserSeriesStatus.UNKNOWN) !== unifiedResolvedUserStatus || (local.progress?.nextEpisodeId ?? null) !== unifiedResolvedNextEpisodeId;
    const hasCatalogWorkPending = catalogInsertPlan.episodesToInsert.length > 0;
    const isNoOp = alreadyMatchedProvider && unifiedEpisodeUpdateCount === 0 && unifiedPosterUpdate === null && !wouldChangeProgress && !hasCatalogWorkPending;

    const operatingClassification = classifyMigrationOperatingOutcome({
      providerFetchFailed: false,
      hasConfirmedIdentity: true,
      titleYearSanityPassed: sanity.passed,
      identityBand,
      realSeasonShrinkDetected,
      engineInvariantViolated: false,
      hasPendingCatalogWork: !isNoOp,
    });
    const viaAutoMigrationPolicy = isAutoMigrateEligible;

    if (isNoOp) {
      return {
        kind: 'already-applied',
        entry: {
          title: decision.title,
          seriesId: local.seriesId,
          provider: decision.provider,
          providerId,
          classification: decisionResult.classification,
          migrationIntent,
          migrationClassification: migrationClassificationForReport,
        },
      };
    }

    const authorizedToWrite = apply && (isBaseSafe || isMigrationSafe || (isAutoMigrateEligible && applyAutoSafeMigrations));

    if (!authorizedToWrite) {
      const previewFromStatus = local.progress?.userStatus ?? UserSeriesStatus.UNKNOWN;
      const previewFromNextEpisodeId = local.progress?.nextEpisodeId ?? null;
      return {
        kind: 'dry-run-safe',
        entry: {
          title: decision.title,
          seriesId: local.seriesId,
          provider: decision.provider,
          providerId,
          classification: decisionResult.classification,
          episodeUpdateCount: unifiedEpisodeUpdateCount,
          wouldUpdatePoster: unifiedPosterUpdate !== null,
          preservedOrphanEpisodeCount: unifiedPreservedOrphanEpisodes.length,
          preservedOrphanEpisodes: unifiedPreservedOrphanEpisodes,
          userStatus: { from: previewFromStatus, to: unifiedResolvedUserStatus, changed: previewFromStatus !== unifiedResolvedUserStatus },
          nextEpisodeId: {
            from: previewFromNextEpisodeId,
            to: unifiedResolvedNextEpisodeId,
            changed: previewFromNextEpisodeId !== unifiedResolvedNextEpisodeId || pendingNewNextEpisodeCreation,
          },
          migrationIntent,
          statusSource: unifiedStatusSource,
          migrationClassification: migrationClassificationForReport,
          operatingClassification,
          identityBand,
          autoMigrationEligible: autoEligibility.eligible,
          autoMigrationEligibilityReason:
            isAutoMigrateEligible && !applyAutoSafeMigrations ? `${autoEligibility.reason} (blocked from writing this run: --apply-auto-safe-migrations not passed)` : autoEligibility.reason,
          seasonsCreated: catalogInsertPlan.seasonNumbersToCreate,
          episodesCreated: catalogInsertPlan.episodesToInsert.length,
          matchedWatchedCount: matchedEpisodeCounts.matchedWatchedCount,
          matchedTotalCount: matchedEpisodeCounts.matchedTotalCount,
          viaAutoMigrationPolicy,
        },
      };
    }

    // --- Apply mode: write this ONE series in its own transaction. ---------
    const fromStatus = local.progress?.userStatus ?? UserSeriesStatus.UNKNOWN;
    let toStatus = fromStatus;
    const fromNextEpisodeId = local.progress?.nextEpisodeId ?? null;
    let toNextEpisodeId = fromNextEpisodeId;
    const usingMigrationPlan = isMigrationSafe && migrationResult !== null;
    const matchSource = usingMigrationPlan
      ? 'library-health:provider-confirmation-pipeline:migration'
      : viaAutoMigrationPolicy
        ? 'library-health:provider-confirmation-pipeline:auto-migration'
        : 'library-health:provider-confirmation-pipeline';

    const catalogResult = { seasonsCreated: [] as number[], episodesInserted: 0, duplicatesSkipped: 0, episodeIdsInserted: [] as string[] };

    const beforeSnapshot = await captureSeriesSnapshot(prisma, local.seriesId, userId);
    let migrationHistoryId: string | null = null;

    await prisma.$transaction(async (tx) => {
      await tx.externalIds.upsert({
        where: { seriesId: unifiedExternalIdsUpdate.seriesId },
        create: {
          seriesId: unifiedExternalIdsUpdate.seriesId,
          provider: unifiedExternalIdsUpdate.provider,
          providerId: unifiedExternalIdsUpdate.providerId,
          tmdbId: unifiedExternalIdsUpdate.tmdbId,
          matchSource,
          matchConfidence: 1,
          matchedAt: generatedAt,
        },
        update: {
          provider: unifiedExternalIdsUpdate.provider,
          providerId: unifiedExternalIdsUpdate.providerId,
          tmdbId: unifiedExternalIdsUpdate.tmdbId,
          matchSource,
          matchConfidence: 1,
          matchedAt: generatedAt,
        },
      });

      if (unifiedPosterUpdate) {
        await tx.series.update({ where: { id: local.seriesId }, data: { posterUrl: unifiedPosterUpdate.to } });
      }

      for (const update of unifiedEpisodeUpdates) {
        const data: Record<string, unknown> = {};
        if (update.changes.title !== undefined) data.title = update.changes.title;
        if (update.changes.overview !== undefined) data.overview = update.changes.overview;
        if (update.changes.airDate !== undefined) data.airDate = new Date(update.changes.airDate);
        if (update.changes.runtimeMinutes !== undefined) data.runtimeMinutes = update.changes.runtimeMinutes;
        if (Object.keys(data).length === 0) continue;
        await tx.episode.update({ where: { id: update.episodeId }, data });
      }

      if (catalogInsertPlan.episodesToInsert.length > 0) {
        const result = await createMissingSeasonsAndEpisodes(tx, {
          seriesId: local.seriesId,
          insertPlan: catalogInsertPlan,
          importBatchId: CATALOG_RECONCILIATION_IMPORT_BATCH_ID,
        });
        catalogResult.seasonsCreated = result.seasonsCreated;
        catalogResult.episodesInserted = result.episodesInserted;
        catalogResult.duplicatesSkipped = result.duplicatesSkipped;
        catalogResult.episodeIdsInserted = result.episodeIdsInserted;
      }

      const liveProgress = await tx.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId, seriesId: local.seriesId } } });
      const liveStatus = liveProgress?.userStatus ?? UserSeriesStatus.UNKNOWN;

      let finalStatus: UserSeriesStatus;
      let finalNextEpisodeId: string | null;
      if (usingMigrationOrAutoPlan) {
        finalStatus = isProtectedMigrationStatus(liveStatus) ? liveStatus : unifiedResolvedUserStatus;
        finalNextEpisodeId = unifiedResolvedNextEpisodeId;
      } else {
        const statusDecision = decideUserStatusUpdate(liveStatus, unifiedResolvedUserStatus);
        finalStatus = statusDecision.shouldUpdate ? unifiedResolvedUserStatus : liveStatus;
        finalNextEpisodeId = unifiedResolvedNextEpisodeId;
      }

      if (shouldForceWatchingForPendingNextEpisode({ hasProposedNextEpisode, liveUserStatus: liveStatus, explicitStatusOverrideGiven })) {
        finalStatus = UserSeriesStatus.WATCHING;
        if (comparison.proposedNextEpisodeIsNew && comparison.proposedNextSeasonNumber !== null && comparison.proposedNextEpisodeNumber !== null) {
          const createdNext = await tx.episode.findFirst({
            where: { season: { seriesId: local.seriesId, seasonNumber: comparison.proposedNextSeasonNumber }, episodeNumber: comparison.proposedNextEpisodeNumber },
            select: { id: true },
          });
          finalNextEpisodeId = createdNext?.id ?? null;
        } else {
          finalNextEpisodeId = comparison.proposedNextEpisodeId;
        }
      }

      toStatus = finalStatus;
      toNextEpisodeId = finalNextEpisodeId;

      await tx.userSeriesProgress.upsert({
        where: { userId_seriesId: { userId, seriesId: local.seriesId } },
        create: { userId, seriesId: local.seriesId, userStatus: finalStatus, nextEpisodeId: finalNextEpisodeId },
        update: { userStatus: finalStatus, nextEpisodeId: finalNextEpisodeId },
      });

      // Durable, auditable migration record — written in the SAME
      // transaction as the writes it describes, so a successful apply can
      // never exist without a matching history row (and vice versa: if
      // this insert fails, the whole transaction rolls back, including the
      // writes above). Stores enough before/after state for
      // migration-rollback-logic.ts to build a rollback plan without
      // re-deriving it later — see prisma/schema.prisma's MigrationHistory
      // doc comment. sourceCategory mirrors
      // src/modules/migration-workbench/migration-workbench-logic.ts's own
      // READY_AUTOMATIC/READY_FOR_CONFIRMATION split (HIGH_CONFIDENCE +
      // zero orphans vs. everything else safe-to-write) — kept as this one
      // inline ternary rather than an import, since library-health never
      // imports from src/modules (the dependency only ever runs the other
      // way in this codebase).
      const sourceCategory = identityBand === 'HIGH_CONFIDENCE' && unifiedPreservedOrphanEpisodes.length === 0 ? 'READY_AUTOMATIC' : 'READY_FOR_CONFIRMATION';
      const historyRow = await tx.migrationHistory.create({
        data: {
          userId,
          seriesId: local.seriesId,
          seriesTitle: decision.title,
          classification: operatingClassification,
          sourceCategory,
          providerBefore: local.externalIds ? { provider: local.externalIds.provider, providerId: local.externalIds.providerId, tmdbId: local.externalIds.tmdbId } : Prisma.JsonNull,
          providerAfter: { provider: unifiedExternalIdsUpdate.provider, providerId: unifiedExternalIdsUpdate.providerId, tmdbId: unifiedExternalIdsUpdate.tmdbId ?? null },
          releaseStatusBefore: local.releaseStatus,
          releaseStatusAfter: local.releaseStatus,
          userStatusBefore: fromStatus,
          userStatusAfter: finalStatus,
          nextEpisodeIdBefore: fromNextEpisodeId,
          nextEpisodeIdAfter: finalNextEpisodeId,
          episodesInsertedIds: catalogResult.episodeIdsInserted,
          episodesUpdatedIds: unifiedEpisodeUpdates.map((u) => u.episodeId),
          preservedOrphanEpisodeIds: unifiedPreservedOrphanEpisodes.map((e) => e.id),
          watchedMappingCount: matchedEpisodeCounts.matchedWatchedCount,
          verificationPassed: true, // corrected below once verification actually runs (post-transaction) via a follow-up update
          verificationDetail: [],
        },
      });
      migrationHistoryId = historyRow.id;
    });

    const afterSnapshot = await captureSeriesSnapshot(prisma, local.seriesId, userId);
    const verificationResult = verifySeriesPostApply(beforeSnapshot, afterSnapshot, {
      seriesId: local.seriesId,
      expectedImportBatchId: CATALOG_RECONCILIATION_IMPORT_BATCH_ID,
      expectedNewSeasonNumbers: catalogResult.seasonsCreated,
      expectedNewEpisodeCount: catalogResult.episodesInserted,
      preservedOrphanEpisodeIds: unifiedPreservedOrphanEpisodes.map((e) => e.id),
      expectedUserStatus: toStatus,
      expectedNextEpisodeId: toNextEpisodeId,
    });
    const failedChecks = verificationResult.checks.filter((c) => c.status === 'FAIL').map((c) => `${c.name}: ${c.detail}`);

    // Patched in AFTER the transaction (verification needs the post-write
    // snapshot, which only exists once the transaction has committed) —
    // the history row itself already exists from inside the transaction,
    // so this can never leave an apply without SOME history record; only
    // its verification fields could, in the rare case this specific update
    // fails, stay at their optimistic placeholder rather than the real
    // result. Never blocks or reverses the already-committed migration.
    if (migrationHistoryId) {
      await prisma.migrationHistory.update({
        where: { id: migrationHistoryId },
        data: { verificationPassed: verificationResult.passed, verificationDetail: failedChecks },
      });
    }

    return {
      kind: 'applied',
      migrationHistoryId,
      entry: {
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
        nextEpisodeId: { from: fromNextEpisodeId, to: toNextEpisodeId, changed: fromNextEpisodeId !== toNextEpisodeId },
        migrationIntent,
        statusSource: unifiedStatusSource,
        migrationClassification: migrationClassificationForReport,
        operatingClassification,
        identityBand,
        autoMigrationEligible: autoEligibility.eligible,
        autoMigrationEligibilityReason: autoEligibility.reason,
        seasonsCreated: catalogResult.seasonsCreated,
        episodesCreated: catalogResult.episodesInserted,
        matchedWatchedCount: matchedEpisodeCounts.matchedWatchedCount,
        matchedTotalCount: matchedEpisodeCounts.matchedTotalCount,
        viaAutoMigrationPolicy,
        verification: { passed: verificationResult.passed, failedChecks },
      },
    };
  } catch (err) {
    const isNotFound = (err instanceof TmdbRequestError || err instanceof TvMazeRequestError) && err.status === 404;
    const message = err instanceof TmdbRequestError || err instanceof TvMazeRequestError ? err.message : (err as Error).message;
    const nextManualReviewCandidate = isNotFound
      ? { title: decision.title, seriesId: local.seriesId, reason: `provider candidate ${decision.provider}:${providerId} was not found — decision may need updating.` }
      : undefined;
    return { kind: 'error', entry: { title: decision.title, message }, nextManualReviewCandidate };
  }
}
