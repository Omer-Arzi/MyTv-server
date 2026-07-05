// Builds the Watch Next manual-review dataset. Read-only against app
// tables — never writes to Series/Season/Episode/ExternalIds/
// UserSeriesProgress/EpisodeWatch. Reuses the exact same gating logic
// GET /me/watch-next uses (filterReleasedNextEpisodes) so "current live
// /me/watch-next output" here can never drift from what the endpoint
// actually returns, and cross-references the most recent
// secondary-provider-audit TVmaze report already on disk — no new TVmaze
// API calls are made by this script at all.

import { PrismaClient, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { filterReleasedNextEpisodes } from '../src/modules/me/me-query-helpers';
import { classifyWatchNextItem, WatchNextReviewCategory } from './classify';

export interface TvMazeAuditComparisonSlice {
  mytvSeriesId: string;
  tier: 'AUTO_MATCH' | 'NEEDS_REVIEW' | 'NO_MATCH';
  topCandidate: { tvmazeId: number; tvmazeTitle: string; tvmazeYear: number | null } | null;
  tvmazeRegularEpisodeCount: number | null;
  tvmazeProposedNextEpisodeLabel: string | null;
  tvmazeProposedNextEpisodeTitle: string | null;
  category: string;
  closeCompetitorDetected: boolean;
  isDuplicateTitleGroupMember: boolean;
}

export interface WatchNextReviewRow {
  seriesTitle: string;
  mytvSeriesId: string;
  userStatus: UserSeriesStatus;
  releaseStatus: ReleaseStatus;
  tmdbId: string | null;
  tvmazeCandidate: { tvmazeId: number; tvmazeTitle: string; tvmazeYear: number | null } | null;
  currentNextEpisode: {
    episodeId: string;
    seasonNumber: number;
    episodeNumber: number;
    title: string | null;
    airDate: string | null;
  };
  lastWatchedEpisode: {
    seasonNumber: number;
    episodeNumber: number;
    title: string | null;
    watchedAt: string;
  } | null;
  watchedEpisodeCount: number;
  mytvKnownEpisodeCount: number;
  tvmazeKnownEpisodeCount: number | null;
  tvmazeThinksCaughtUpByPosition: boolean;
  tvmazeNextEpisodeIsTBA: boolean;
  category: WatchNextReviewCategory;
  categoryReason: string;
}

const TBA_TITLE_PATTERN = /^\s*tba\s*$/i;

export async function buildWatchNextReview(prisma: PrismaClient, userId: string, tvmazeComparisons: TvMazeAuditComparisonSlice[]): Promise<WatchNextReviewRow[]> {
  const tvmazeBySeriesId = new Map(tvmazeComparisons.map((c) => [c.mytvSeriesId, c]));

  const progress = await prisma.userSeriesProgress.findMany({
    where: { userId, userStatus: UserSeriesStatus.WATCHING, nextEpisodeId: { not: null } },
    orderBy: { lastWatchedAt: 'desc' },
    include: {
      series: { include: { externalIds: true } },
      nextEpisode: { include: { season: true } },
    },
  });

  // Same gating GET /me/watch-next applies — see me-query-helpers.ts.
  const liveWatchNext = filterReleasedNextEpisodes(progress);

  const seriesIds = liveWatchNext.map((p) => p.seriesId);

  const [watchRows, episodeCountRows] = await Promise.all([
    prisma.episodeWatch.findMany({
      where: { userId, episode: { season: { seriesId: { in: seriesIds } } } },
      orderBy: { watchedAt: 'desc' },
      select: { watchedAt: true, episode: { select: { title: true, episodeNumber: true, season: { select: { seriesId: true, seasonNumber: true } } } } },
    }),
    prisma.episode.findMany({
      where: { season: { seriesId: { in: seriesIds } } },
      select: { season: { select: { seriesId: true } } },
    }),
  ]);

  const watchesBySeriesId = new Map<string, typeof watchRows>();
  for (const w of watchRows) {
    const seriesId = w.episode.season.seriesId;
    const list = watchesBySeriesId.get(seriesId) ?? [];
    list.push(w);
    watchesBySeriesId.set(seriesId, list);
  }

  const knownEpisodeCountBySeriesId = new Map<string, number>();
  for (const e of episodeCountRows) {
    const seriesId = e.season.seriesId;
    knownEpisodeCountBySeriesId.set(seriesId, (knownEpisodeCountBySeriesId.get(seriesId) ?? 0) + 1);
  }

  return liveWatchNext.map((p) => {
    const watches = watchesBySeriesId.get(p.seriesId) ?? [];
    const lastWatch = watches[0]; // already ordered desc by watchedAt
    const watchedEpisodeCount = watches.length;
    const mytvKnownEpisodeCount = knownEpisodeCountBySeriesId.get(p.seriesId) ?? 0;

    const tvmaze = tvmazeBySeriesId.get(p.seriesId) ?? null;
    const hasSecondaryProviderMatch = tvmaze !== null && tvmaze.tier !== 'NO_MATCH' && tvmaze.topCandidate !== null;
    const tvmazeThinksCaughtUpByPosition = hasSecondaryProviderMatch && tvmaze!.tvmazeRegularEpisodeCount !== null && tvmaze!.tvmazeProposedNextEpisodeLabel === null;
    const tvmazeNextEpisodeIsTBA = hasSecondaryProviderMatch && TBA_TITLE_PATTERN.test(tvmaze!.tvmazeProposedNextEpisodeTitle ?? '');
    const isRemakeCollision = hasSecondaryProviderMatch && (tvmaze!.category === 'POSSIBLE_REMAKE_COLLISION' || tvmaze!.closeCompetitorDetected || tvmaze!.isDuplicateTitleGroupMember);

    const { category, reason } = classifyWatchNextItem({
      hasTmdbMatch: p.series.externalIds?.tmdbId != null,
      hasSecondaryProviderMatch,
      isRemakeCollision,
      tvmazeThinksCaughtUpByPosition,
      tvmazeNextEpisodeIsTBA,
      mytvKnownEpisodeCount,
      tvmazeKnownEpisodeCount: hasSecondaryProviderMatch ? tvmaze!.tvmazeRegularEpisodeCount : null,
    });

    return {
      seriesTitle: p.series.title,
      mytvSeriesId: p.seriesId,
      userStatus: p.userStatus,
      releaseStatus: p.series.releaseStatus,
      tmdbId: p.series.externalIds?.tmdbId ?? null,
      tvmazeCandidate: hasSecondaryProviderMatch ? tvmaze!.topCandidate : null,
      currentNextEpisode: {
        episodeId: p.nextEpisode!.id,
        seasonNumber: p.nextEpisode!.season.seasonNumber,
        episodeNumber: p.nextEpisode!.episodeNumber,
        title: p.nextEpisode!.title,
        airDate: p.nextEpisode!.airDate?.toISOString() ?? null,
      },
      lastWatchedEpisode: lastWatch
        ? {
            seasonNumber: lastWatch.episode.season.seasonNumber,
            episodeNumber: lastWatch.episode.episodeNumber,
            title: lastWatch.episode.title,
            watchedAt: lastWatch.watchedAt.toISOString(),
          }
        : null,
      watchedEpisodeCount,
      mytvKnownEpisodeCount,
      tvmazeKnownEpisodeCount: hasSecondaryProviderMatch ? tvmaze!.tvmazeRegularEpisodeCount : null,
      tvmazeThinksCaughtUpByPosition,
      tvmazeNextEpisodeIsTBA,
      category,
      categoryReason: reason,
    };
  });
}
