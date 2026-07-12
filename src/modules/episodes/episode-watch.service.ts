import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { UserSeriesStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { toEpisodeSummary, toSeriesSummary } from '../../common/mappers';
import { deriveUserStatusFromNextEpisode } from '../../common/derive-user-status';
import { isEpisodeReleased } from '../../common/is-episode-released';
import { checkWatchAllAllowed, planWatchAll, recomputeProgressAfterWatchAll } from '../../common/watch-all-logic';
import { checkUnwatchAllowed, recomputeProgressAfterUnwatch } from '../../common/unwatch-logic';
import { findFirstUnwatchedEpisodeId, OrderedEpisodeForNextLookup } from '../series/series-query-helpers';
import { MarkWatchedResponseDto } from './dto/mark-watched-response.dto';
import { EpisodeWatchDto } from './dto/episode-watch.dto';
import { WatchAllRequestDto } from './dto/watch-all-request.dto';
import { WatchAllResponseDto } from './dto/watch-all-response.dto';
import { UnwatchEpisodeResponseDto } from './dto/unwatch-episode-response.dto';

@Injectable()
export class EpisodeWatchService {
  constructor(private readonly prisma: PrismaService) {}

  async markWatched(userId: string, episodeId: string): Promise<MarkWatchedResponseDto> {
    const episode = await this.prisma.episode.findUnique({
      where: { id: episodeId },
      include: { season: { include: { series: true } } },
    });
    if (!episode) {
      throw new NotFoundException(`Episode ${episodeId} not found`);
    }

    // Server-side enforcement of Watch Next's "released episodes only"
    // contract, not just a UI convenience — this is the regular single-
    // episode "mark watched" flow (POST /episodes/:episodeId/watch), the
    // one reachable from a Watch Next card tap or a series-detail episode
    // row. A not-yet-released episode is rejected here before any
    // EpisodeWatch row is created or progress is touched. Reuses the same
    // canonical isEpisodeReleased predicate every other release-date
    // decision in this app already uses — no separate rule.
    //
    // Deliberately does NOT apply to import (import-tvtime/normalize-watched-episodes.ts
    // writes EpisodeWatch directly via its own upsertEpisodeWatch, never
    // through this method) — that path is recording real historical watch
    // events, not a live "watch next" action, and must stay unaffected.
    if (!isEpisodeReleased(episode.airDate)) {
      throw new BadRequestException(
        `Episode ${episodeId} has not been released yet (airDate: ${episode.airDate?.toISOString() ?? 'unknown'}) — it cannot be marked watched`,
      );
    }

    const seriesId = episode.season.seriesId;

    const watch = await this.prisma.episodeWatch.upsert({
      where: { userId_episodeId: { userId, episodeId } },
      create: { userId, episodeId },
      update: { watchedAt: new Date() },
      include: { note: true },
    });

    const nextEpisode = await this.findNextEpisode(userId, seriesId);

    // A fresh watch is the strongest signal available — always overwrite
    // userStatus (clears any prior WATCHLIST/PAUSED/DROPPED without a
    // separate "resume" step) rather than only filling it in on create.
    // See docs/status-model-plan.md §6.
    const userStatus = deriveUserStatusFromNextEpisode(!!nextEpisode, episode.season.series.releaseStatus);

    await this.prisma.userSeriesProgress.upsert({
      where: { userId_seriesId: { userId, seriesId } },
      create: {
        userId,
        seriesId,
        lastWatchedAt: watch.watchedAt,
        nextEpisodeId: nextEpisode?.id ?? null,
        userStatus,
      },
      update: {
        lastWatchedAt: watch.watchedAt,
        nextEpisodeId: nextEpisode?.id ?? null,
        userStatus,
      },
    });

    return {
      watch: {
        id: watch.id,
        watchedAt: watch.watchedAt,
        note: watch.note?.text ?? null,
        episode: toEpisodeSummary(episode),
      },
      series: toSeriesSummary(episode.season.series),
      nextEpisode: nextEpisode ? toEpisodeSummary(nextEpisode) : null,
      seriesCompleted: !nextEpisode,
      userStatus,
    };
  }

  async addNote(userId: string, watchId: string, text: string): Promise<EpisodeWatchDto> {
    const watch = await this.prisma.episodeWatch.findUnique({
      where: { id: watchId },
      include: { episode: { include: { season: true } } },
    });
    if (!watch || watch.userId !== userId) {
      throw new NotFoundException(`Episode watch ${watchId} not found`);
    }

    const note = await this.prisma.episodeNote.upsert({
      where: { episodeWatchId: watchId },
      create: { episodeWatchId: watchId, text },
      update: { text },
    });

    return {
      id: watch.id,
      watchedAt: watch.watchedAt,
      note: note.text,
      episode: toEpisodeSummary(watch.episode),
    };
  }

  // DELETE /episode-watches/:watchId — the inverse of markWatched, mainly
  // to undo a mis-tap/mis-swipe from the series-detail episode list (see
  // API_CONTRACT.md's former "Planned: undo" section). Deliberately
  // "recompute, don't snapshot": nextEpisodeId/userStatus/lastWatchedAt are
  // all re-derived from whatever watch state remains after the removal,
  // never rolled back to whatever they happened to be a moment ago — a
  // second watch could have already changed them since (e.g. a rapid
  // double-mark then undoing only the second one).
  async unwatchEpisode(userId: string, watchId: string, force: boolean): Promise<UnwatchEpisodeResponseDto> {
    const watch = await this.prisma.episodeWatch.findUnique({
      where: { id: watchId },
      include: { note: true, episode: { include: { season: true } } },
    });
    if (!watch || watch.userId !== userId) {
      throw new NotFoundException(`Episode watch ${watchId} not found`);
    }

    const episodeId = watch.episodeId;
    const seriesId = watch.episode.season.seriesId;

    // Ratings/emotions are keyed by (userId, episodeId), not by watchId —
    // they are NOT cascade-deleted with the watch (only EpisodeNote is).
    // Still gated behind force: see checkUnwatchAllowed's comment for why.
    const [rating, emotion] = await Promise.all([
      this.prisma.episodeRating.findUnique({ where: { userId_episodeId: { userId, episodeId } } }),
      this.prisma.episodeEmotion.findFirst({ where: { userId, episodeId } }),
    ]);

    const allowed = checkUnwatchAllowed({
      hasNote: !!watch.note,
      hasRating: !!rating,
      hasEmotion: !!emotion,
      force,
    });
    if (!allowed.allowed) {
      throw new BadRequestException(allowed.reason);
    }

    const series = await this.prisma.series.findUnique({ where: { id: seriesId }, select: { releaseStatus: true } });
    if (!series) {
      throw new NotFoundException(`Series ${seriesId} not found`);
    }

    const progress = await this.prisma.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId, seriesId } } });
    const previousUserStatus = progress?.userStatus ?? UserSeriesStatus.UNKNOWN;
    const previousNextEpisodeId = progress?.nextEpisodeId ?? null;

    const result = await this.prisma.$transaction(async (tx) => {
      // Cascades the EpisodeWatch's EpisodeNote (if any) automatically —
      // already accounted for by the note/force gate above.
      await tx.episodeWatch.delete({ where: { id: watchId } });

      const [episodes, remainingWatches, mostRecentRemainingWatch] = await Promise.all([
        tx.episode.findMany({
          where: { season: { seriesId } },
          orderBy: [{ season: { seasonNumber: 'asc' } }, { episodeNumber: 'asc' }],
          select: { id: true, airDate: true, season: { select: { seasonNumber: true } } },
        }),
        tx.episodeWatch.findMany({ where: { userId, episode: { season: { seriesId } } }, select: { episodeId: true } }),
        tx.episodeWatch.findFirst({
          where: { userId, episode: { season: { seriesId } } },
          orderBy: { watchedAt: 'desc' },
          select: { watchedAt: true },
        }),
      ]);
      const orderedEpisodes: OrderedEpisodeForNextLookup[] = episodes.map((e) => ({ id: e.id, airDate: e.airDate, seasonNumber: e.season.seasonNumber }));

      const watchedEpisodeIdsAfterRemoval = new Set(remainingWatches.map((w) => w.episodeId));

      const recompute = recomputeProgressAfterUnwatch({
        releaseStatus: series.releaseStatus,
        currentUserStatus: previousUserStatus,
        orderedEpisodes,
        watchedEpisodeIdsAfterRemoval,
      });

      const newUserStatus = recompute.statusPreserved ? previousUserStatus : recompute.computedUserStatus;
      const newNextEpisodeId = recompute.statusPreserved ? previousNextEpisodeId : recompute.computedNextEpisodeId;
      const newLastWatchedAt = mostRecentRemainingWatch?.watchedAt ?? null;

      await tx.userSeriesProgress.upsert({
        where: { userId_seriesId: { userId, seriesId } },
        create: { userId, seriesId, lastWatchedAt: newLastWatchedAt, nextEpisodeId: newNextEpisodeId, userStatus: newUserStatus },
        update: { lastWatchedAt: newLastWatchedAt, nextEpisodeId: newNextEpisodeId, userStatus: newUserStatus },
      });

      return { newUserStatus, newNextEpisodeId, hasRemainingReleasedUnwatched: recompute.hasRemainingReleasedUnwatched, statusPreserved: recompute.statusPreserved };
    });

    return {
      episodeId,
      seriesId,
      removedWatchId: watchId,
      previousUserStatus,
      newUserStatus: result.newUserStatus,
      previousNextEpisodeId,
      newNextEpisodeId: result.newNextEpisodeId,
      hasRemainingReleasedUnwatched: result.hasRemainingReleasedUnwatched,
      warning: result.statusPreserved
        ? `userStatus is ${previousUserStatus} (user-controlled) — preserved rather than recomputed; nextEpisodeId left unchanged too`
        : undefined,
    };
  }

  // Next episode is the first released, not-yet-watched episode in
  // (seasonNumber, episodeNumber) order for this user — the same "first
  // gap" semantics as PATCH /series/:seriesId/status
  // (series-query-helpers.ts's findFirstUnwatchedEpisodeId, reused here
  // rather than reimplemented a third time).
  //
  // This used to just look for "the episode immediately after the one
  // being marked," with no check against what's actually been watched.
  // That regresses out-of-order watching: skipping S1E2 to watch S1E3
  // permanently hid S1E2 from Watch Next, and later watching the skipped
  // S1E2 would compute S1E3 as "next" again even though it was already
  // watched, overwriting nextEpisodeId with an already-watched episode.
  private async findNextEpisode(userId: string, seriesId: string) {
    const [episodes, watches] = await Promise.all([
      this.prisma.episode.findMany({
        where: { season: { seriesId } },
        orderBy: [{ season: { seasonNumber: 'asc' } }, { episodeNumber: 'asc' }],
        select: { id: true, airDate: true, season: { select: { seasonNumber: true } } },
      }),
      this.prisma.episodeWatch.findMany({ where: { userId, episode: { season: { seriesId } } }, select: { episodeId: true } }),
    ]);

    const orderedEpisodes: OrderedEpisodeForNextLookup[] = episodes.map((e) => ({ id: e.id, airDate: e.airDate, seasonNumber: e.season.seasonNumber }));
    const watchedEpisodeIds = new Set(watches.map((w) => w.episodeId));
    const nextEpisodeId = findFirstUnwatchedEpisodeId(orderedEpisodes, watchedEpisodeIds);
    if (!nextEpisodeId) return null;

    return this.prisma.episode.findUnique({ where: { id: nextEpisodeId }, include: { season: true } });
  }

  // POST /seasons/:seasonId/watch-all — manual escape hatch for provider-
  // numbering/duplicate-episode issues (docs/episode-numbering-and-season-shift-risk.md):
  // marks every released episode IN THIS SEASON as watched, without
  // resolving the underlying numbering mismatch. Scoped to one season, but
  // still recomputes nextEpisodeId/userStatus against the whole series —
  // marking one season watched can still leave later seasons with more to
  // watch.
  async markSeasonWatched(userId: string, seasonId: string, options: WatchAllRequestDto): Promise<WatchAllResponseDto> {
    const season = await this.prisma.season.findUnique({
      where: { id: seasonId },
      select: { seriesId: true, episodes: { select: { id: true } } },
    });
    if (!season) {
      throw new NotFoundException(`Season ${seasonId} not found`);
    }

    return this.markEpisodesWatched(
      userId,
      season.seriesId,
      season.episodes.map((e) => e.id),
      options,
    );
  }

  // POST /series/:seriesId/watch-all-released — same escape hatch, scoped
  // to every episode in the series rather than one season.
  async markSeriesReleasedWatched(userId: string, seriesId: string, options: WatchAllRequestDto): Promise<WatchAllResponseDto> {
    const series = await this.prisma.series.findUnique({ where: { id: seriesId }, select: { id: true } });
    if (!series) {
      throw new NotFoundException(`Series ${seriesId} not found`);
    }

    const allEpisodes = await this.prisma.episode.findMany({ where: { season: { seriesId } }, select: { id: true } });

    return this.markEpisodesWatched(
      userId,
      seriesId,
      allEpisodes.map((e) => e.id),
      options,
    );
  }

  // Shared core for both endpoints above. Always computes the exact same
  // plan whether or not this is a dry run — dryRun only skips the actual
  // writes at the end, so the report and the real apply can never disagree
  // (same principle tmdb-enrichment/apply-plan.ts's planCandidateUpdate
  // already established for this codebase).
  private async markEpisodesWatched(userId: string, seriesId: string, targetEpisodeIds: string[], options: WatchAllRequestDto): Promise<WatchAllResponseDto> {
    const series = await this.prisma.series.findUnique({ where: { id: seriesId }, select: { releaseStatus: true } });
    if (!series) {
      throw new NotFoundException(`Series ${seriesId} not found`);
    }

    const progress = await this.prisma.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId, seriesId } } });
    const previousUserStatus = progress?.userStatus ?? UserSeriesStatus.UNKNOWN;
    const previousNextEpisodeId = progress?.nextEpisodeId ?? null;

    const allowed = checkWatchAllAllowed({ currentUserStatus: previousUserStatus, force: !!options.force });
    if (!allowed.allowed) {
      throw new BadRequestException(allowed.reason);
    }

    const [targetEpisodes, allSeriesEpisodesRaw, existingWatches] = await Promise.all([
      this.prisma.episode.findMany({ where: { id: { in: targetEpisodeIds } }, select: { id: true, airDate: true } }),
      this.prisma.episode.findMany({
        where: { season: { seriesId } },
        orderBy: [{ season: { seasonNumber: 'asc' } }, { episodeNumber: 'asc' }],
        select: { id: true, airDate: true, season: { select: { seasonNumber: true } } },
      }),
      this.prisma.episodeWatch.findMany({ where: { userId, episode: { season: { seriesId } } }, select: { episodeId: true } }),
    ]);
    const allSeriesEpisodes: OrderedEpisodeForNextLookup[] = allSeriesEpisodesRaw.map((e) => ({ id: e.id, airDate: e.airDate, seasonNumber: e.season.seasonNumber }));

    const existingWatchedIds = new Set(existingWatches.map((w) => w.episodeId));

    const plan = planWatchAll(
      targetEpisodes.map((e) => ({ id: e.id, airDate: e.airDate, alreadyWatched: existingWatchedIds.has(e.id) })),
      { includeUnknownAirDate: !!options.includeUnknownAirDate },
    );

    // Full post-action watched set, used only to recompute
    // nextEpisodeId/userStatus against the WHOLE series — never re-derives
    // "released" using includeUnknownAirDate (see watch-all-logic.ts).
    const watchedIdsAfterAction = new Set([...existingWatchedIds, ...plan.toCreate]);
    const { nextEpisodeId: newNextEpisodeId, userStatus: newUserStatus } = recomputeProgressAfterWatchAll({
      releaseStatus: series.releaseStatus,
      orderedEpisodes: allSeriesEpisodes,
      watchedEpisodeIds: watchedIdsAfterAction,
    });

    const dryRun = !!options.dryRun;

    if (!dryRun && plan.toCreate.length > 0) {
      const now = new Date();
      await this.prisma.$transaction(async (tx) => {
        await tx.episodeWatch.createMany({
          data: plan.toCreate.map((episodeId) => ({ userId, episodeId, watchedAt: now })),
        });
        await tx.userSeriesProgress.upsert({
          where: { userId_seriesId: { userId, seriesId } },
          create: { userId, seriesId, lastWatchedAt: now, nextEpisodeId: newNextEpisodeId, userStatus: newUserStatus },
          update: { lastWatchedAt: now, nextEpisodeId: newNextEpisodeId, userStatus: newUserStatus },
        });
      });
    } else if (!dryRun) {
      // Nothing new to watch, but the recomputed next-episode/status may
      // still differ from what's stored (e.g. this action didn't create any
      // watches but the series had drifted) — keep it in sync regardless.
      await this.prisma.userSeriesProgress.upsert({
        where: { userId_seriesId: { userId, seriesId } },
        create: { userId, seriesId, nextEpisodeId: newNextEpisodeId, userStatus: newUserStatus },
        update: { nextEpisodeId: newNextEpisodeId, userStatus: newUserStatus },
      });
    }

    return {
      episodesConsidered: targetEpisodes.length,
      episodesAlreadyWatched: plan.alreadyWatched.length,
      watchesCreated: plan.toCreate.length,
      episodesSkippedFuture: plan.skippedFuture.length,
      episodesSkippedUnknownAirDate: plan.skippedUnknownAirDate.length,
      previousUserStatus,
      newUserStatus,
      previousNextEpisodeId,
      newNextEpisodeId,
      dryRun,
    };
  }
}
