export type TrackingV2RowKind = 'watch' | 'rewatch' | 'user-series' | 'unknown';

export interface ParseIssue {
  sourceRowNumber: number;
  message: string;
}

// A single "this episode was watched" or "this episode was rewatched" event,
// parsed from one tracking-prod-records-v2.csv row (key prefix
// watch-episode-/rewatch-episode-).
export interface WatchEvent {
  sourceRowNumber: number;
  seriesName: string;
  seasonNumber: number;
  episodeNumber: number;
  tvtimeShowId: string | null;
  tvtimeEpisodeId: string | null;
  watchedAt: Date;
  isRewatch: boolean;
  bulkType: string | null;
  runtimeMinutes: number | null;
  tvtimeUserId: string;
}

// One row per (series, season, episode) after grouping all WatchEvents for
// that episode — this is what becomes a single EpisodeWatch.
export interface EpisodeWatchAggregate {
  seriesName: string;
  seasonNumber: number;
  episodeNumber: number;
  tvtimeShowId: string | null;
  tvtimeEpisodeId: string | null;
  watchedAt: Date;
  watchDateApproximate: boolean;
  rewatchCount: number;
  runtimeMinutes: number | null;
  contributingRowNumbers: number[];
}

// A user-series-* row: per-series follow/watchlist/progress snapshot.
export interface UserSeriesRow {
  sourceRowNumber: number;
  seriesName: string;
  tvtimeShowId: string | null;
  isFollowed: boolean;
  isForLater: boolean;
  isArchived: boolean;
  epWatchCount: number | null;
  followedAt: Date | null;
  updatedAt: Date | null;
  tvtimeUserId: string;
}

export interface TrackingV2ParseResult {
  watchEvents: WatchEvent[];
  userSeriesRows: UserSeriesRow[];
  issues: ParseIssue[];
}

export type ImportIssueSeverityInput = 'INFO' | 'WARNING' | 'ERROR';

// Mirrors the ImportIssue Prisma model — used both to write DB rows and to
// serialize needs-review.json, so the two never drift apart.
export interface ImportIssueInput {
  severity: ImportIssueSeverityInput;
  sourceFile?: string;
  sourceRowNumber?: number;
  relatedEntityType?: string;
  relatedEntityId?: string;
  message: string;
}
