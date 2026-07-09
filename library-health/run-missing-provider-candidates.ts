// Missing Provider Candidates report — READ-ONLY. Takes the top
// MISSING_PROVIDER_MATCH series (by watchedEpisodeCount, per the latest
// Library Health classification) and, for each, searches TMDb and scores
// the top few plausible candidates — combining tmdb-enrichment/scoring.ts's
// existing title/year confidence scoring with
// tmdb-enrichment/season-structure-tiebreak.ts's season-structure
// tie-breaker — to recommend the safest next action.
//
// This NEVER writes anything: no ExternalIds row, no Episode/Season row, no
// apply mode. It only ever recommends CONFIRM_PROVIDER_MATCH — an actual
// match is always a separate, human-reviewed step via the existing
// tmdb-enrichment dry-run/apply pipeline, never this report.

import 'dotenv/config';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { MAX_APPEND_TO_RESPONSE_ITEMS, TmdbClient, TmdbRequestError } from '../tmdb-enrichment/tmdb-client';
import { getAppendedSeason, TmdbTvDetails } from '../tmdb-enrichment/tmdb-types';
import { decideTier, detectAnimeNumberingRisk, detectCloseCompetitor, extractTitleYearHint, parseYearFromDate, scoreCandidates } from '../tmdb-enrichment/scoring';
import { buildSeasonShape, sameTotalEpisodeCountTieBreaker, scoreCandidateSeasonStructure, SeasonShape, TieBreakCandidateInput } from '../tmdb-enrichment/season-structure-tiebreak';
import { chunkArray } from '../episode-release-refresh/refresh-logic';
import { classifySeriesHealth } from './health-logic';
import { loadSeriesHealthInputs } from './load-series-health-inputs';
import { classifyMissingProviderSeries, MissingProviderCandidateSummary } from './missing-provider-candidates-logic';
import {
  buildMissingProviderCandidatesMarkdownReport,
  buildMissingProviderCandidatesReport,
  MissingProviderSeriesReport,
  writeMissingProviderCandidatesReports,
} from './missing-provider-candidates-reports';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');
const DEFAULT_LIMIT = 20;
// "Top few plausible candidates only" (task 2) — fetching full season data
// is the expensive part (multiple TMDb calls per candidate), so this is
// deliberately small.
const MAX_CANDIDATES_TO_FETCH = 3;

