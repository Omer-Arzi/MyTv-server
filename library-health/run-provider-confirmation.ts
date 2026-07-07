// Provider Confirmation report — READ-ONLY. A focused follow-up to
// run-missing-provider-candidates.ts for the 8 NEEDS_MANUAL_CONFIRMATION
// titles it found: builds a side-by-side TMDb vs TVmaze comparison for the
// 6 mostly-western, non-anime titles (the "priority scope"), and carries
// the remaining 2 higher-risk titles forward for visibility only, without
// spending fetch budget re-investigating them this pass.
//
// This NEVER writes anything: no ExternalIds row, no Episode/Season row, no
// apply mode. It only ever recommends a human action — an actual match is
// always a separate, human-reviewed step via the existing tmdb-enrichment
// dry-run/apply pipeline, never this report.

import 'dotenv/config';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { MAX_APPEND_TO_RESPONSE_ITEMS, TmdbClient, TmdbRequestError } from '../tmdb-enrichment/tmdb-client';
import { getAppendedSeason } from '../tmdb-enrichment/tmdb-types';
import { decideTier as decideTmdbTier, detectCloseCompetitor as detectTmdbCloseCompetitor, extractTitleYearHint, parseYearFromDate as parseTmdbYear, scoreCandidates as scoreTmdbCandidates } from '../tmdb-enrichment/scoring';
import { TvMazeClient, TvMazeRequestError } from '../secondary-provider-audit/tvmaze-client';
import { TvMazeEpisode } from '../secondary-provider-audit/tvmaze-types';
import {
  decideTier as decideTvmazeTier,
  detectCloseCompetitor as detectTvmazeCloseCompetitor,
  parseYearFromDate as parseTvmazeYear,
  scoreCandidates as scoreTvmazeCandidates,
} from '../secondary-provider-audit/tvmaze-scoring';
import { buildSeasonShape, scoreCandidateSeasonStructure, SeasonShape } from '../tmdb-enrichment/season-structure-tiebreak';
import { chunkArray } from '../episode-release-refresh/refresh-logic';
import { classifySeriesHealth } from './health-logic';
import { loadSeriesHealthInputs } from './load-series-health-inputs';
import { classifyForConfirmation, explainCandidateLikelihood, ProviderCandidateComparisonEntry } from './provider-confirmation-logic';
import {
  buildProviderConfirmationMarkdownReport,
  buildProviderConfirmationReport,
  ProviderConfirmationSeriesReport,
  writeProviderConfirmationReports,
} from './provider-confirmation-reports';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');
const MAX_CANDIDATES_TO_FETCH = 2;

// The 8 titles the missing-provider-candidates report flagged
// NEEDS_MANUAL_CONFIRMATION. Only the 6 "priority" titles get a fresh
// TMDb+TVmaze side-by-side comparison this pass — the other 2 are carried
// forward for visibility, unmodified, per the task's explicit scoping.
const PRIORITY_TITLES = ['The Big Bang Theory', 'Modern Family', 'Friends', 'How I Met Your Mother', 'The Office (US)', 'The Flash (2014)'];
const DEFERRED_TITLES = ['Naruto Shippuden', 'Doctor Who (2005)'];
const ALL_TITLES = [...PRIORITY_TITLES, ...DEFERRED_TITLES];

interface CliOptions {
  userId: string;
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('--apply')) {
    console.error(
      'This report is read-only by design and does not support --apply — no DB writes, no provider writes, no ' +
        'apply mode. Re-run without --apply.',
    );
    process.exit(1);
  }

  const options: CliOptions = { userId: DEV_USER_ID, outDir: DEFAULT_OUT_DIR };
  for (const arg of argv) {
    if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
  }
  return options;
}

