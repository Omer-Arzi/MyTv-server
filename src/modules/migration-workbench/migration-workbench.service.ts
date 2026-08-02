import { Injectable, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { readFileSync } from 'fs';
import path from 'path';
import { MigrationHistory, UserSeriesStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DEV_USER_ID } from '../../common/constants';
import { TmdbClient } from '../../../tmdb-enrichment/tmdb-client';
import { TvMazeClient } from '../../../secondary-provider-audit/tvmaze-client';
import { loadSeriesHealthInputs } from '../../../library-health/load-series-health-inputs';
import { findDecisionForSeries } from '../../../library-health/provider-identity-decisions-store';
import { runProviderConfirmationForDecision } from '../../../library-health/run-provider-confirmation-for-decision';
import { evaluateMigrationRollbackEligibility, buildMigrationRollbackPreview } from '../../../library-health/migration-rollback-logic';
import { executeMigrationRollback, MigrationRollbackRefusedError } from '../../../library-health/migration-rollback-executor';
import { searchProviderCandidatesForSeries } from '../../../library-health/search-provider-candidates-for-series';
import { saveProviderIdentityDecision, reviewSeasonShrinkForDecision, NoDecisionToReviewError } from '../../../library-health/provider-identity-decisions-store';
import { BatchManifest } from '../../../library-health/batch-manifest-logic';
import { ProviderConfirmationPipelineReport } from '../../../library-health/provider-confirmation-pipeline-reports';
import {
  classifyBatchManifestEntry,
  classifySkippedBlockedEntry,
  correctProposedStatusForProtection,
  dedupeBySeriesId,
  deriveProposalReasonCode,
  fromManualReviewCandidate,
  MigrationWorkbenchCategory,
  MigrationWorkbenchItem,
} from './migration-workbench-logic';
import { MigrationWorkbenchItemDto } from './dto/migration-workbench-item.dto';
import { MigrationProposalDto } from './dto/migration-proposal.dto';
import { MigrationConfirmResultDto } from './dto/migration-confirm-result.dto';
import { MigrationHistoryItemDto } from './dto/migration-history-item.dto';
import { MigrationHistoryDetailDto } from './dto/migration-history-detail.dto';
import { MigrationRollbackPreviewDto, MigrationRollbackResultDto } from './dto/migration-rollback.dto';
import { ProviderCandidateDto, ProviderCandidateSearchResultDto } from './dto/provider-candidate.dto';
import { ConfirmIdentityDto } from './dto/confirm-identity.dto';

const LIBRARY_HEALTH_DIR = path.join(process.cwd(), 'library-health');
const BATCH_MANIFEST_PATH = path.join(LIBRARY_HEALTH_DIR, 'output', 'latest-batch-manifest.json');
const PIPELINE_REPORT_PATH = path.join(LIBRARY_HEALTH_DIR, 'output', 'latest-provider-confirmation-pipeline-report.json');
const DEFAULT_MAX_SEASON_ZERO_ORPHANS = 1;
// Same hourly cadence as EpisodeSyncSchedulerService's own tick — a series
// Pipeline B blocks this hour should, in the common case, be auto-resolved
// (if safe) or at least classified for Needs Attention (if not) well
// within the same day, not up to 24h later. Configurable for the same
// reason episode-sync-scheduler.service.ts's own interval is.
const DEFAULT_SWEEP_TICK_INTERVAL_MS = 60 * 60 * 1000;

function readJsonIfExists<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

@Injectable()
export class MigrationWorkbenchService {
  private readonly logger = new Logger(MigrationWorkbenchService.name);

  constructor(private readonly prisma: PrismaService) {}

  // The list view — mostly a read-only projection of the library-health CLI
  // pipeline's own periodically-regenerated reports (batch manifest +
  // pipeline report), never a live TMDb/TVmaze call for the bulk of items.
  // Same architectural choice this app already made for the DB-only Needs
  // Attention v1: a screen loaded on every app open must stay fast and
  // never burn API rate limit — a specific series' live, up-to-the-second
  // proposal is what getProposal() is for, triggered by an explicit user
  // tap. Because of this, the cached portion can be up to as stale as the
  // last CLI pipeline run — documented on the controller's @ApiOperation,
  // not hidden. invalidateStaleItems() below corrects the specific, common
  // ways that staleness is user-visibly WRONG (not just old) using cheap
  // DB-only checks, with a tightly bounded live recompute only for the
  // rarer case that genuinely needs one.
  //
  // ALSO merges in series the automatic scheduler has flagged live
  // (SeriesSyncStatus.lastRequiresManualReview) — a real gap found via a
  // real incident (a genuinely new, safe season sitting blocked with no
  // way for the user to ever find out short of asking): the cached report
  // above only ever covers Pipeline A's initial catalog-migration pass, it
  // has no way to know about a block Pipeline B's ongoing refresh produced
  // after that report was last generated. loadLiveBlockedItems reads that
  // signal directly, bounded the same way invalidateStaleItems already is.
  async list(userId: string): Promise<MigrationWorkbenchItemDto[]> {
    const manifest = readJsonIfExists<BatchManifest>(BATCH_MANIFEST_PATH);
    const report = readJsonIfExists<ProviderConfirmationPipelineReport>(PIPELINE_REPORT_PATH);

    const items: MigrationWorkbenchItem[] = [];
    if (manifest) {
      for (const entry of manifest.entries) items.push(classifyBatchManifestEntry(entry));
    }
    if (report) {
      for (const entry of report.skippedBlockedSeries) {
        const item = classifySkippedBlockedEntry(entry);
        if (item) items.push(item);
      }
      for (const candidate of report.nextManualReviewCandidates) items.push(fromManualReviewCandidate(candidate));
    }

    // loadLiveBlockedItems runs OUTSIDE invalidateStaleItems deliberately —
    // invalidateStaleItems' "a non-rolled-back MigrationHistory row means
    // fully resolved, drop it" rule is correct for the static-report cache
    // it was designed for (that cache only ever represents Pipeline A's
    // ONE-TIME migration proposal, so any completed migration really does
    // resolve it forever), but wrong here: a series can be legitimately
    // migrated once (its original identity confirmation) and later get
    // re-flagged by Pipeline B for a completely unrelated reason (a new
    // season). Real incident this caused before this reordering: Batman:
    // Caped Crusader has a real, non-rolled-back MigrationHistory row from
    // its original July confirmation — that alone was silently dropping
    // its brand new, unrelated live-blocked entry every time, even though
    // the new season it's actually blocked on was never applied.
    const liveBlockedItems = await this.loadLiveBlockedItems(userId, new Set(items.map((i) => i.seriesId)));

    if (items.length === 0 && liveBlockedItems.length === 0) return [];

    const seriesRows = await this.prisma.series.findMany({
      where: { id: { in: [...items, ...liveBlockedItems].map((i) => i.seriesId) } },
      select: { id: true, title: true, posterUrl: true },
    });
    const posterBySeriesId = new Map(seriesRows.map((s) => [s.id, s.posterUrl]));
    // Only series still present in THIS user's library — a stale report
    // referencing a since-deleted series is silently dropped rather than
    // surfaced as a broken item.
    const knownSeriesIds = new Set(seriesRows.map((s) => s.id));

    const invalidatedStaticItems = await this.invalidateStaleItems(
      userId,
      dedupeBySeriesId(items).filter((i) => knownSeriesIds.has(i.seriesId)),
    );

    const dedupedItems = dedupeBySeriesId([...invalidatedStaticItems, ...liveBlockedItems.filter((i) => knownSeriesIds.has(i.seriesId))]);

    return dedupedItems
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((i) => ({
        seriesId: i.seriesId,
        title: i.title,
        posterUrl: posterBySeriesId.get(i.seriesId) ?? null,
        category: i.category,
        reason: i.reason,
        proposal: i.proposal,
      }));
  }

  // How many series confirmed in the DB more recently than the last CLI
  // pipeline run must never turn every Workbench screen load into an
  // unbounded burst of live TMDb calls — bounds it to a small, human-paced
  // number. In practice this is the count of series someone confirmed via
  // "Find Provider" since the last CLI pipeline re-run, which is always a
  // handful, never hundreds.
  private static readonly MAX_LIVE_RECOMPUTE_PER_LIST = 10;

  // Corrects cache staleness against canonical DB state, without a second
  // classification engine. Two independent, cheap-first checks:
  //
  //   1. STALE_AFTER_SUCCESSFUL_MIGRATION — a non-rolled-back
  //      MigrationHistory row for this series means it is fully resolved,
  //      full stop, regardless of what category the cache says. Pure DB
  //      lookup, no live call, removes the item entirely. This is the
  //      "I already confirmed + migrated and it's still stuck in Needs
  //      Attention" bug.
  //
  //   2. STALE_AFTER_IDENTITY_CONFIRMATION — a NO_RELIABLE_PROVIDER item
  //      with a confirmed ProviderIdentityDecision (or already-matched
  //      ExternalIds) on file is a direct contradiction: that category
  //      means "no confirmed decision" by construction. Deliberately NOT
  //      gated on comparing the decision's timestamp against the cache's
  //      own generatedAt — a whole-library CLI pipeline run can take hours
  //      between when it captures that timestamp and when it actually
  //      writes a given series' entry, so the timestamp alone is not a
  //      reliable staleness signal. Recomputed live via getProposal() —
  //      the exact same canonical pipeline the explicit per-series tap
  //      already uses — never a parallel classification path. Bounded by
  //      MAX_LIVE_RECOMPUTE_PER_LIST; a recompute failure (e.g. missing
  //      TMDB_ACCESS_TOKEN, a transient network error) keeps the cached
  //      item rather than failing the whole list.
  private async invalidateStaleItems(userId: string, items: MigrationWorkbenchItem[]): Promise<MigrationWorkbenchItem[]> {
    if (items.length === 0) return items;
    const seriesIds = items.map((i) => i.seriesId);

    const [activeMigrations, decisions, matchedExternalIds] = await Promise.all([
      this.prisma.migrationHistory.findMany({ where: { userId, seriesId: { in: seriesIds }, rolledBackAt: null }, select: { seriesId: true } }),
      this.prisma.providerIdentityDecision.findMany({ where: { userId, seriesId: { in: seriesIds }, decision: 'confirm' }, select: { seriesId: true } }),
      this.prisma.externalIds.findMany({ where: { seriesId: { in: seriesIds }, provider: { not: null }, providerId: { not: null } }, select: { seriesId: true } }),
    ]);

    const migratedSeriesIds = new Set(activeMigrations.map((m) => m.seriesId));
    const confirmedSeriesIds = new Set([...decisions.map((d) => d.seriesId), ...matchedExternalIds.map((e) => e.seriesId)]);

    const result: MigrationWorkbenchItem[] = [];
    let recomputeBudget = MigrationWorkbenchService.MAX_LIVE_RECOMPUTE_PER_LIST;

    for (const item of items) {
      if (migratedSeriesIds.has(item.seriesId)) continue; // fully resolved — drop.

      const looksStale = item.category === 'NO_RELIABLE_PROVIDER' && confirmedSeriesIds.has(item.seriesId);
      if (!looksStale || recomputeBudget <= 0) {
        result.push(item);
        continue;
      }
      recomputeBudget--;

      try {
        const proposal = await this.getProposal(userId, item.seriesId);
        if (!proposal.eligible && proposal.reason.startsWith('already fully migrated')) continue; // resolved via a no-op recompute — drop.
        result.push({ seriesId: item.seriesId, title: item.title, category: proposal.category, reason: proposal.reason, proposal: proposal.proposal });
      } catch {
        result.push(item);
      }
    }

    return result;
  }

  // Loads series the automatic scheduler has flagged live
  // (SeriesSyncStatus.lastRequiresManualReview) that aren't already covered
  // by the cached CLI-report items above (excludeSeriesIds) — see list()'s
  // own doc comment for why this exists.
  //
  // Deliberately DB-only, no live getProposal()/TMDb call per item — a
  // first version called getProposal() live for every hit here (bounded to
  // 10), and a real production run of exactly that showed why it was
  // wrong: 10 sequential live TMDb classifications inside one GET request
  // that fires on every app load took ~4.5s and silently dropped every
  // single item (almost certainly TMDb's per-IP, not per-key, rate limit —
  // see docs/tmdb-enrichment-plan.md — tripped by the burst). This list
  // must stay exactly as fast and rate-limit-free as the cached-report path
  // above already is; deep, accurate classification (READY_AUTOMATIC vs.
  // NEEDS_EPISODE_REVIEW, etc.) already exists as its own live call and
  // belongs in exactly two places: the hourly sweepBlockedSeries() tick
  // (which runs a real getProposal() per series, but in the background, not
  // on a page load), and the explicit per-series tap-through
  // (GET :seriesId/proposal, one live call for one series a human just
  // asked about). By the time a user actually sees an item here, the sweep
  // has almost always already had a chance to auto-resolve anything
  // READY_AUTOMATIC — what's left is disproportionately likely to
  // genuinely need a human anyway, so a generic NEEDS_EPISODE_REVIEW-shaped
  // entry pointing at the series page is an honest, not misleading,
  // default; tapping into the real proposal screen still gets the precise,
  // live classification for that one series.
  private async loadLiveBlockedItems(userId: string, excludeSeriesIds: Set<string>): Promise<MigrationWorkbenchItem[]> {
    const blocked = await this.prisma.seriesSyncStatus.findMany({
      where: { lastRequiresManualReview: true, series: { progress: { some: { userId } } } },
      select: { seriesId: true, series: { select: { title: true } } },
    });

    const result: MigrationWorkbenchItem[] = [];
    for (const { seriesId, series } of blocked) {
      if (excludeSeriesIds.has(seriesId)) continue;
      result.push({
        seriesId,
        title: series.title,
        category: 'NEEDS_EPISODE_REVIEW',
        reason: 'An automatic catalog refresh found a change here that needs a quick look — open the series to review it.',
        proposal: null,
      });
    }

    return result;
  }

  // The other half of the fix (see list()'s doc comment): for every series
  // the scheduler has flagged live, ask the exact same question a human
  // opening Needs Attention and tapping "Confirm Migration" would get
  // answered — and if it comes back READY_AUTOMATIC (fully deterministic,
  // no orphans, nothing for a human to weigh in on), just apply it right
  // here, the same confirmMigration() a human tap would trigger. Anything
  // else is left flagged for loadLiveBlockedItems/list() to surface — this
  // never decides FOR a human, only ever skips asking one when there is
  // structurally nothing to ask.
  //
  // Runs on the same hourly cadence as EpisodeSyncSchedulerService's own
  // tick (DEFAULT_SWEEP_TICK_INTERVAL_MS) — see that file for why an
  // interval this fine-grained is cheap and correct to repeat often. Never
  // throws out of the tick itself; one series' failure is logged and never
  // blocks another's.
  @Interval(Number(process.env.MIGRATION_SWEEP_TICK_INTERVAL_MS) || DEFAULT_SWEEP_TICK_INTERVAL_MS)
  async handleSweepTick(): Promise<void> {
    if (!process.env.TMDB_ACCESS_TOKEN) return; // same guard EpisodeSyncSchedulerService's tick uses — nothing to do without it.
    const summary = await this.sweepBlockedSeries(DEV_USER_ID);
    if (summary.checked > 0) {
      this.logger.log(
        `[migration-workbench] sweep — checked=${summary.checked}, autoApplied=${summary.autoApplied}, alreadyResolved=${summary.alreadyResolved}, stillNeedsReview=${summary.stillNeedsReview}, errored=${summary.errored}`,
      );
    }
  }

  // Exposed separately from the @Interval handler so tests/an eventual
  // manual-trigger endpoint can invoke exactly this logic without waiting
  // for the interval — same "one implementation, multiple entry points"
  // posture as EpisodeSyncSchedulerService.runTick.
  async sweepBlockedSeries(userId: string): Promise<{ checked: number; autoApplied: number; alreadyResolved: number; stillNeedsReview: number; errored: number }> {
    const blocked = await this.prisma.seriesSyncStatus.findMany({
      where: { lastRequiresManualReview: true, series: { progress: { some: { userId } } } },
      select: { seriesId: true },
    });

    const summary = { checked: blocked.length, autoApplied: 0, alreadyResolved: 0, stillNeedsReview: 0, errored: 0 };

    // Sequential, not parallel — matches every other pipeline loop in this
    // codebase (run-apply-refresh.ts, episode-sync-scheduler.service.ts):
    // predictable TMDb request volume, one series' failure can never race
    // another's write.
    for (const { seriesId } of blocked) {
      try {
        const proposal = await this.getProposal(userId, seriesId);

        if (proposal.eligible && proposal.category === 'READY_AUTOMATIC') {
          await this.confirmMigration(userId, seriesId);
          // Cleared explicitly rather than waiting for the next episode-sync
          // tick to naturally recompute it (which would also work, since the
          // season/episodes just written mean that tick's own comparison no
          // longer sees a suspicious gap) — this closes the loop within this
          // same sweep instead of leaving a stale "still needs review" flag
          // visible for up to another hour.
          await this.prisma.seriesSyncStatus.update({ where: { seriesId }, data: { lastRequiresManualReview: false } });
          summary.autoApplied++;
        } else if (!proposal.eligible && proposal.reason.startsWith('already fully migrated')) {
          // Genuinely real case, not hypothetical: a series can already be
          // fully migrated (e.g. resolved manually, or by an earlier sweep
          // tick) while its SeriesSyncStatus flag is still stale — nothing
          // to apply, just clear the flag so it stops showing as blocked.
          await this.prisma.seriesSyncStatus.update({ where: { seriesId }, data: { lastRequiresManualReview: false } });
          summary.alreadyResolved++;
        } else {
          summary.stillNeedsReview++;
        }
      } catch (err) {
        summary.errored++;
        this.logger.error(`[migration-workbench] sweep failed for series ${seriesId}`, err as Error);
      }
    }

    return summary;
  }

  // "Find Provider" — a live TMDb search + score for one unresolved series,
  // reusing searchProviderCandidatesForSeries (the exact same search/
  // scoring/classification code the CLI's missing-provider-candidates
  // report uses). Never writes anything; never auto-selects a candidate —
  // classification.recommendedProviderId is a recommendation only, the
  // user always makes the explicit choice via confirmIdentity below.
  async searchCandidates(seriesId: string): Promise<ProviderCandidateSearchResultDto> {
    const series = await this.prisma.series.findUnique({
      where: { id: seriesId },
      include: { seasons: { include: { episodes: { include: { watches: true } } } } },
    });
    if (!series) throw new NotFoundException(`Series ${seriesId} not found`);

    const accessToken = process.env.TMDB_ACCESS_TOKEN;
    if (!accessToken) throw new BadRequestException('Server is missing TMDB_ACCESS_TOKEN — cannot search for provider candidates.');

    const localEpisodesPerSeason = series.seasons.sort((a, b) => a.seasonNumber - b.seasonNumber).map((s) => s.episodes.length);
    const watchedEpisodeCount = series.seasons.reduce((sum, s) => sum + s.episodes.filter((e) => e.watches.length > 0).length, 0);

    const { candidates, decision } = await searchProviderCandidatesForSeries({
      tmdb: new TmdbClient({ accessToken }),
      localTitle: series.title,
      localEpisodesPerSeason,
      watchedEpisodeCount,
    });

    return {
      seriesId,
      localTitle: series.title,
      candidates: candidates.map(toCandidateDto),
      classification: decision.classification,
      reason: decision.reason,
      recommendedProviderId: decision.recommendedCandidateTmdbId,
    };
  }

  // Persists the user's explicit choice as a ProviderIdentityDecision row
  // — the app's counterpart to hand-editing provider-confirmation-decisions.json.
  // Deliberately does NOT apply any migration: confirming identity only
  // moves the series out of NO_RELIABLE_PROVIDER; the user still reviews a
  // real proposal (GET /:seriesId/proposal) and explicitly confirms
  // migration afterward, exactly like every other confirmed series.
  async confirmIdentity(userId: string, seriesId: string, body: ConfirmIdentityDto): Promise<{ seriesId: string; saved: true }> {
    const series = await this.prisma.series.findUnique({ where: { id: seriesId } });
    if (!series) throw new NotFoundException(`Series ${seriesId} not found`);

    await saveProviderIdentityDecision(this.prisma, { userId, seriesId, provider: body.provider, providerId: body.providerId, confidence: body.confidence });
    return { seriesId, saved: true };
  }

  // A second, deliberately SEPARATE explicit action from confirmIdentity —
  // sets seasonShrinkReviewed on the existing decision, unlocking ONLY
  // classifyMigrationConfirmation's realSeasonShrinkDetected hard floor
  // (see provider-identity-decisions-store.ts::reviewSeasonShrinkForDecision).
  // Confirming identity must never automatically imply this; catalog
  // safety (orphan preservation, watched-mapping validation, PAUSED/DROPPED
  // protection) is completely unaffected either way. Requires a confirmed
  // identity to already exist.
  async reviewSeasonShrink(userId: string, seriesId: string): Promise<{ seriesId: string; reviewed: true }> {
    const series = await this.prisma.series.findUnique({ where: { id: seriesId } });
    if (!series) throw new NotFoundException(`Series ${seriesId} not found`);

    try {
      await reviewSeasonShrinkForDecision(this.prisma, userId, seriesId);
    } catch (err) {
      if (err instanceof NoDecisionToReviewError) throw new BadRequestException(err.message);
      throw err;
    }
    return { seriesId, reviewed: true };
  }

  // The single-series live proposal — always a fresh TMDb/TVmaze fetch
  // (reusing runProviderConfirmationForDecision, the exact same function
  // the CLI pipeline calls), never trusted from the cached list-view
  // report. Read-only: apply is always false here. Only reachable for a
  // series that already has a "confirm" decision recorded — identity
  // confirmation itself stays permanently human-owned via the
  // ProviderIdentityDecision table (via the CLI review workflow, or the
  // in-app provider-search flow — see ProviderConfirmationService); this
  // endpoint never invents one.
  async getProposal(userId: string, seriesId: string): Promise<MigrationProposalDto> {
    const series = await this.prisma.series.findUnique({ where: { id: seriesId } });
    if (!series) throw new NotFoundException(`Series ${seriesId} not found`);

    const { decision } = await findDecisionForSeries(this.prisma, userId, seriesId);
    if (!decision || decision.decision !== 'confirm') {
      const { reasonCode, availableActions } = deriveProposalReasonCode({ kind: 'no-decision' });
      return {
        seriesId,
        title: series.title,
        eligible: false,
        category: 'NO_RELIABLE_PROVIDER',
        reasonCode,
        availableActions,
        reason: decision
          ? `decision on file is "${decision.decision}", not "confirm" — no live proposal to compute.`
          : 'no confirmed provider match for this series — identity must be confirmed (via the in-app provider search, or the library-health CLI review workflow) before a migration proposal can be computed.',
        current: null,
        proposal: null,
      };
    }

    const accessToken = process.env.TMDB_ACCESS_TOKEN;
    if (!accessToken) throw new BadRequestException('Server is missing TMDB_ACCESS_TOKEN — cannot fetch a live provider proposal.');

    const prismaClient = this.prisma;
    const healthInputs = await loadSeriesHealthInputs(prismaClient, userId);
    const local = healthInputs.find((s) => s.title === decision.title);
    if (!local) throw new NotFoundException(`Series "${decision.title}" not found in this user's library.`);

    const outcome = await runProviderConfirmationForDecision({
      prisma: prismaClient,
      tmdb: new TmdbClient({ accessToken }),
      tvmaze: new TvMazeClient(),
      decision,
      healthInputs,
      userId,
      generatedAt: new Date(),
      apply: false,
      applyAutoSafeMigrations: false,
      maxSeasonZeroOrphans: DEFAULT_MAX_SEASON_ZERO_ORPHANS,
    });

    const currentUserStatus = local.progress?.userStatus ?? UserSeriesStatus.UNKNOWN;
    const current = { episodeCount: local.episodes.length, watchedCount: local.episodes.filter((e) => e.watched).length, userStatus: currentUserStatus };

    if (outcome.kind === 'dry-run-safe' || outcome.kind === 'applied') {
      const entry = outcome.entry;
      const category: MigrationWorkbenchCategory = entry.identityBand === 'HIGH_CONFIDENCE' && entry.preservedOrphanEpisodeCount === 0 ? 'READY_AUTOMATIC' : 'READY_FOR_CONFIRMATION';
      const { reasonCode, availableActions } = deriveProposalReasonCode({ kind: 'eligible' });
      return {
        seriesId,
        title: series.title,
        eligible: true,
        category,
        reasonCode,
        availableActions,
        reason: entry.autoMigrationEligibilityReason,
        current,
        proposal: {
          currentUserStatus,
          proposedUserStatus: correctProposedStatusForProtection(currentUserStatus, entry.userStatus.to as UserSeriesStatus),
          matchedWatchedEpisodeCount: entry.matchedWatchedCount,
          matchedTotalEpisodeCount: entry.matchedTotalCount,
          episodesToCreate: entry.episodesCreated,
          seasonsToCreate: entry.seasonsCreated,
          unmatchedWatchedOrphanCount: entry.preservedOrphanEpisodeCount,
          confidence: entry.identityBand === 'HIGH_CONFIDENCE' ? 'HIGH' : 'BORDERLINE',
        },
      };
    }

    if (outcome.kind === 'already-applied') {
      const { reasonCode, availableActions } = deriveProposalReasonCode({ kind: 'already-applied' });
      return { seriesId, title: series.title, eligible: false, category: 'READY_AUTOMATIC', reasonCode, availableActions, reason: 'already fully migrated — nothing left to propose.', current, proposal: null };
    }

    if (outcome.kind === 'blocked') {
      const category: MigrationWorkbenchCategory = outcome.entry.operatingClassification === 'REVIEW_ALIGNMENT' ? 'NEEDS_EPISODE_REVIEW' : 'NO_RELIABLE_PROVIDER';
      const { reasonCode, availableActions } = deriveProposalReasonCode({ kind: 'blocked', operatingClassification: outcome.entry.operatingClassification, reasonText: outcome.entry.reason });
      return { seriesId, title: series.title, eligible: false, category, reasonCode, availableActions, reason: outcome.entry.reason, current, proposal: null };
    }

    const { reasonCode, availableActions } = deriveProposalReasonCode({ kind: 'error' });
    return {
      seriesId,
      title: series.title,
      eligible: false,
      category: 'NO_RELIABLE_PROVIDER',
      reasonCode,
      availableActions,
      reason: 'reason' in outcome.entry ? outcome.entry.reason : outcome.entry.message,
      current,
      proposal: null,
    };
  }

  // Confirm Migration — a REAL write. Reuses runProviderConfirmationForDecision
  // with apply=true, applyAutoSafeMigrations=true, for exactly ONE series —
  // the identical transaction the CLI's --apply-safe-confirmed
  // --apply-auto-safe-migrations flags trigger for a whole decisions file,
  // scoped here to a single decision. Never invents its own write path.
  async confirmMigration(userId: string, seriesId: string): Promise<MigrationConfirmResultDto> {
    const series = await this.prisma.series.findUnique({ where: { id: seriesId } });
    if (!series) throw new NotFoundException(`Series ${seriesId} not found`);

    const { decision } = await findDecisionForSeries(this.prisma, userId, seriesId);
    if (!decision || decision.decision !== 'confirm') {
      throw new BadRequestException(`Series "${series.title}" has no confirmed provider match — cannot migrate.`);
    }

    const accessToken = process.env.TMDB_ACCESS_TOKEN;
    if (!accessToken) throw new BadRequestException('Server is missing TMDB_ACCESS_TOKEN — cannot perform a live migration.');

    const prismaClient = this.prisma;
    const healthInputs = await loadSeriesHealthInputs(prismaClient, userId);
    const local = healthInputs.find((s) => s.title === decision.title);
    if (!local) throw new NotFoundException(`Series "${decision.title}" not found in this user's library.`);

    const outcome = await runProviderConfirmationForDecision({
      prisma: prismaClient,
      tmdb: new TmdbClient({ accessToken }),
      tvmaze: new TvMazeClient(),
      decision,
      healthInputs,
      userId,
      generatedAt: new Date(),
      apply: true,
      applyAutoSafeMigrations: true,
      maxSeasonZeroOrphans: DEFAULT_MAX_SEASON_ZERO_ORPHANS,
    });

    if (outcome.kind === 'applied' || outcome.kind === 'already-applied') {
      // Same cleanup sweepBlockedSeries() does after its own confirmMigration()
      // call — without it, a series a human confirms directly here (rather
      // than via the sweep) keeps its stale live-blocked flag and never
      // leaves the Needs Attention list. updateMany (not update): this
      // series may have no SeriesSyncStatus row at all if it was never
      // touched by the episode-refresh scheduler.
      await this.prisma.seriesSyncStatus.updateMany({ where: { seriesId }, data: { lastRequiresManualReview: false } });
    }

    if (outcome.kind === 'applied') {
      return {
        seriesId,
        title: series.title,
        applied: true,
        finalUserStatus: outcome.entry.userStatus.to as UserSeriesStatus,
        episodesCreated: outcome.entry.episodesCreated,
        seasonsCreated: outcome.entry.seasonsCreated,
        verificationPassed: outcome.entry.verification.passed,
        message: 'Migration applied.',
      };
    }

    if (outcome.kind === 'already-applied') {
      const currentUserStatus = local.progress?.userStatus ?? UserSeriesStatus.UNKNOWN;
      return { seriesId, title: series.title, applied: false, finalUserStatus: currentUserStatus, episodesCreated: 0, seasonsCreated: [], verificationPassed: true, message: 'Already fully migrated — nothing to do.' };
    }

    const reason = outcome.kind === 'error' ? outcome.entry.message : outcome.kind === 'dry-run-safe' ? outcome.entry.autoMigrationEligibilityReason : outcome.entry.reason;
    throw new BadRequestException(`Cannot migrate "${series.title}": ${reason}`);
  }

  // --- Migration history / rollback --------------------------------------

  async listHistory(userId: string): Promise<MigrationHistoryItemDto[]> {
    const rows = await this.prisma.migrationHistory.findMany({ where: { userId }, orderBy: { appliedAt: 'desc' } });
    return rows.map((row) => toHistoryItemDto(row));
  }

  async getHistoryDetail(userId: string, migrationId: string): Promise<MigrationHistoryDetailDto> {
    const row = await this.findOwnedHistoryRow(userId, migrationId);
    return toHistoryDetailDto(row);
  }

  // Read-only — never writes, matches "rollback must always have: preview"
  // requirement. Live-re-checks eligibility every call (never trusts a
  // stale eligibility snapshot), exactly like the confirm-time re-check.
  async previewRollback(userId: string, migrationId: string): Promise<MigrationRollbackPreviewDto> {
    const row = await this.findOwnedHistoryRow(userId, migrationId);

    const episodesInsertedIds = row.episodesInsertedIds as string[];
    const watchedInsertedEpisodeIds =
      episodesInsertedIds.length > 0
        ? (await this.prisma.episodeWatch.findMany({ where: { episodeId: { in: episodesInsertedIds } }, select: { episodeId: true } })).map((w) => w.episodeId)
        : [];
    const liveProgress = await this.prisma.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId, seriesId: row.seriesId } } });

    const eligibility = evaluateMigrationRollbackEligibility({
      alreadyRolledBack: row.rolledBackAt !== null,
      episodesInsertedIds,
      watchedInsertedEpisodeIds,
      currentUserStatus: liveProgress?.userStatus ?? UserSeriesStatus.UNKNOWN,
      currentNextEpisodeId: liveProgress?.nextEpisodeId ?? null,
      userStatusAfter: row.userStatusAfter,
      nextEpisodeIdAfter: row.nextEpisodeIdAfter,
      userStatusBefore: row.userStatusBefore,
      nextEpisodeIdBefore: row.nextEpisodeIdBefore,
    });

    const preview = buildMigrationRollbackPreview({
      migrationId: row.id,
      eligibility,
      providerBefore: row.providerBefore as MigrationRollbackPreviewDto['wouldRestoreProvider'],
      userStatusBefore: row.userStatusBefore,
      nextEpisodeIdBefore: row.nextEpisodeIdBefore,
      episodesInsertedIds,
    });

    return preview;
  }

  // The real write — requires the caller to have already seen a preview
  // (enforced by the mobile UI's confirmation flow, not by this endpoint
  // itself, matching every other "confirm" action in this module); always
  // revalidates eligibility live, inside the transaction, rather than
  // trusting whatever the client's last preview call returned.
  async rollback(userId: string, migrationId: string): Promise<MigrationRollbackResultDto> {
    const row = await this.findOwnedHistoryRow(userId, migrationId);

    try {
      const result = await this.prisma.$transaction((tx) => executeMigrationRollback(tx, userId, row));
      return { migrationId: result.migrationId, rolledBack: true, episodesDeleted: result.episodesDeleted, providerRestored: result.providerRestored, progressRestored: result.progressRestored, message: 'Migration rolled back.' };
    } catch (err) {
      if (err instanceof MigrationRollbackRefusedError) {
        throw new BadRequestException(`Cannot roll back migration ${migrationId}: ${err.reasons.join(', ')}`);
      }
      throw err;
    }
  }

  // User-isolation guard, reused by history detail/preview/rollback — a
  // migrationId that exists but belongs to another user is reported as
  // NotFound, never as a permission error that would confirm its existence.
  private async findOwnedHistoryRow(userId: string, migrationId: string) {
    const row = await this.prisma.migrationHistory.findUnique({ where: { id: migrationId } });
    if (!row || row.userId !== userId) throw new NotFoundException(`Migration ${migrationId} not found`);
    return row;
  }
}

