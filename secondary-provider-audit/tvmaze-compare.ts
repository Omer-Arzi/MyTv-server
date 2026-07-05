// Pure comparison/categorization logic for cross-checking a MyTv series'
// existing (TMDb-based, possibly absent) state against a TVmaze candidate.
// No I/O — testable without a network or database, same pattern as every
// other *-enrichment scoring/data-quality module in this repo.

export type ProviderComparisonCategory =
  | 'TMDB_LOOKS_CORRECT'
  | 'TVMAZE_LOOKS_BETTER'
  | 'BOTH_AGREE'
  | 'BOTH_UNCERTAIN'
  | 'POSSIBLE_REMAKE_COLLISION'
  | 'POSSIBLE_ANIME_NUMBERING_MISMATCH'
  | 'POSSIBLE_SPECIALS_MISMATCH'
  | 'WATCHED_COUNT_EXCEEDS_PROVIDER_CATALOG'
  | 'NO_GOOD_MATCH';

export type TvMazeTier = 'AUTO_MATCH' | 'NEEDS_REVIEW' | 'NO_MATCH';

export interface ComparisonInput {
  hasTmdbMatch: boolean;
  // MyTv's own known episode count — mirrors TMDb's catalog once matched,
  // or is just whatever TV Time imported when unmatched.
  mytvKnownEpisodeCount: number;
  watchedEpisodeCount: number;
  tvmazeTier: TvMazeTier;
  tvmazeRegularEpisodeCount: number;
  // Total including significant_special/insignificant_special, from the
  // dedicated /shows/:id/episodes?specials=1 call — null when that call
  // wasn't made (e.g. NO_MATCH, no candidate to check).
  tvmazeEpisodeCountIncludingSpecials: number | null;
  animeNumberingRiskDetected: boolean;
  closeCompetitorDetected: boolean;
  isDuplicateTitleGroupMember: boolean;
  // Preview-only signal from tvmaze-scoring.ts's evaluateStructuralAutoMatch
  // — true when the real (conservative) tier is NEEDS_REVIEW only because
  // an unknown year hint capped the absolute score, but every other signal
  // (exact title, top result, no competitor/anime risk, watched count
  // matches) qualifies. Used here ONLY to decide TVMAZE_LOOKS_BETTER/
  // BOTH_AGREE vs BOTH_UNCERTAIN — never changes what tier is reported.
  structuralAutoMatchProposed: boolean;
}

export interface ComparisonResult {
  category: ProviderComparisonCategory;
  reasons: string[];
}

// Same ratio-based tolerance idea used throughout this repo's enrichment
// tooling: small deltas are normal drift (a missed special, TVmaze lagging a
// newly-aired episode), not a real disagreement.
const EPISODE_COUNT_AGREEMENT_TOLERANCE = 2;
// A specials-inclusive count more than this many episodes above the
// regular-only count is enough of a gap to flag — otherwise almost every
// show would trip this (nearly all have at least one clip-show or recap).
const SPECIALS_COUNT_DELTA_THRESHOLD = 3;

