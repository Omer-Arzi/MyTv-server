// Pure remapping of watch-next-decisions.json's mytvSeriesId/
// reviewedNextEpisodeId fields against a freshly-reconstructed database. No
// I/O — testable without a database. Same reasoning as
// tmdb-enrichment/remap-apply-plan.ts: a full database rebuild
// (re-import + re-enrichment) generates brand new Series/Episode UUIDs for
// the same titles/episodes, so a decisions file written before the rebuild
// points at rows that no longer exist.
//
// Series identity is remapped by exact title match (same as the TMDb plan
// remap). Episode identity can't be remapped by title (episodes don't have
// one) — it's remapped by (seriesId, seasonNumber, episodeNumber), using the
// season/episode number captured in watch-next-manual-review.json at review
// time. This changes ONLY which database row a decision points at; the
// decision itself (mark_caught_up/ignore_for_now/needs_mapping) and its
// reason are never touched — no new matching decision is made here.

export interface DecisionToRemap {
  mytvSeriesId: string;
  seriesTitle: string;
  category: string;
  decision: string;
  reason: string;
  reviewedUserStatus: string;
  reviewedNextEpisodeId: string;
}

export interface ReviewedEpisodePosition {
  seriesTitle: string;
  seasonNumber: number;
  episodeNumber: number;
}

export interface CurrentSeriesInfo {
  title: string;
  seriesId: string;
}

export interface CurrentEpisodeInfo {
  seriesId: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeId: string;
}

export interface RemapDecisionsResult<T extends DecisionToRemap> {
  decisions: T[];
  remappedSeriesIds: Array<{ title: string; oldSeriesId: string; newSeriesId: string }>;
  unmatchedSeriesTitles: string[];
  ambiguousSeriesTitles: string[];
  remappedEpisodeIds: Array<{ title: string; oldEpisodeId: string; newEpisodeId: string }>;
  // Only decisions with decision === "mark_caught_up" require a resolved
  // episode — others never read reviewedNextEpisodeId at apply time.
  unmatchedEpisodesForMarkCaughtUp: string[];
}

export function remapDecisions<T extends DecisionToRemap>(
  decisions: T[],
  currentSeries: CurrentSeriesInfo[],
  currentEpisodes: CurrentEpisodeInfo[],
  reviewedPositions: ReviewedEpisodePosition[],
): RemapDecisionsResult<T> {
  const seriesIdsByTitle = new Map<string, string[]>();
  for (const s of currentSeries) {
    const list = seriesIdsByTitle.get(s.title) ?? [];
    list.push(s.seriesId);
    seriesIdsByTitle.set(s.title, list);
  }

  const positionByTitle = new Map(reviewedPositions.map((p) => [p.seriesTitle, p]));

  const remappedSeriesIds: RemapDecisionsResult<T>['remappedSeriesIds'] = [];
  const unmatchedSeriesTitles: string[] = [];
  const ambiguousSeriesTitles: string[] = [];
  const remappedEpisodeIds: RemapDecisionsResult<T>['remappedEpisodeIds'] = [];
  const unmatchedEpisodesForMarkCaughtUp: string[] = [];

  const remapped = decisions.map((decision) => {
    const seriesMatches = seriesIdsByTitle.get(decision.seriesTitle) ?? [];

    if (seriesMatches.length === 0) {
      unmatchedSeriesTitles.push(decision.seriesTitle);
      return decision;
    }
    if (seriesMatches.length > 1) {
      ambiguousSeriesTitles.push(decision.seriesTitle);
      return decision;
    }

    const newSeriesId = seriesMatches[0];
    remappedSeriesIds.push({ title: decision.seriesTitle, oldSeriesId: decision.mytvSeriesId, newSeriesId });

    let newEpisodeId = decision.reviewedNextEpisodeId;
    const position = positionByTitle.get(decision.seriesTitle);
    const matchingEpisode = position
      ? currentEpisodes.find((e) => e.seriesId === newSeriesId && e.seasonNumber === position.seasonNumber && e.episodeNumber === position.episodeNumber)
      : undefined;

    if (matchingEpisode) {
      newEpisodeId = matchingEpisode.episodeId;
      remappedEpisodeIds.push({ title: decision.seriesTitle, oldEpisodeId: decision.reviewedNextEpisodeId, newEpisodeId });
    } else if (decision.decision === 'mark_caught_up') {
      unmatchedEpisodesForMarkCaughtUp.push(decision.seriesTitle);
    }

    return { ...decision, mytvSeriesId: newSeriesId, reviewedNextEpisodeId: newEpisodeId };
  });

  return {
    decisions: remapped,
    remappedSeriesIds,
    unmatchedSeriesTitles,
    ambiguousSeriesTitles,
    remappedEpisodeIds,
    unmatchedEpisodesForMarkCaughtUp,
  };
}