type ProviderRefJson = { provider: string | null; providerId: string | null; tmdbId: string | null } | null;

function toHistoryItemDto(row: MigrationHistory): MigrationHistoryItemDto {
  const episodesInsertedIds = row.episodesInsertedIds as string[];
  return {
    id: row.id,
    seriesId: row.seriesId,
    seriesTitle: row.seriesTitle,
    appliedAt: row.appliedAt.toISOString(),
    providerBefore: row.providerBefore as ProviderRefJson,
    providerAfter: row.providerAfter as Exclude<ProviderRefJson, null>,
    userStatusBefore: row.userStatusBefore,
    userStatusAfter: row.userStatusAfter,
    episodesInsertedCount: episodesInsertedIds.length,
    episodesUpdatedCount: (row.episodesUpdatedIds as string[]).length,
    verificationPassed: row.verificationPassed,
    rolledBack: row.rolledBackAt !== null,
    // A cheap, non-authoritative signal for the list view only — "has
    // anything reversible and hasn't already been rolled back." The real
    // eligibility (watched episodes, progress drift) is only ever
    // determined live by previewRollback/rollback.
    rollbackAvailable: row.rolledBackAt === null && (episodesInsertedIds.length > 0 || row.userStatusBefore !== row.userStatusAfter || row.nextEpisodeIdBefore !== row.nextEpisodeIdAfter),
  };
}