async function fetchTmdbCandidates(
  tmdb: TmdbClient,
  localTitle: string,
  localShape: SeasonShape,
  watchedEpisodeCount: number,
): Promise<{ candidates: ProviderCandidateComparisonEntry[]; closeCompetitorDetected: boolean }> {
  const hint = extractTitleYearHint(localTitle);
  const results = await tmdb.searchTv(hint.bareTitle, hint.titleYear);
  const scored = scoreTmdbCandidates(hint, results);

  const candidates: ProviderCandidateComparisonEntry[] = [];
  for (const sc of scored.slice(0, MAX_CANDIDATES_TO_FETCH)) {
    const tmdbId = String(sc.result.id);
    const warnings: string[] = [];
    let shape: SeasonShape | null = null;
    let seasonStructureScore: number | null = null;
    let seasonStructureReason: string | null = null;
    let collapsePatternDetected: boolean | null = null;
    let hasPoster: boolean | null = !!sc.result.poster_path;
    let status: string | null = null;

    try {
      const details = await tmdb.getShowDetails(tmdbId);
      status = details.status ?? null;
      hasPoster = !!(details.poster_path ?? sc.result.poster_path);
      const seasonNumbers = Array.from({ length: details.number_of_seasons ?? 0 }, (_, i) => i + 1);
      const episodesPerSeason: number[] = [];
      for (const batch of chunkArray(seasonNumbers, MAX_APPEND_TO_RESPONSE_ITEMS)) {
        const response = await tmdb.getSeasonsBatch(tmdbId, batch);
        for (const seasonNumber of batch) {
          const season = getAppendedSeason(response, seasonNumber);
          episodesPerSeason.push(season?.episodes?.length ?? 0);
        }
      }
      shape = buildSeasonShape(episodesPerSeason);
      const structureScore = scoreCandidateSeasonStructure(localShape, shape);
      seasonStructureScore = structureScore.seasonStructureScore;
      seasonStructureReason = structureScore.seasonStructureReason;
      collapsePatternDetected = structureScore.collapsePatternDetected;
      if (watchedEpisodeCount > shape.totalEpisodeCount) {
        warnings.push(`watched episode count (${watchedEpisodeCount}) exceeds this candidate's total (${shape.totalEpisodeCount})`);
      }
    } catch (err) {
      const message = err instanceof TmdbRequestError ? err.message : (err as Error).message;
      warnings.push(`season/episode fetch failed: ${message}`);
    }

    const watchedVsTotalGap = shape ? watchedEpisodeCount - shape.totalEpisodeCount : null;
    candidates.push({
      provider: 'tmdb',
      id: tmdbId,
      title: sc.result.name,
      yearOrPremiereDate: sc.result.first_air_date ?? null,
      network: null, // TMDb's TV objects expose no broadcaster/platform field — see tmdb-types.ts
      status,
      totalEpisodeCount: shape?.totalEpisodeCount ?? null,
      seasonCount: shape?.seasonCount ?? null,
      episodesPerSeason: shape?.episodesPerSeason ?? null,
      hasPoster,
      confidenceScore: sc.breakdown.totalScore,
      titleMatchType: sc.breakdown.titleMatchType,
      yearMatchType: sc.breakdown.yearMatchType,
      seasonStructureScore,
      seasonStructureReason,
      collapsePatternDetected,
      animeNumberingRiskDetected: false, // computed only where needed (TMDb path doesn't gate on it in this report; see reason text if collapse is present)
      watchedVsTotalGap,
      warnings,
      likelyCorrectReason: explainCandidateLikelihood({
        titleMatchType: sc.breakdown.titleMatchType,
        yearMatchType: sc.breakdown.yearMatchType,
        watchedVsTotalGap,
        collapsePatternDetected,
        animeNumberingRiskDetected: false,
      }),
    });
  }

  const closeCompetitorDetected =
    candidates.length > 1
      ? detectTmdbCloseCompetitor(
          { tmdbId: candidates[0].id, tmdbTitle: candidates[0].title, tmdbYear: parseTmdbYear(candidates[0].yearOrPremiereDate), confidenceScore: candidates[0].confidenceScore },
          candidates.slice(1).map((c) => ({ tmdbId: c.id, tmdbTitle: c.title, tmdbYear: parseTmdbYear(c.yearOrPremiereDate), confidenceScore: c.confidenceScore })),
        ).detected
      : false;

  return { candidates, closeCompetitorDetected };
}

function episodesPerSeasonFromTvMaze(episodes: TvMazeEpisode[]): number[] {
  const bySeason = new Map<number, number>();
  for (const ep of episodes) bySeason.set(ep.season, (bySeason.get(ep.season) ?? 0) + 1);
  return [...bySeason.entries()].sort(([a], [b]) => a - b).map(([, count]) => count);
}

