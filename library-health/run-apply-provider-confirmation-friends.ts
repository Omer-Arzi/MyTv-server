// Friends + TVmaze 431 — a single, narrowly-scoped apply script for the one
// case library-health:provider-confirmation-dry-run confirmed
// SAFE_TO_APPLY_LATER. This is deliberately NOT a general apply pipeline —
// every check in apply-friends-tvmaze-logic.ts's validateFriendsTvmazeApply
// is hardcoded to this exact title/provider/id, and refuses to run against
// anything else, or even against Friends itself if reality has drifted
// since this was reviewed (season/episode counts, orphaned watches,
// classification — all re-checked fresh, never trusted from a stale
// report).
//
// Default mode is DRY RUN: it always fetches fresh data, re-runs the same
// classification pipeline library-health:provider-confirmation-dry-run
// uses, builds the exact write plan, and prints/reports it — without
// touching the database. Real writes only happen when
// --apply-friends-tvmaze-431 is passed AND the guard passes, and even then
// only ever: upserts ONE ExternalIds row, updates existing Episode rows'
// metadata fields (never creates/deletes any), sets Series.posterUrl only
// if currently null, and upserts ONE UserSeriesProgress row — all inside a
// single transaction. Never deletes an Episode or EpisodeWatch row, never
// overwrites EpisodeWatch.watchedAt, never touches any other series.

import 'dotenv/config';
import path from 'path';
import { PrismaClient, UserSeriesStatus } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { TvMazeClient, TvMazeRequestError } from '../secondary-provider-audit/tvmaze-client';
import { TvMazeEpisode } from '../secondary-provider-audit/tvmaze-types';
import { extractTitleYearHint } from '../trakt-enrichment/scoring';
import { compareSeriesCatalog, LocalEpisodeInput, ProviderEpisodeInput } from '../episode-release-refresh/refresh-logic';
import { decideUserStatusUpdate } from '../tmdb-enrichment/apply-plan-writes';
import { buildSeasonShape } from '../tmdb-enrichment/season-structure-tiebreak';
import { checkTitleYearSanity, classifyProviderConfirmationDryRun } from './provider-confirmation-decisions-logic';
import { checkBenignSeasonZeroOrphan, detectRealSeasonShrink, findOrphanedWatchedEpisodes } from './season-zero-orphan-logic';
import { buildFriendsApplyPlan, FRIENDS_TARGET, LocalEpisodeForApply, ProviderEpisodeForApply, validateFriendsTvmazeApply } from './apply-friends-tvmaze-logic';
import { buildFriendsApplyMarkdownReport, buildFriendsApplyReport, writeFriendsApplyReports } from './apply-friends-tvmaze-reports';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');
const APPLY_FLAG = '--apply-friends-tvmaze-431';

interface CliOptions {
  userId: string;
  outDir: string;
  apply: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('--apply') && !argv.includes(APPLY_FLAG)) {
    console.log(`Note: bare --apply is not the trigger for this script. Re-run with ${APPLY_FLAG} to actually write. Continuing as dry-run.`);
  }

  const options: CliOptions = { userId: DEV_USER_ID, outDir: DEFAULT_OUT_DIR, apply: argv.includes(APPLY_FLAG) };
  for (const arg of argv) {
    if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
  }
  return options;
}