export function categorizeComparison(input: ComparisonInput): ComparisonResult {
  const reasons: string[] = [];

  if (input.tvmazeTier === 'NO_MATCH' && !input.hasTmdbMatch) {
    reasons.push('neither TMDb nor TVmaze has a confident match for this series');
    return { category: 'NO_GOOD_MATCH', reasons };
  }

  if (input.closeCompetitorDetected || input.isDuplicateTitleGroupMember) {
    reasons.push(
      input.isDuplicateTitleGroupMember
        ? 'series title collides with another MyTv series of the same bare title'
        : 'TVmaze search returned a same-titled or near-identical-scoring competitor — likely a remake/reboot ambiguity',
    );
    return { category: 'POSSIBLE_REMAKE_COLLISION', reasons };
  }

  if (input.tvmazeTier !== 'NO_MATCH' && input.watchedEpisodeCount > input.tvmazeRegularEpisodeCount) {
    reasons.push(`watched ${input.watchedEpisodeCount} episodes but TVmaze's candidate only has ${input.tvmazeRegularEpisodeCount} regular episodes known`);
    return { category: 'WATCHED_COUNT_EXCEEDS_PROVIDER_CATALOG', reasons };
  }

  if (input.animeNumberingRiskDetected) {
    reasons.push('long-running (100+ episode) anime — absolute vs per-season numbering conventions commonly disagree between TMDb, TVmaze, and TV Time');
    return { category: 'POSSIBLE_ANIME_NUMBERING_MISMATCH', reasons };
  }

  if (
    input.tvmazeEpisodeCountIncludingSpecials !== null &&
    input.tvmazeEpisodeCountIncludingSpecials - input.tvmazeRegularEpisodeCount >= SPECIALS_COUNT_DELTA_THRESHOLD
  ) {
    reasons.push(
      `TVmaze reports ${input.tvmazeEpisodeCountIncludingSpecials - input.tvmazeRegularEpisodeCount} additional special episodes beyond the ${input.tvmazeRegularEpisodeCount} regular ones — specials/season-count conventions likely differ from TV Time/TMDb`,
    );
    return { category: 'POSSIBLE_SPECIALS_MISMATCH', reasons };
  }

  // A structurally-proposed AUTO_MATCH counts as confident for this
  // decision only (never for the reported tier itself) — see
  // ComparisonInput.structuralAutoMatchProposed's doc comment.
  const tvmazeConfident = input.tvmazeTier === 'AUTO_MATCH' || input.structuralAutoMatchProposed;

  if (!input.hasTmdbMatch && tvmazeConfident) {
    reasons.push(
      input.tvmazeTier === 'AUTO_MATCH'
        ? 'TVmaze found a confident match; MyTv has no confirmed TMDb match yet'
        : 'TVmaze\'s structural rule proposes a confident match (exact title, top result, episode count matches); MyTv has no confirmed TMDb match yet',
    );
    return { category: 'TVMAZE_LOOKS_BETTER', reasons };
  }

  if (input.hasTmdbMatch && !tvmazeConfident) {
    reasons.push('MyTv already has a confirmed TMDb match; TVmaze was inconclusive');
    return { category: 'TMDB_LOOKS_CORRECT', reasons };
  }

  if (input.hasTmdbMatch && tvmazeConfident) {
    const delta = Math.abs(input.mytvKnownEpisodeCount - input.tvmazeRegularEpisodeCount);
    if (delta <= EPISODE_COUNT_AGREEMENT_TOLERANCE) {
      reasons.push(`both providers agree: MyTv knows ${input.mytvKnownEpisodeCount} episodes, TVmaze's confident match has ${input.tvmazeRegularEpisodeCount}`);
      return { category: 'BOTH_AGREE', reasons };
    }
    reasons.push(`both providers matched confidently but disagree on episode count: MyTv ${input.mytvKnownEpisodeCount} vs TVmaze ${input.tvmazeRegularEpisodeCount}`);
    return { category: 'BOTH_UNCERTAIN', reasons };
  }

  // !hasTmdbMatch && !tvmazeConfident — the only remaining combination:
  // neither source is confident enough to trust on its own.
  reasons.push('TVmaze match needs review and MyTv has no confirmed TMDb match — neither source is confident');
  return { category: 'BOTH_UNCERTAIN', reasons };
}

// Whether "the next unwatched episode" as TMDb/MyTv currently understands it
// (season/episode number, from UserSeriesProgress.nextEpisodeId) agrees with
// what TVmaze's catalog would propose. Season/episode NUMBERS are
// deliberately not compared directly — real-world check against TVmaze's
// own API (Naruto: TVmaze numbers seasons by year, 2002-2007; TV
// Time/typical TMDb numbering uses sequential Season 1-5) shows these
// conventions routinely disagree for exactly the long-running-anime titles
// this dataset skews toward. Chronological POSITION (the Nth-ever-aired
// episode, N = watchedEpisodeCount) is the only cross-provider-comparable
// signal, and even that can only be confirmed by title text — which is
// frequently unavailable, since TV Time's own export carries no episode
// titles at all (see Episode.title's schema comment).
export interface TvMazeEpisodeForPositionLookup {
  season: number;
  number: number | null;
  name: string;
  airdate: string | null;
}

export interface NextEpisodeComparison {
  tvmazeProposedNextEpisodeLabel: string | null;
  tvmazeProposedNextEpisodeTitle: string | null;
  titlesComparable: boolean;
  titlesMatch: boolean | null;
  note: string;
}

export function computeNextEpisodeComparison(
  tvmazeEpisodesChronological: TvMazeEpisodeForPositionLookup[],
  watchedEpisodeCount: number,
  mytvCurrentNextEpisodeTitle: string | null,
): NextEpisodeComparison {
  const proposed = tvmazeEpisodesChronological[watchedEpisodeCount] ?? null;

  if (!proposed) {
    return {
      tvmazeProposedNextEpisodeLabel: null,
      tvmazeProposedNextEpisodeTitle: null,
      titlesComparable: false,
      titlesMatch: null,
      note: `TVmaze's catalog has no episode at chronological position ${watchedEpisodeCount + 1} (only ${tvmazeEpisodesChronological.length} known) — series may be caught up or TVmaze's catalog is behind`,
    };
  }

  const titlesComparable = !!mytvCurrentNextEpisodeTitle && !!proposed.name;
  const titlesMatch = titlesComparable ? normalizeForComparison(mytvCurrentNextEpisodeTitle!) === normalizeForComparison(proposed.name) : null;

  return {
    tvmazeProposedNextEpisodeLabel: `S${proposed.season}E${proposed.number ?? '?'}`,
    tvmazeProposedNextEpisodeTitle: proposed.name,
    titlesComparable,
    titlesMatch,
    note: titlesComparable
      ? `compared by episode title text (season/episode numbers are not reliably comparable across providers for this dataset)`
      : 'no episode title available on one or both sides to compare — season/episode numbers alone are not a reliable cross-provider signal, so this is inconclusive',
  };
}

function normalizeForComparison(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}