async function fetchTvmazeCandidates(
  tvmaze: TvMazeClient,
  localTitle: string,
  localShape: SeasonShape,
  watchedEpisodeCount: number,
): Promise<{ candidates: ProviderCandidateComparisonEntry[]; closeCompetitorDetected: boolean }> {
  const hint = extractTitleYearHint(localTitle);
  const results = await tvmaze.searchShows(hint.bareTitle);
  const scored = scoreTvmazeCandidates(hint, results);

  const candidates: ProviderCandidateComparisonEntry[] = [];
  for (const sc of scored.slice(0, MAX_CANDIDATES_TO_FETCH)) {
    const tvmazeId = sc.result.show.id;
    const warnings: string[] = [];
    let shape: SeasonShape | null = null;
    let seasonStructureScore: number | null = null;
    let seasonStructureReason: string | null = null;
    let collapsePatternDetected: boolean | null = null;
    let animeNumberingRiskDetected = false;

    try {
      const show = await tvmaze.getShowWithEpisodes(tvmazeId);
      const episodes = show._embedded?.episodes ?? [];
      const episodesPerSeason = episodesPerSeasonFromTvMaze(episodes);
      shape = buildSeasonShape(episodesPerSeason);
      const structureScore = scoreCandidateSeasonStructure(localShape, shape);
      seasonStructureScore = structureScore.seasonStructureScore;
      seasonStructureReason = structureScore.seasonStructureReason;
      collapsePatternDetected = structureScore.collapsePatternDetected;
      animeNumberingRiskDetected = (show.genres ?? []).some((g) => g.toLowerCase() === 'anime') && Math.max(watchedEpisodeCount, shape.totalEpisodeCount) >= 100;
      if (watchedEpisodeCount > shape.totalEpisodeCount) {
        warnings.push(`watched episode count (${watchedEpisodeCount}) exceeds this candidate's total (${shape.totalEpisodeCount})`);
      }
    } catch (err) {
      const message = err instanceof TvMazeRequestError ? err.message : (err as Error).message;
      warnings.push(`season/episode fetch failed: ${message}`);
    }

    const watchedVsTotalGap = shape ? watchedEpisodeCount - shape.totalEpisodeCount : null;
    candidates.push({
      provider: 'tvmaze',
      id: String(tvmazeId),
      title: sc.result.show.name,
      yearOrPremiereDate: sc.result.show.premiered,
      network: sc.result.show.network?.name ?? sc.result.show.webChannel?.name ?? null,
      status: sc.result.show.status,
      totalEpisodeCount: shape?.totalEpisodeCount ?? null,
      seasonCount: shape?.seasonCount ?? null,
      episodesPerSeason: shape?.episodesPerSeason ?? null,
      hasPoster: sc.result.show.image ? !!sc.result.show.image.medium : null,
      confidenceScore: sc.breakdown.totalScore,
      titleMatchType: sc.breakdown.titleMatchType,
      yearMatchType: sc.breakdown.yearMatchType,
      seasonStructureScore,
      seasonStructureReason,
      collapsePatternDetected,
      animeNumberingRiskDetected,
      watchedVsTotalGap,
      warnings,
      likelyCorrectReason: explainCandidateLikelihood({
        titleMatchType: sc.breakdown.titleMatchType,
        yearMatchType: sc.breakdown.yearMatchType,
        watchedVsTotalGap,
        collapsePatternDetected,
        animeNumberingRiskDetected,
      }),
    });
  }

  const closeCompetitorDetected =
    candidates.length > 1
      ? detectTvmazeCloseCompetitor(
          { tvmazeId: Number(candidates[0].id), tvmazeTitle: candidates[0].title, tvmazeYear: parseTvmazeYear(candidates[0].yearOrPremiereDate), confidenceScore: candidates[0].confidenceScore },
          candidates.slice(1).map((c) => ({ tvmazeId: Number(c.id), tvmazeTitle: c.title, tvmazeYear: parseTvmazeYear(c.yearOrPremiereDate), confidenceScore: c.confidenceScore })),
        ).detected
      : false;

  return { candidates, closeCompetitorDetected };
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
  const tvmaze = new TvMazeClient();
  const generatedAt = new Date();

  console.log('Provider Confirmation report — READ-ONLY (no DB writes, no provider writes)');
  console.log(`  target user: ${options.userId}`);
  console.log(`  priority scope: ${PRIORITY_TITLES.join(', ')}`);
  console.log(`  deferred: ${DEFERRED_TITLES.join(', ')}`);

  const healthInputs = await loadSeriesHealthInputs(prisma, options.userId);
  const targets = healthInputs
    .map((input) => ({ input, health: classifySeriesHealth({ ...input, now: generatedAt }) }))
    .filter(({ health }) => ALL_TITLES.includes(health.title));

  const seriesReports: ProviderConfirmationSeriesReport[] = [];

  for (const title of ALL_TITLES) {
    const target = targets.find((t) => t.health.title === title);
    if (!target) {
      console.log(`  [SKIPPED] "${title}" not found among current MISSING_PROVIDER_MATCH series (title may have changed or already been matched)`);
      continue;
    }
    const { input, health } = target;

    const bySeason = new Map<number, number>();
    for (const ep of input.episodes) bySeason.set(ep.seasonNumber, (bySeason.get(ep.seasonNumber) ?? 0) + 1);
    const localShape = buildSeasonShape([...bySeason.entries()].sort(([a], [b]) => a - b).map(([, count]) => count));

    const isPriorityScope = PRIORITY_TITLES.includes(title);

    let tmdbCandidates: ProviderCandidateComparisonEntry[] = [];
    let tvmazeCandidates: ProviderCandidateComparisonEntry[] = [];
    let tmdbCloseCompetitorDetected = false;
    let tvmazeCloseCompetitorDetected = false;

    if (isPriorityScope) {
      try {
        const tmdbResult = await fetchTmdbCandidates(tmdb, health.title, localShape, health.watchedEpisodeCount);
        tmdbCandidates = tmdbResult.candidates;
        tmdbCloseCompetitorDetected = tmdbResult.closeCompetitorDetected;
      } catch (err) {
        const message = err instanceof TmdbRequestError ? err.message : (err as Error).message;
        console.log(`  [WARN] TMDb search failed for "${title}": ${message}`);
      }

      try {
        const tvmazeResult = await fetchTvmazeCandidates(tvmaze, health.title, localShape, health.watchedEpisodeCount);
        tvmazeCandidates = tvmazeResult.candidates;
        tvmazeCloseCompetitorDetected = tvmazeResult.closeCompetitorDetected;
      } catch (err) {
        const message = err instanceof TvMazeRequestError ? err.message : (err as Error).message;
        console.log(`  [WARN] TVmaze search failed for "${title}": ${message}`);
      }
    }

    const decision = classifyForConfirmation({
      localTitle: health.title,
      isPriorityScope,
      watchedEpisodeCount: health.watchedEpisodeCount,
      tmdbCandidates,
      tvmazeCandidates,
      tmdbCloseCompetitorDetected,
      tvmazeCloseCompetitorDetected,
    });

    const allCandidates = [...tmdbCandidates, ...tvmazeCandidates];
    const recommendedCandidate = decision.recommendedCandidate
      ? (allCandidates.find((c) => c.provider === decision.recommendedCandidate!.provider && c.id === decision.recommendedCandidate!.id) ?? null)
      : null;

    seriesReports.push({
      seriesId: health.seriesId,
      title: health.title,
      userStatus: health.userStatus,
      nextEpisodeId: health.nextEpisodeId,
      lastWatchedAt: health.lastWatchedAt ? health.lastWatchedAt.toISOString() : null,
      watchedEpisodeCount: health.watchedEpisodeCount,
      localSeasonShape: localShape,
      isPriorityScope,
      tmdbCandidates,
      tvmazeCandidates,
      recommendedCandidate,
      classification: decision.classification,
      recommendedNextAction: decision.recommendedNextAction,
      reason: decision.reason,
    });

    console.log(`  [${decision.classification}] ${title} -> ${decision.recommendedNextAction}${recommendedCandidate ? ` (${recommendedCandidate.provider}: ${recommendedCandidate.title})` : ''}`);
  }

  const report = buildProviderConfirmationReport({ generatedAt, targetUserId: options.userId, series: seriesReports });
  const markdown = buildProviderConfirmationMarkdownReport(report);
  const written = writeProviderConfirmationReports(options.outDir, report, markdown);

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
