// The single, reusable "search + score TMDb candidates for ONE series"
// function — extracted from run-missing-provider-candidates.ts's per-series
// loop body, same extraction pattern as
// run-provider-confirmation-for-decision.ts, so the live in-app provider
// search (Migration Workbench's "Find Provider" flow) and the CLI's
// whole-library batch report share the exact same search/scoring/
// classification code path. Never invents a second identity-matching
// algorithm — reuses tmdb-enrichment/scoring.ts's title/year confidence
// scoring, season-structure-tiebreak.ts's structural comparison, and
// missing-provider-candidates-logic.ts's classifyMissingProviderSeries
// verbatim.
//
// READ-ONLY: performs live TMDb search + season-shape fetches for the top
// few candidates, never writes anything. Confirming an identity (saving a
// ProviderIdentityDecision row) is a separate, explicit step — see
// provider-identity-decisions-store.ts's saveProviderIdentityDecision.

import { TmdbClient, TmdbRequestError, MAX_APPEND_TO_RESPONSE_ITEMS } from '../tmdb-enrichment/tmdb-client';
import { getAppendedSeason, TmdbTvDetails } from '../tmdb-enrichment/tmdb-types';
import { tmdbImageUrl } from '../tmdb-enrichment/apply-plan-writes';
import { decideTier, detectAnimeNumberingRisk, detectCloseCompetitor, extractTitleYearHint, parseYearFromDate, scoreCandidates } from '../tmdb-enrichment/scoring';
import { buildSeasonShape, sameTotalEpisodeCountTieBreaker, scoreCandidateSeasonStructure, SeasonShape, TieBreakCandidateInput } from '../tmdb-enrichment/season-structure-tiebreak';
import { chunkArray } from '../episode-release-refresh/refresh-logic';
import { classifyMissingProviderSeries, ClassifyMissingProviderSeriesResult, MissingProviderCandidateSummary } from './missing-provider-candidates-logic';

// MissingProviderCandidateSummary plus a poster — the shared type has no
// image field (the whole-library batch report never rendered one), but the
// in-app candidate-comparison screen needs one. Additive-only extension,
// never a modified copy of the shared type.
export interface SearchedProviderCandidate extends MissingProviderCandidateSummary {
  posterUrl: string | null;
}

const MAX_CANDIDATES_TO_FETCH = 3;

interface CandidateSeasonFetchResult {
  shape: SeasonShape;
  genres: TmdbTvDetails['genres'];
  originalLanguage: string | null | undefined;
  originCountry: string[] | undefined;
}

async function fetchCandidateSeasonShape(tmdb: TmdbClient, tmdbId: string): Promise<CandidateSeasonFetchResult> {
  const details = await tmdb.getShowDetails(tmdbId);
  const seasonNumbers = Array.from({ length: details.number_of_seasons ?? 0 }, (_, i) => i + 1);

  const episodesPerSeason: number[] = [];
  for (const batch of chunkArray(seasonNumbers, MAX_APPEND_TO_RESPONSE_ITEMS)) {
    const response = await tmdb.getSeasonsBatch(tmdbId, batch);
    for (const seasonNumber of batch) {
      const season = getAppendedSeason(response, seasonNumber);
      episodesPerSeason.push(season?.episodes?.length ?? 0);
    }
  }

  return { shape: buildSeasonShape(episodesPerSeason), genres: details.genres, originalLanguage: details.original_language, originCountry: details.origin_country };
}

export interface SearchProviderCandidatesForSeriesInput {
  tmdb: TmdbClient;
  localTitle: string;
  // Every known local episode (watched or not), one entry per episode,
  // grouped by season — same "local shape" contract as
  // season-structure-tiebreak.ts / incomplete-catalog-investigation.ts.
  localEpisodesPerSeason: number[];
  watchedEpisodeCount: number;
}

export interface SearchProviderCandidatesForSeriesResult {
  candidates: SearchedProviderCandidate[];
  decision: ClassifyMissingProviderSeriesResult;
}

