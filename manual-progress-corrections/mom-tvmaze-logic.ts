// Pure logic for the targeted, single-series Mom TVmaze enrichment +
// progress correction. No I/O, no Prisma — testable without a network or
// database, same pattern as every other *-logic.ts module in this repo.

export interface ExpectedTvMazeMatch {
  name: string;
  network: string;
  premieredYear: number;
  status: string;
}

export interface TvMazeCandidateShow {
  name: string;
  network: string | null;
  premiered: string | null; // "YYYY-MM-DD"
  status: string | null;
}

export interface MatchValidationResult {
  valid: boolean;
  reasons: string[];
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

// Exact-match validation against the user's manual confirmation — no fuzzy
// scoring. This series was hand-confirmed by the user (title/network/
// premiered year/status), so the only job here is to verify the live TVmaze
// fetch actually returned that exact show, not some other "Mom".
export function validateTvMazeShowMatch(candidate: TvMazeCandidateShow, expected: ExpectedTvMazeMatch): MatchValidationResult {
  const reasons: string[] = [];

  if (normalize(candidate.name) !== normalize(expected.name)) {
    reasons.push(`name "${candidate.name}" does not exactly match expected "${expected.name}"`);
  }
  if (!candidate.network || normalize(candidate.network) !== normalize(expected.network)) {
    reasons.push(`network "${candidate.network ?? 'null'}" does not exactly match expected "${expected.network}"`);
  }
  const candidateYear = candidate.premiered ? Number(candidate.premiered.slice(0, 4)) : null;
  if (candidateYear !== expected.premieredYear) {
    reasons.push(`premiered year ${candidateYear ?? 'unknown'} does not match expected ${expected.premieredYear}`);
  }
  if (!candidate.status || normalize(candidate.status) !== normalize(expected.status)) {
    reasons.push(`status "${candidate.status ?? 'null'}" does not match expected "${expected.status}"`);
  }

  return { valid: reasons.length === 0, reasons };
}

export interface SeasonEpisodeRef {
  seasonNumber: number;
  episodeNumber: number;
}

// Whether `a` is at or before `b` in (season, episode) order.
export function isAtOrBefore(a: SeasonEpisodeRef, b: SeasonEpisodeRef): boolean {
  if (a.seasonNumber !== b.seasonNumber) return a.seasonNumber < b.seasonNumber;
  return a.episodeNumber <= b.episodeNumber;
}

export function findEpisodeBySeasonEpisode<T extends SeasonEpisodeRef>(episodes: T[], seasonNumber: number, episodeNumber: number): T | null {
  return episodes.find((e) => e.seasonNumber === seasonNumber && e.episodeNumber === episodeNumber) ?? null;
}

// Strips TVmaze's simple HTML-formatted `summary` field (typically
// "<p>...</p>") down to plain text. A minimal, non-parsing tag stripper —
// sufficient for TVmaze's simple episode-summary markup, not a general HTML
// sanitizer.
export function stripHtml(html: string | null): string | null {
  if (!html) return null;
  const text = html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : null;
}

export function parseTvMazeDate(dateStr: string | null): Date | null {
  if (!dateStr) return null;
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface TvMazeEpisodeForPlan extends SeasonEpisodeRef {
  tvMazeId: number;
  title: string | null;
  overview: string | null;
  airDate: Date | null;
  runtimeMinutes: number | null;
}

export interface LocalEpisodeForPlan extends SeasonEpisodeRef {
  id: string;
}

export interface MergedEpisodeRow extends TvMazeEpisodeForPlan {
  localEpisodeId: string | null; // null if this episode does not exist locally yet
  isWatched: boolean; // only meaningful when localEpisodeId !== null
}

// Cross-references TVmaze's full episode list against the local catalog and
// existing watches — the single merged view every other plan function reads
// from, so there's only one place that decides "does this episode already
// exist locally / is it already watched."
export function buildMergedEpisodeRows(
  tvMazeEpisodes: TvMazeEpisodeForPlan[],
  localEpisodes: LocalEpisodeForPlan[],
  watchedLocalEpisodeIds: ReadonlySet<string>,
): MergedEpisodeRow[] {
  return tvMazeEpisodes.map((ep) => {
    const local = findEpisodeBySeasonEpisode(localEpisodes, ep.seasonNumber, ep.episodeNumber);
    return {
      ...ep,
      localEpisodeId: local?.id ?? null,
      isWatched: local ? watchedLocalEpisodeIds.has(local.id) : false,
    };
  });
}

export interface MomEnrichmentPlan {
  toCreate: MergedEpisodeRow[]; // missing locally — full catalog completion, not cutoff-limited
  alreadyExists: MergedEpisodeRow[]; // already present locally, left untouched
  toMarkWatched: MergedEpisodeRow[]; // at/before cutoff, not yet watched
  alreadyWatchedAtOrBeforeCutoff: MergedEpisodeRow[]; // at/before cutoff, already watched — untouched
  afterCutoffUnwatched: MergedEpisodeRow[]; // after cutoff — must never be marked watched by this plan
}

// The full plan: which episodes need creating (to complete the catalog,
// regardless of cutoff), and which need a new EpisodeWatch row (only ever
// at or before the cutoff — the user's confirmed "watched through" point).
// Episodes after the cutoff are created (if missing) but deliberately never
// touched by the watch side of this plan.
export function planMomEnrichment(mergedRows: MergedEpisodeRow[], cutoff: SeasonEpisodeRef): MomEnrichmentPlan {
  return {
    toCreate: mergedRows.filter((r) => r.localEpisodeId === null),
    alreadyExists: mergedRows.filter((r) => r.localEpisodeId !== null),
    toMarkWatched: mergedRows.filter((r) => isAtOrBefore(r, cutoff) && !r.isWatched),
    alreadyWatchedAtOrBeforeCutoff: mergedRows.filter((r) => isAtOrBefore(r, cutoff) && r.isWatched),
    afterCutoffUnwatched: mergedRows.filter((r) => !isAtOrBefore(r, cutoff) && !r.isWatched),
  };
}

export interface AbortCheckInput {
  localSeriesMatchCount: number; // must be exactly 1
  showMatchValidation: MatchValidationResult;
  nextEpisodeFoundInTvMaze: boolean; // false if the desired next episode (S5E14) wasn't found
}

export interface AbortCheckResult {
  shouldAbort: boolean;
  reasons: string[];
}

// Every hard-stop condition this task specifies, combined into one check —
// a single place that decides whether it's safe to proceed at all, checked
// identically in both dry-run and apply mode.
export function checkAbortConditions(input: AbortCheckInput): AbortCheckResult {
  const reasons: string[] = [];

  if (input.localSeriesMatchCount !== 1) {
    reasons.push(`local series match is ambiguous or missing: found ${input.localSeriesMatchCount} series titled "Mom" locally (expected exactly 1)`);
  }
  if (!input.showMatchValidation.valid) {
    reasons.push(...input.showMatchValidation.reasons.map((r) => `TVmaze show match failed: ${r}`));
  }
  if (!input.nextEpisodeFoundInTvMaze) {
    reasons.push('desired next episode (S5E14) was not found in the fetched TVmaze episode catalog');
  }

  return { shouldAbort: reasons.length > 0, reasons };
}
