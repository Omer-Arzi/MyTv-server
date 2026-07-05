// Pure, read-only decision logic for the Watch Next accuracy audit
// (watch-next-audit/run-audit.ts). No Prisma calls, no I/O — same pattern as
// next-episode-backfill/derive-next-episode.ts and
// tmdb-enrichment/data-quality.ts, which this reuses ideas from rather than
// reinventing (overwatch ratio, long-running-episode threshold).
//
// This only ever categorizes and reports; it never decides to write
// anything. See docs referenced in run-audit.ts for what each category means
// in terms of a proposed (not applied) fix.

export type AirDateBucket = 'FUTURE' | 'TODAY' | 'PAST' | 'NULL';

// Calendar-day comparison (not exact-instant) — an episode airing "today" at
// any time of day should read as TODAY, not FUTURE just because the airDate
// timestamp is later in the day than `now`.
export function classifyAirDate(airDate: Date | null, now: Date = new Date()): AirDateBucket {
  if (!airDate) return 'NULL';
  const a = Date.UTC(airDate.getUTCFullYear(), airDate.getUTCMonth(), airDate.getUTCDate());
  const n = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (a > n) return 'FUTURE';
  if (a === n) return 'TODAY';
  return 'PAST';
}

export type WatchNextIssueCategory =
  | 'FUTURE_EPISODE_IN_WATCH_NEXT'
  | 'NULL_AIRDATE_IN_WATCH_NEXT'
  | 'INCOMPLETE_CATALOG'
  | 'WATCHED_COUNT_EXCEEDS_KNOWN_EPISODES'
  | 'POSSIBLE_SEASON_NUMBERING_MISMATCH'
  | 'POSSIBLE_SPECIALS_OR_SEASON_ZERO_MISMATCH'
  | 'POSSIBLE_REMAKE_OR_DUPLICATE_TITLE'
  | 'SAFE';

// Same ratio tmdb-enrichment/data-quality.ts's detectRemakeCollision uses:
// a *meaningfully* over-watched count (not just one or two ahead, which is
// usually TMDb lagging a newly-aired episode or a missed special) is the
// signature of a wrong-catalog match, not ordinary drift.
export const REMAKE_OVERWATCH_RATIO = 1.3;
// Same threshold as tmdb-enrichment/scoring.ts's LONG_RUNNING_EPISODE_THRESHOLD
// — this dataset skews heavily toward long-running anime, exactly where
// absolute-vs-per-season numbering conventions most often disagree.
export const LONG_RUNNING_EPISODE_THRESHOLD = 100;

export interface WatchNextCandidateInput {
  airDate: Date | null;
  hasFullCatalog: boolean;
  watchedEpisodeCount: number;
  knownEpisodeCount: number;
  // Distinct real (non-special) season numbers known for this series —
  // caller's job to exclude season 0, since that's checked separately.
  distinctKnownSeasonCount: number;
  hasSeasonZeroEpisodes: boolean;
  isDuplicateTitleGroupMember: boolean;
  now?: Date;
}

export interface WatchNextCandidateResult {
  category: WatchNextIssueCategory;
  reasons: string[];
  airDateBucket: AirDateBucket;
}

// Priority-ordered, mutually exclusive — each candidate gets exactly one
// category, checked from most to least severe/certain. A row can technically
// match more than one condition (e.g. an incomplete catalog that's also
// over-watched); the earlier check wins because it's the more actionable
// explanation.
export function categorizeWatchNextCandidate(input: WatchNextCandidateInput): WatchNextCandidateResult {
  const now = input.now ?? new Date();
  const airDateBucket = classifyAirDate(input.airDate, now);
  const reasons: string[] = [];

  if (airDateBucket === 'FUTURE') {
    reasons.push(`next episode airDate (${input.airDate!.toISOString()}) is in the future`);
    return { category: 'FUTURE_EPISODE_IN_WATCH_NEXT', reasons, airDateBucket };
  }

  if (airDateBucket === 'NULL') {
    reasons.push('next episode has no known airDate — cannot confirm it has actually released');
    return { category: 'NULL_AIRDATE_IN_WATCH_NEXT', reasons, airDateBucket };
  }

  if (!input.hasFullCatalog) {
    reasons.push('series has no confirmed TMDb match (ExternalIds.tmdbId is null) — episode catalog may be incomplete');
    return { category: 'INCOMPLETE_CATALOG', reasons, airDateBucket };
  }

  const overwatchRatio = input.knownEpisodeCount > 0 ? input.watchedEpisodeCount / input.knownEpisodeCount : Infinity;
  if (input.isDuplicateTitleGroupMember || overwatchRatio > REMAKE_OVERWATCH_RATIO) {
    reasons.push(
      input.isDuplicateTitleGroupMember
        ? 'series title collides with another MyTv series of the same bare title — see duplicateTitleGroups in the report'
        : `watched ${input.watchedEpisodeCount} episodes vs ${input.knownEpisodeCount} known (${overwatchRatio.toFixed(2)}x) — likely matched to the wrong catalog (remake/reboot)`,
    );
    return { category: 'POSSIBLE_REMAKE_OR_DUPLICATE_TITLE', reasons, airDateBucket };
  }

  if (input.watchedEpisodeCount > input.knownEpisodeCount) {
    reasons.push(`watched ${input.watchedEpisodeCount} episodes but only ${input.knownEpisodeCount} known — catalog is likely missing recent episodes`);
    return { category: 'WATCHED_COUNT_EXCEEDS_KNOWN_EPISODES', reasons, airDateBucket };
  }

  if (input.distinctKnownSeasonCount <= 1 && input.knownEpisodeCount >= LONG_RUNNING_EPISODE_THRESHOLD) {
    reasons.push(`${input.knownEpisodeCount} known episodes all in a single season — likely absolute vs per-season numbering mismatch (common for long-running anime)`);
    return { category: 'POSSIBLE_SEASON_NUMBERING_MISMATCH', reasons, airDateBucket };
  }

  if (input.hasSeasonZeroEpisodes) {
    reasons.push('series has season 0 (specials) episodes — specials/season-count conventions often differ between TV Time and TMDb');
    return { category: 'POSSIBLE_SPECIALS_OR_SEASON_ZERO_MISMATCH', reasons, airDateBucket };
  }

  reasons.push('passed all checks');
  return { category: 'SAFE', reasons, airDateBucket };
}