export async function searchProviderCandidatesForSeries(input: SearchProviderCandidatesForSeriesInput): Promise<SearchProviderCandidatesForSeriesResult> {
  const { tmdb } = input;
  const localShape = buildSeasonShape(input.localEpisodesPerSeason);

  const hint = extractTitleYearHint(input.localTitle);
  const results = await tmdb.searchTv(hint.bareTitle, hint.titleYear);
  const scored = scoreCandidates(hint, results);
  const tierDecision = decideTier(scored);

  const summaries: SearchedProviderCandidate[] = [];
  for (const sc of scored.slice(0, MAX_CANDIDATES_TO_FETCH)) {
    const warnings: string[] = [];
    let providerSeasonShape: SeasonShape | null = null;
    let seasonStructureScore: number | null = null;
    let seasonStructureReason: string | null = null;
    let collapsePatternDetected: boolean | null = null;
    let animeNumberingRiskDetected = false;

    try {
      const fetched = await fetchCandidateSeasonShape(tmdb, String(sc.result.id));
      providerSeasonShape = fetched.shape;
      const structureScore = scoreCandidateSeasonStructure(localShape, fetched.shape);
      seasonStructureScore = structureScore.seasonStructureScore;
      seasonStructureReason = structureScore.seasonStructureReason;
      collapsePatternDetected = structureScore.collapsePatternDetected;
      animeNumberingRiskDetected = detectAnimeNumberingRisk({
        watchedEpisodeCount: input.watchedEpisodeCount,
        tmdbTotalEpisodeCount: fetched.shape.totalEpisodeCount,
        genres: fetched.genres,
        originalLanguage: fetched.originalLanguage,
        originCountry: fetched.originCountry,
      });
      if (input.watchedEpisodeCount > fetched.shape.totalEpisodeCount) {
        warnings.push(`watched episode count (${input.watchedEpisodeCount}) exceeds this candidate's total (${fetched.shape.totalEpisodeCount})`);
      }
    } catch (err) {
      const message = err instanceof TmdbRequestError ? err.message : (err as Error).message;
      warnings.push(`season/episode fetch failed: ${message}`);
    }

    summaries.push({
      provider: 'tmdb',
      tmdbId: String(sc.result.id),
      title: sc.result.name,
      year: parseYearFromDate(sc.result.first_air_date),
      posterUrl: tmdbImageUrl(sc.result.poster_path),
      confidenceScore: sc.breakdown.totalScore,
      titleMatchType: sc.breakdown.titleMatchType,
      yearMatchType: sc.breakdown.yearMatchType,
      resultPosition: sc.breakdown.resultPosition,
      providerSeasonShape,
      totalEpisodeCount: providerSeasonShape?.totalEpisodeCount ?? null,
      seasonStructureScore,
      seasonStructureReason,
      collapsePatternDetected,
      animeNumberingRiskDetected,
      warnings,
    });
  }

  const closeCompetitor =
    summaries.length > 1
      ? detectCloseCompetitor(
          { tmdbId: summaries[0].tmdbId, tmdbTitle: summaries[0].title, tmdbYear: summaries[0].year, confidenceScore: summaries[0].confidenceScore },
          summaries.slice(1).map((s) => ({ tmdbId: s.tmdbId, tmdbTitle: s.title, tmdbYear: s.year, confidenceScore: s.confidenceScore })),
        )
      : { detected: false, reason: null, kind: null };

  const tieBreakInputs: TieBreakCandidateInput[] = summaries
    .filter((s): s is SearchedProviderCandidate & { providerSeasonShape: SeasonShape } => s.providerSeasonShape !== null)
    .map((s) => ({
      candidateId: s.tmdbId,
      candidateLabel: s.title,
      candidateTitle: s.title,
      shape: s.providerSeasonShape,
      hasStrongTitleYearNetworkMismatch: s.titleMatchType !== 'exact' || s.yearMatchType === 'mismatch',
      animeNumberingRiskDetected: s.animeNumberingRiskDetected,
      baseConfidenceScore: s.confidenceScore,
    }));
  const tieBreak = tieBreakInputs.length >= 2 ? sameTotalEpisodeCountTieBreaker(localShape, tieBreakInputs) : null;

  const decision = classifyMissingProviderSeries({
    localTitle: input.localTitle,
    localSeasonShape: localShape,
    watchedEpisodeCount: input.watchedEpisodeCount,
    topTier: tierDecision.tier,
    candidates: summaries,
    closeCompetitorDetected: closeCompetitor.detected,
    tieBreak,
  });

  return { candidates: summaries, decision };
}