function mapTvmazeStatusToReleaseStatus(status: string | null): 'RETURNING' | 'ENDED' | 'IN_PRODUCTION' | 'UNKNOWN' {
  if (!status) return 'UNKNOWN';
  switch (status.toLowerCase()) {
    case 'running':
      return 'RETURNING';
    case 'ended':
      return 'ENDED';
    case 'to be determined':
    case 'in development':
      return 'IN_PRODUCTION';
    default:
      return 'UNKNOWN';
  }
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

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const prisma = new PrismaClient();
  const tvmaze = new TvMazeClient();
  const generatedAt = new Date();

  console.log(`Friends + TVmaze 431 apply — mode: ${options.apply ? 'APPLY (writes will happen if the guard passes)' : 'DRY RUN (no writes)'}`);
  console.log(`  target user: ${options.userId}`);

  const series = await prisma.series.findFirst({
    where: { title: FRIENDS_TARGET.title },
    select: { id: true, title: true, releaseStatus: true, posterUrl: true, backdropUrl: true, externalIds: { select: { tmdbId: true } } },
  });

  if (!series) {
    console.error(`No local series titled exactly "${FRIENDS_TARGET.title}" was found — refusing to proceed.`);
    await prisma.$disconnect();
    process.exit(1);
  }

  const progress = await prisma.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId: options.userId, seriesId: series.id } } });
  const fullLocalEpisodes = await loadFullLocalEpisodes(prisma, options.userId, series.id);

  const localSeasonNumbers = [...new Set(fullLocalEpisodes.map((e) => e.seasonNumber))];
  const localShape = buildSeasonShape(
    localSeasonNumbers.sort((a, b) => a - b).map((sn) => fullLocalEpisodes.filter((e) => e.seasonNumber === sn).length),
  );
  const watchedEpisodeCount = fullLocalEpisodes.filter((e) => e.watched).length;

  // --- Fetch TVmaze candidate 431 fresh — never trust a prior report. ----
  let show;
  try {
    show = await tvmaze.getShowWithEpisodes(FRIENDS_TARGET.providerId);
  } catch (err) {
    const message = err instanceof TvMazeRequestError ? err.message : (err as Error).message;
    console.error(`Failed to fetch TVmaze show ${FRIENDS_TARGET.providerId}: ${message} — refusing to proceed.`);
    await prisma.$disconnect();
    process.exit(1);
  }

  const rawTvmazeEpisodes: TvMazeEpisode[] = show._embedded?.episodes ?? [];
  const providerEpisodesForCompare: ProviderEpisodeInput[] = rawTvmazeEpisodes
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
  const providerSeasonNumbers = [...new Set(providerEpisodesForCompare.map((e) => e.seasonNumber))];
  const providerShape = buildSeasonShape(providerSeasonNumbers.sort((a, b) => a - b).map((sn) => providerEpisodesForCompare.filter((e) => e.seasonNumber === sn).length));

  // --- Re-run the exact same classification pipeline the dry-run report
  // uses, fresh, right now — this IS "run the dry-run logic first." -------
  const hint = extractTitleYearHint(series.title);
  const candidateYear = show.premiered ? Number(show.premiered.slice(0, 4)) : null;
  const sanity = checkTitleYearSanity({ localTitle: series.title, candidateTitle: show.name, candidateYear });

  const comparison = compareSeriesCatalog({
    localEpisodes: fullLocalEpisodes,
    providerEpisodes: providerEpisodesForCompare,
    currentReleaseStatus: series.releaseStatus,
    providerReleaseStatus: mapTvmazeStatusToReleaseStatus(show.status) as typeof series.releaseStatus,
    currentUserStatus: progress?.userStatus ?? UserSeriesStatus.UNKNOWN,
    currentNextEpisodeId: progress?.nextEpisodeId ?? null,
    now: generatedAt,
  });

  const orphanedWatchedEpisodes = findOrphanedWatchedEpisodes(fullLocalEpisodes, providerEpisodesForCompare);
  const realSeasonShrinkDetected = detectRealSeasonShrink(fullLocalEpisodes, providerEpisodesForCompare);
  const seasonZeroOrphanCheck = checkBenignSeasonZeroOrphan({
    localTitle: series.title,
    orphanedWatchedEpisodes,
    realSeasonShrinkDetected,
  });

  const dryRunDecision = classifyProviderConfirmationDryRun({ titleYearSanity: sanity, comparison, seasonZeroOrphanCheck });

  console.log(`  fresh dry-run classification: ${dryRunDecision.classification}`);
  console.log(`  ${dryRunDecision.reason}`);

  // --- Hard guard: every one of the task's 8 checks, re-verified now. ----
  const guard = validateFriendsTvmazeApply({
    localTitle: series.title,
    provider: FRIENDS_TARGET.provider,
    providerId: FRIENDS_TARGET.providerId,
    dryRunClassification: dryRunDecision.classification,
    localSeasonCount: localShape.seasonCount,
    providerSeasonCount: providerShape.seasonCount,
    localEpisodeCount: localShape.totalEpisodeCount,
    providerEpisodeCount: providerShape.totalEpisodeCount,
    orphanedWatchedEpisodeCount: orphanedWatchedEpisodes.length,
  });

  if (!guard.allowed) {
    console.log('\nGuard REFUSED to allow this apply:');
    for (const v of guard.violations) console.log(`  - ${v}`);
  } else {
    console.log('\nGuard passed — every hard safety check cleared.');
  }

  // --- Build the plan (always — this is the dry-run preview even when
  // not applying, and the exact same plan that would be executed). -------
  const localEpisodesForApply: LocalEpisodeForApply[] = fullLocalEpisodes.map((e) => ({
    id: e.id,
    seasonNumber: e.seasonNumber,
    episodeNumber: e.episodeNumber,
    title: e.title,
    overview: e.overview,
    airDate: e.airDate ? e.airDate.toISOString() : null,
    runtimeMinutes: e.runtimeMinutes,
  }));
  const providerEpisodesForApply: ProviderEpisodeForApply[] = rawTvmazeEpisodes
    .filter((ep) => ep.number !== null)
    .map((ep) => ({
      seasonNumber: ep.season,
      episodeNumber: ep.number as number,
      title: ep.name ?? null,
      overviewHtml: ep.summary ?? null,
      airDate: ep.airdate ? new Date(ep.airdate).toISOString() : null,
      runtimeMinutes: ep.runtime ?? null,
    }));
  const providerPosterUrl = show.image?.original ?? show.image?.medium ?? null;

  const plan = guard.allowed
    ? buildFriendsApplyPlan({
        userId: options.userId,
        seriesId: series.id,
        currentPosterUrl: series.posterUrl,
        providerPosterUrl,
        localEpisodes: localEpisodesForApply,
        providerEpisodes: providerEpisodesForApply,
        proposedUserStatus: comparison.proposedUserStatus,
        proposedNextEpisodeId: comparison.proposedNextEpisodeId,
      })
    : null;

  console.log('\nPlan:');
  console.log(JSON.stringify(plan, null, 2));

  let applied = false;
  let outcome: string;

  if (!guard.allowed) {
    outcome = 'Not applied — guard refused (see violations above/in the report).';
  } else if (!options.apply) {
    outcome = `Dry run only — guard passed and a plan was built, but ${APPLY_FLAG} was not passed, so nothing was written.`;
  } else if (!plan) {
    outcome = 'Not applied — no plan was built despite the guard passing (unexpected; treated as unsafe).';
  } else {
    console.log(`\n${APPLY_FLAG} passed and guard is allowed — applying now in a single transaction...`);
    await prisma.$transaction(async (tx) => {
      await tx.externalIds.upsert({
        where: { seriesId: plan.externalIdsUpdate.seriesId },
        create: { seriesId: plan.externalIdsUpdate.seriesId, provider: plan.externalIdsUpdate.provider, providerId: plan.externalIdsUpdate.providerId, matchSource: 'library-health:apply-friends-tvmaze', matchConfidence: 1, matchedAt: generatedAt },
        update: { provider: plan.externalIdsUpdate.provider, providerId: plan.externalIdsUpdate.providerId, matchSource: 'library-health:apply-friends-tvmaze', matchConfidence: 1, matchedAt: generatedAt },
      });

      if (plan.posterUpdate) {
        await tx.series.update({ where: { id: series.id }, data: { posterUrl: plan.posterUpdate.to } });
      }

      for (const update of plan.episodeUpdates) {
        const data: Record<string, unknown> = {};
        if (update.changes.title !== undefined) data.title = update.changes.title;
        if (update.changes.overview !== undefined) data.overview = update.changes.overview;
        if (update.changes.airDate !== undefined) data.airDate = new Date(update.changes.airDate);
        if (update.changes.runtimeMinutes !== undefined) data.runtimeMinutes = update.changes.runtimeMinutes;
        if (Object.keys(data).length === 0) continue;
        await tx.episode.update({ where: { id: update.episodeId }, data });
      }

      // Same protected-status re-check the real tmdb-enrichment apply
      // step already uses — re-reads the LIVE status inside the
      // transaction rather than trusting the snapshot read earlier.
      const liveProgress = await tx.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId: options.userId, seriesId: series.id } } });
      const liveStatus = liveProgress?.userStatus ?? UserSeriesStatus.UNKNOWN;
      const statusDecision = decideUserStatusUpdate(liveStatus, plan.progressUpdate.userStatus as UserSeriesStatus);

      await tx.userSeriesProgress.upsert({
        where: { userId_seriesId: { userId: options.userId, seriesId: series.id } },
        create: {
          userId: options.userId,
          seriesId: series.id,
          userStatus: statusDecision.shouldUpdate ? (plan.progressUpdate.userStatus as UserSeriesStatus) : liveStatus,
          nextEpisodeId: plan.progressUpdate.nextEpisodeId,
        },
        update: {
          userStatus: statusDecision.shouldUpdate ? (plan.progressUpdate.userStatus as UserSeriesStatus) : undefined,
          nextEpisodeId: plan.progressUpdate.nextEpisodeId,
        },
      });
    });

    applied = true;
    outcome = 'Applied successfully in a single transaction.';
    console.log(`\n${outcome}`);
  }

  const report = buildFriendsApplyReport({
    generatedAt,
    applied,
    targetUserId: options.userId,
    guard,
    dryRunClassification: dryRunDecision.classification,
    plan,
    outcome,
  });
  const markdown = buildFriendsApplyMarkdownReport(report);
  const written = writeFriendsApplyReports(options.outDir, report, markdown);

  console.log(`\nReports written:`);
  console.log(`  ${written.latestJsonPath}`);
  console.log(`  ${written.latestMarkdownPath}`);
  console.log(`  ${written.archivedJsonPath}`);
  console.log(`  ${written.archivedMarkdownPath}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