interface CliOptions {
  userId: string;
  outDir: string;
  limit: number;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('--apply')) {
    console.error(
      'This report is read-only by design and does not support --apply — no DB writes, no provider writes, no ' +
        'apply mode. Re-run without --apply.',
    );
    process.exit(1);
  }

  const options: CliOptions = { userId: DEV_USER_ID, outDir: DEFAULT_OUT_DIR, limit: DEFAULT_LIMIT };
  for (const arg of argv) {
    if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice('--limit='.length));
  }
  return options;
}

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

  return {
    shape: buildSeasonShape(episodesPerSeason),
    genres: details.genres,
    originalLanguage: details.original_language,
    originCountry: details.origin_country,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const accessToken = process.env.TMDB_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('Missing TMDB_ACCESS_TOKEN — set it in .env (see .env.example). No request is made without it.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const tmdb = new TmdbClient({ accessToken });
  const generatedAt = new Date();

  console.log('Missing Provider Candidates report — READ-ONLY (no DB writes, no provider writes)');
  console.log(`  target user: ${options.userId}`);
  console.log(`  limit: ${options.limit}`);

  const healthInputs = await loadSeriesHealthInputs(prisma, options.userId);
  const allMissingMatches = healthInputs
    .map((input) => classifySeriesHealth({ ...input, now: generatedAt }))
    .filter((health) => health.classification === 'MISSING_PROVIDER_MATCH')
    .sort((a, b) => b.watchedEpisodeCount - a.watchedEpisodeCount);
  const missingMatches = allMissingMatches.slice(0, options.limit);

  console.log(`  MISSING_PROVIDER_MATCH series found: ${allMissingMatches.length}; investigating top ${missingMatches.length}`);

  const seriesReports: MissingProviderSeriesReport[] = [];

  for (const health of missingMatches) {
    // Reconstruct local season shape from health's flat episode list — every
    // known local episode (watched or not) counts, matching how
    // season-structure-tiebreak.ts and incomplete-catalog-investigation.ts
    // both define "local shape."
    const localInput = healthInputs.find((i) => i.seriesId === health.seriesId)!;
    const bySeason = new Map<number, number>();
    for (const ep of localInput.episodes) {
      bySeason.set(ep.seasonNumber, (bySeason.get(ep.seasonNumber) ?? 0) + 1);
    }
    const episodesPerSeason = [...bySeason.entries()].sort(([a], [b]) => a - b).map(([, count]) => count);
    const localShape = buildSeasonShape(episodesPerSeason);

    try {
      const hint = extractTitleYearHint(health.title);
      const results = await tmdb.searchTv(hint.bareTitle, hint.titleYear);
      const scored = scoreCandidates(hint, results);
      const tierDecision = decideTier(scored);

      const summaries: MissingProviderCandidateSummary[] = [];
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
            watchedEpisodeCount: health.watchedEpisodeCount,
            tmdbTotalEpisodeCount: fetched.shape.totalEpisodeCount,
            genres: fetched.genres,
            originalLanguage: fetched.originalLanguage,
            originCountry: fetched.originCountry,
          });
          if (health.watchedEpisodeCount > fetched.shape.totalEpisodeCount) {
            warnings.push(`watched episode count (${health.watchedEpisodeCount}) exceeds this candidate's total (${fetched.shape.totalEpisodeCount})`);
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
        .filter((s): s is MissingProviderCandidateSummary & { providerSeasonShape: SeasonShape } => s.providerSeasonShape !== null)
        .map((s) => ({
          candidateId: s.tmdbId,
          candidateLabel: s.title,
          candidateTitle: s.title,
          shape: s.providerSeasonShape,
          // TMDb search doesn't expose a broadcast network without a
          // further call — title+year mismatch is the available proxy for
          // "strong identity mismatch" here; documented in
          // season-structure-tiebreak.ts's own field-level comment.
          hasStrongTitleYearNetworkMismatch: s.titleMatchType !== 'exact' || s.yearMatchType === 'mismatch',
          animeNumberingRiskDetected: s.animeNumberingRiskDetected,
          baseConfidenceScore: s.confidenceScore,
        }));

      const tieBreak = tieBreakInputs.length >= 2 ? sameTotalEpisodeCountTieBreaker(localShape, tieBreakInputs) : null;

      const decision = classifyMissingProviderSeries({
        localTitle: health.title,
        localSeasonShape: localShape,
        watchedEpisodeCount: health.watchedEpisodeCount,
        topTier: tierDecision.tier,
        candidates: summaries,
        closeCompetitorDetected: closeCompetitor.detected,
        tieBreak,
      });

      const recommendedCandidate = decision.recommendedCandidateTmdbId
        ? (summaries.find((s) => s.tmdbId === decision.recommendedCandidateTmdbId) ?? null)
        : null;

      seriesReports.push({
        seriesId: health.seriesId,
        title: health.title,
        userStatus: health.userStatus,
        releaseStatus: health.releaseStatus,
        nextEpisodeId: health.nextEpisodeId,
        watchedEpisodeCount: health.watchedEpisodeCount,
        localSeasonShape: localShape,
        candidates: summaries,
        recommendedCandidate,
        classification: decision.classification,
        recommendedNextAction: decision.recommendedNextAction,
        reason: decision.reason,
      });

      console.log(`  [${decision.classification}] ${health.title} -> ${decision.recommendedNextAction}`);
    } catch (err) {
      const message = err instanceof TmdbRequestError ? err.message : (err as Error).message;
      seriesReports.push({
        seriesId: health.seriesId,
        title: health.title,
        userStatus: health.userStatus,
        releaseStatus: health.releaseStatus,
        nextEpisodeId: health.nextEpisodeId,
        watchedEpisodeCount: health.watchedEpisodeCount,
        localSeasonShape: localShape,
        candidates: [],
        recommendedCandidate: null,
        classification: 'NO_GOOD_MATCH',
        recommendedNextAction: 'RUN_TARGETED_PROVIDER_AUDIT',
        reason: `TMDb search failed: ${message}`,
      });
      console.log(`  [NO_GOOD_MATCH] ${health.title} — search failed: ${message}`);
    }
  }

  const report = buildMissingProviderCandidatesReport({ generatedAt, targetUserId: options.userId, series: seriesReports });
  const markdown = buildMissingProviderCandidatesMarkdownReport(report);
  const written = writeMissingProviderCandidatesReports(options.outDir, report, markdown);

  console.log(`\nDone. Reports written:`);
  console.log(`  ${written.latestJsonPath}`);
  console.log(`  ${written.latestMarkdownPath}`);
  console.log(`  ${written.archivedJsonPath}`);
  console.log(`  ${written.archivedMarkdownPath}`);
  console.log('\nSummary:');
  console.log(JSON.stringify(report.summary, null, 2));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