function toHistoryDetailDto(row: MigrationHistory): MigrationHistoryDetailDto {
  return {
    id: row.id,
    seriesId: row.seriesId,
    seriesTitle: row.seriesTitle,
    appliedAt: row.appliedAt.toISOString(),
    classification: row.classification,
    sourceCategory: row.sourceCategory,
    providerBefore: row.providerBefore as ProviderRefJson,
    providerAfter: row.providerAfter as Exclude<ProviderRefJson, null>,
    releaseStatusBefore: row.releaseStatusBefore,
    releaseStatusAfter: row.releaseStatusAfter,
    userStatusBefore: row.userStatusBefore,
    userStatusAfter: row.userStatusAfter,
    nextEpisodeIdBefore: row.nextEpisodeIdBefore,
    nextEpisodeIdAfter: row.nextEpisodeIdAfter,
    episodesInsertedCount: (row.episodesInsertedIds as string[]).length,
    episodesUpdatedCount: (row.episodesUpdatedIds as string[]).length,
    preservedOrphanEpisodeCount: (row.preservedOrphanEpisodeIds as string[]).length,
    watchedMappingCount: row.watchedMappingCount,
    verificationPassed: row.verificationPassed,
    verificationDetail: row.verificationDetail as string[],
    rolledBackAt: row.rolledBackAt?.toISOString() ?? null,
    rollbackReason: row.rollbackReason,
  };
}

function toCandidateDto(candidate: Awaited<ReturnType<typeof searchProviderCandidatesForSeries>>['candidates'][number]): ProviderCandidateDto {
  const explanationParts = [
    candidate.titleMatchType === 'exact' ? 'exact title match' : `${candidate.titleMatchType} title match`,
    candidate.yearMatchType === 'mismatch' ? 'year does not match' : `year match: ${candidate.yearMatchType}`,
  ];
  if (candidate.seasonStructureReason) explanationParts.push(candidate.seasonStructureReason);
  if (candidate.animeNumberingRiskDetected) explanationParts.push('flagged for anime/absolute-numbering risk');

  return {
    provider: candidate.provider,
    providerId: candidate.tmdbId,
    title: candidate.title,
    year: candidate.year,
    posterUrl: candidate.posterUrl,
    episodeCount: candidate.totalEpisodeCount,
    seasonCount: candidate.providerSeasonShape?.seasonCount ?? null,
    // Canonical 0..1 value — never candidate.confidenceScore (that field is
    // the internal 0-100 scoring scale, see SearchedProviderCandidate's doc
    // comment in search-provider-candidates-for-series.ts).
    confidenceScore: candidate.normalizedConfidence,
    titleMatchType: candidate.titleMatchType,
    yearMatchType: candidate.yearMatchType,
    explanation: explanationParts.join('; '),
    warnings: candidate.warnings,
  };
}
