// Read-only TV Time parity audit. Never writes to any app table — queries
// the current database plus the most recent TMDb enrichment dry-run and
// TVmaze secondary-provider audit reports already on disk (matched by
// title, same technique as the recovery remap tools), and writes report
// files only. No live provider calls — everything needed is already cached
// from earlier audits.

import 'dotenv/config';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { PrismaClient, UserSeriesStatus } from '@prisma/client';
import { isEpisodeReleased } from '../src/common/is-episode-released';
import { detectDuplicateTitleGroups } from '../tmdb-enrichment/data-quality';
import { DEV_USER_ID } from '../src/common/constants';
import { TVTIME_VISIBLE_TITLES } from './titles';
import { findMatchesForTitle, TitleMatch } from './match-titles';
import { classifyParity, ParityIssueCategory, RecommendedAction } from './classify';

const OUT_DIR = path.join(__dirname, 'output');
const TMDB_OUTPUT_ROOT = path.join(__dirname, '..', 'tmdb-enrichment', 'output');
const TVMAZE_OUTPUT_ROOT = path.join(__dirname, '..', 'secondary-provider-audit', 'output');
const STALE_AFTER_DAYS = 30;
const STALE_INCLUDED_STATUSES = ['WATCHING', 'CAUGHT_UP'];

function findLatestBatchDir(root: string, requiredFile: string): string | null {
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((p) => existsSync(p) && statSync(p).isDirectory() && existsSync(path.join(p, requiredFile)))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0] ?? null;
}

interface TmdbNeedsReviewEntry {
  mytvSeriesTitle: string;
  tier: 'NEEDS_REVIEW' | 'NO_MATCH';
  topCandidate: { tmdbId: string; tmdbTitle: string; tmdbYear: number | null; confidenceScore: number } | null;
  tmdbTotalEpisodeCount: number | null;
  closeCompetitorDetected: boolean;
}
interface TmdbDataQualityEntry {
  mytvSeriesTitle: string;
  issueType: string;
}
interface TvMazeComparisonEntry {
  mytvSeriesTitle: string;
  tier: 'AUTO_MATCH' | 'NEEDS_REVIEW' | 'NO_MATCH';
  topCandidate: { tvmazeId: number; tvmazeTitle: string; tvmazeYear: number | null } | null;
  tvmazeRegularEpisodeCount: number | null;
  closeCompetitorDetected: boolean;
  isDuplicateTitleGroupMember: boolean;
  category: string;
}

interface SeriesDetailRow {
  mytvTitle: string;
  seriesId: string;
  userStatus: string | null;
  releaseStatus: string;
  hasPoster: boolean;
  hasBackdrop: boolean;
  tmdbId: string | null;
  seasonCount: number;
  episodeCountInDb: number;
  watchedEpisodeCount: number;
  lastWatchedEpisodeLabel: string | null;
  nextEpisodeId: string | null;
  nextEpisodeLabel: string | null;
  inWatchNext: boolean;
  inStaleSeries: boolean;
  notInEitherReason: string | null;
  tmdbCandidate: TmdbNeedsReviewEntry['topCandidate'] | null;
  tmdbTotalEpisodeCount: number | null;
  tvmazeCandidate: TvMazeComparisonEntry['topCandidate'] | null;
  tvmazeRegularEpisodeCount: number | null;
  matchKind: TitleMatch['matchKind'];
  matchedAgainst: string;
}

interface TvTimeTitleReport {
  tvTimeTitle: string;
  aliases: string[];
  hasDbMatch: boolean;
  isAmbiguousMultipleMatch: boolean;
  matchedSeries: SeriesDetailRow[];
  category: ParityIssueCategory;
  recommendedAction: RecommendedAction;
  reason: string;
}

async function main() {
  console.log('TV Time parity audit — read-only, no live provider calls, writes report files only.');

  const tmdbBatchDir = findLatestBatchDir(TMDB_OUTPUT_ROOT, 'tmdb-needs-review.json');
  const tvmazeBatchDir = findLatestBatchDir(TVMAZE_OUTPUT_ROOT, 'tvmaze-match-report.json');
  console.log(`  TMDb dry-run source: ${tmdbBatchDir ?? 'none found'}`);
  console.log(`  TVmaze audit source: ${tvmazeBatchDir ?? 'none found'}`);

  const needsReviewByTitle = new Map<string, TmdbNeedsReviewEntry>();
  let dataQualityFlaggedTitles = new Set<string>();
  if (tmdbBatchDir) {
    const needsReview: TmdbNeedsReviewEntry[] = JSON.parse(readFileSync(path.join(tmdbBatchDir, 'tmdb-needs-review.json'), 'utf-8'));
    for (const e of needsReview) needsReviewByTitle.set(e.mytvSeriesTitle, e);
    const dqPath = path.join(tmdbBatchDir, 'tmdb-data-quality-issues.json');
    if (existsSync(dqPath)) {
      const dq: TmdbDataQualityEntry[] = JSON.parse(readFileSync(dqPath, 'utf-8'));
      dataQualityFlaggedTitles = new Set(dq.filter((d) => d.issueType === 'REMAKE_COLLISION' || d.issueType === 'DUPLICATE_TITLE_DIFFERENT_YEAR_SUFFIX').map((d) => d.mytvSeriesTitle));
    }
  }

  const tvmazeByTitle = new Map<string, TvMazeComparisonEntry>();
  if (tvmazeBatchDir) {
    const report = JSON.parse(readFileSync(path.join(tvmazeBatchDir, 'tvmaze-match-report.json'), 'utf-8'));
    for (const c of report.comparisons as TvMazeComparisonEntry[]) tvmazeByTitle.set(c.mytvSeriesTitle, c);
  }

  const prisma = new PrismaClient();
  const userId = DEV_USER_ID;

  const allSeries = await prisma.series.findMany({ select: { id: true, title: true } });
  const duplicateGroups = detectDuplicateTitleGroups(allSeries);
  const duplicateTitles = new Set(duplicateGroups.flatMap((g) => g.members.map((m) => m.title)));

  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000);

  const reports: TvTimeTitleReport[] = [];

  for (const entry of TVTIME_VISIBLE_TITLES) {
    const searchTerms = [entry.tvTimeTitle, ...entry.aliases];
    const titleMatches = findMatchesForTitle(searchTerms, allSeries);

    if (titleMatches.length === 0) {
      const { category, recommendedAction, reason } = classifyParity({
        hasDbMatch: false,
        isAmbiguousMultipleMatch: false,
        isPossibleProviderMismatch: false,
        userStatus: null,
        hasTmdbMatch: false,
        hasProviderCandidate: false,
        dbEpisodeCount: 0,
        providerKnownEpisodeCount: null,
        nextEpisodeId: null,
        nextEpisodeAirDateIsFuture: false,
      });
      reports.push({ tvTimeTitle: entry.tvTimeTitle, aliases: entry.aliases, hasDbMatch: false, isAmbiguousMultipleMatch: false, matchedSeries: [], category, recommendedAction, reason });
      continue;
    }

    const isAmbiguous = titleMatches.length > 1;
    const matchedSeries: SeriesDetailRow[] = [];
    let combinedCategory: ParityIssueCategory | null = null;
    let combinedAction: RecommendedAction | null = null;
    let combinedReason = '';

    for (const match of titleMatches) {
      const seriesId = match.series.id;

      const series = await prisma.series.findUnique({
        where: { id: seriesId },
        include: { externalIds: true, seasons: { include: { episodes: true } } },
      });
      if (!series) continue;

      const progress = await prisma.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId, seriesId } } });
      const watchRows = await prisma.episodeWatch.findMany({
        where: { userId, episode: { season: { seriesId } } },
        orderBy: { watchedAt: 'desc' },
        include: { episode: { include: { season: true } } },
      });

      const episodeCountInDb = series.seasons.reduce((sum, s) => sum + s.episodes.length, 0);
      const seasonCount = series.seasons.length;
      const lastWatch = watchRows[0];
      const lastWatchedEpisodeLabel = lastWatch ? `S${lastWatch.episode.season.seasonNumber}E${lastWatch.episode.episodeNumber}` : null;

      let nextEpisodeLabel: string | null = null;
      let nextEpisodeAirDateIsFuture = false;
      if (progress?.nextEpisodeId) {
        const nextEp = series.seasons.flatMap((s) => s.episodes.map((e) => ({ ...e, seasonNumber: s.seasonNumber }))).find((e) => e.id === progress.nextEpisodeId);
        if (nextEp) {
          nextEpisodeLabel = `S${nextEp.seasonNumber}E${nextEp.episodeNumber}`;
          nextEpisodeAirDateIsFuture = !isEpisodeReleased(nextEp.airDate, now);
        }
      }

      const inWatchNext = progress?.userStatus === UserSeriesStatus.WATCHING && progress.nextEpisodeId != null && !nextEpisodeAirDateIsFuture;
      const inStaleSeries =
        !!progress &&
        STALE_INCLUDED_STATUSES.includes(progress.userStatus) &&
        progress.lastWatchedAt != null &&
        progress.lastWatchedAt < staleCutoff;

      let notInEitherReason: string | null = null;
      if (!inWatchNext && !inStaleSeries) {
        if (!progress) notInEitherReason = 'no UserSeriesProgress row exists for this series at all';
        else if (!STALE_INCLUDED_STATUSES.includes(progress.userStatus) && progress.userStatus !== UserSeriesStatus.WATCHING) notInEitherReason = `userStatus is ${progress.userStatus}, excluded by design`;
        else if (!progress.nextEpisodeId) notInEitherReason = 'nextEpisodeId is null — no unwatched released episode found';
        else if (nextEpisodeAirDateIsFuture) notInEitherReason = 'next episode has a future airDate — correctly filtered';
        else if (progress.lastWatchedAt && progress.lastWatchedAt >= staleCutoff) notInEitherReason = 'watched too recently to count as stale, but also not in Watch Next (check nextEpisodeId gating above)';
        else notInEitherReason = 'does not meet either section\'s criteria';
      }

      const needsReview = needsReviewByTitle.get(series.title);
      const tvmazeEntry = tvmazeByTitle.get(series.title);
      const hasTmdbMatch = series.externalIds?.tmdbId != null;
      const providerKnownEpisodeCount = Math.max(needsReview?.tmdbTotalEpisodeCount ?? 0, tvmazeEntry?.tvmazeRegularEpisodeCount ?? 0) || null;
      const hasProviderCandidate = !!needsReview?.topCandidate || (!!tvmazeEntry?.topCandidate && tvmazeEntry.tier !== 'NO_MATCH');
      const isPossibleProviderMismatch =
        dataQualityFlaggedTitles.has(series.title) ||
        duplicateTitles.has(series.title) ||
        !!needsReview?.closeCompetitorDetected ||
        !!tvmazeEntry?.closeCompetitorDetected ||
        !!tvmazeEntry?.isDuplicateTitleGroupMember;

      const { category, recommendedAction, reason } = classifyParity({
        hasDbMatch: true,
        isAmbiguousMultipleMatch: isAmbiguous,
        isPossibleProviderMismatch,
        userStatus: progress?.userStatus ?? null,
        hasTmdbMatch,
        hasProviderCandidate,
        dbEpisodeCount: episodeCountInDb,
        providerKnownEpisodeCount,
        nextEpisodeId: progress?.nextEpisodeId ?? null,
        nextEpisodeAirDateIsFuture,
      });

      matchedSeries.push({
        mytvTitle: series.title,
        seriesId: series.id,
        userStatus: progress?.userStatus ?? null,
        releaseStatus: series.releaseStatus,
        hasPoster: !!series.posterUrl,
        hasBackdrop: !!series.backdropUrl,
        tmdbId: series.externalIds?.tmdbId ?? null,
        seasonCount,
        episodeCountInDb,
        watchedEpisodeCount: watchRows.length,
        lastWatchedEpisodeLabel,
        nextEpisodeId: progress?.nextEpisodeId ?? null,
        nextEpisodeLabel,
        inWatchNext,
        inStaleSeries,
        notInEitherReason,
        tmdbCandidate: needsReview?.topCandidate ?? null,
        tmdbTotalEpisodeCount: needsReview?.tmdbTotalEpisodeCount ?? null,
        tvmazeCandidate: tvmazeEntry?.topCandidate ?? null,
        tvmazeRegularEpisodeCount: tvmazeEntry?.tvmazeRegularEpisodeCount ?? null,
        matchKind: match.matchKind,
        matchedAgainst: match.matchedAgainst,
      });

      // For a single (non-ambiguous) match, this series' own category wins.
      // For an ambiguous multi-match title, TITLE_MISMATCH (computed with
      // isAmbiguousMultipleMatch=true above) always wins regardless of any
      // individual member's own category — surfaced once at the title level.
      if (!combinedCategory || isAmbiguous) {
        combinedCategory = category;
        combinedAction = recommendedAction;
        combinedReason = reason;
      }
    }

    reports.push({
      tvTimeTitle: entry.tvTimeTitle,
      aliases: entry.aliases,
      hasDbMatch: true,
      isAmbiguousMultipleMatch: isAmbiguous,
      matchedSeries,
      category: combinedCategory!,
      recommendedAction: combinedAction!,
      reason: combinedReason,
    });
  }

  await prisma.$disconnect();

  const counts: Record<string, number> = {};
  for (const r of reports) counts[r.category] = (counts[r.category] ?? 0) + 1;

  console.log('\n' + JSON.stringify({ titlesAudited: reports.length, byCategory: counts }, null, 2));

  mkdirSync(OUT_DIR, { recursive: true });

  const jsonReport = {
    generatedAt: new Date().toISOString(),
    tmdbDryRunSource: tmdbBatchDir,
    tvmazeAuditSource: tvmazeBatchDir,
    writesToAppTables: false,
    summary: { titlesAudited: reports.length, byCategory: counts },
    titles: reports,
  };
  const jsonPath = path.join(OUT_DIR, 'tvtime-visible-items-report.json');
  writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2));
  console.log(`\nWrote ${jsonPath}`);

  const mdPath = path.join(OUT_DIR, 'tvtime-visible-items-report.md');
  writeFileSync(mdPath, buildMarkdown(reports, counts));
  console.log(`Wrote ${mdPath}`);
}

function buildMarkdown(reports: TvTimeTitleReport[], counts: Record<string, number>): string {
  const lines: string[] = [];
  lines.push('# TV Time Parity Audit');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('This report makes no changes — read-only against the database, no live provider calls.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Titles audited: ${reports.length}`);
  for (const [category, count] of Object.entries(counts)) lines.push(`- **${category}**: ${count}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const r of reports) {
    lines.push(`## ${r.tvTimeTitle}`);
    lines.push('');
    if (r.aliases.length > 0) lines.push(`Aliases searched: ${r.aliases.join(', ')}`);
    lines.push('');
    lines.push(`**Category**: \`${r.category}\` — ${r.reason}`);
    lines.push(`**Recommended action**: \`${r.recommendedAction}\``);
    lines.push('');

    if (r.matchedSeries.length === 0) {
      lines.push('No matching series found in the current database.');
      lines.push('');
      lines.push('---');
      lines.push('');
      continue;
    }

    for (const s of r.matchedSeries) {
      lines.push(`### MyTv match: ${s.mytvTitle} (matched via ${s.matchKind} against "${s.matchedAgainst}")`);
      lines.push('');
      lines.push(`- series id: \`${s.seriesId}\``);
      lines.push(`- userStatus: ${s.userStatus ?? '_none_'} · releaseStatus: ${s.releaseStatus}`);
      lines.push(`- posterUrl: ${s.hasPoster ? 'present' : 'MISSING'} · backdropUrl: ${s.hasBackdrop ? 'present' : 'MISSING'}`);
      lines.push(`- ExternalIds.tmdbId: ${s.tmdbId ?? '_none_'}`);
      lines.push(`- seasons: ${s.seasonCount} · episodes in DB: ${s.episodeCountInDb} · watched: ${s.watchedEpisodeCount}`);
      lines.push(`- last watched episode: ${s.lastWatchedEpisodeLabel ?? '_none_'}`);
      lines.push(`- nextEpisodeId: ${s.nextEpisodeId ? `${s.nextEpisodeId} (${s.nextEpisodeLabel})` : '_null_'}`);
      lines.push(`- in /me/watch-next: ${s.inWatchNext ? 'YES' : 'no'}`);
      lines.push(`- in /me/stale-series: ${s.inStaleSeries ? 'YES' : 'no'}`);
      if (s.notInEitherReason) lines.push(`- why missing from both: ${s.notInEitherReason}`);
      lines.push('');
      lines.push('**Provider candidates:**');
      lines.push(
        s.tmdbCandidate
          ? `- TMDb: "${s.tmdbCandidate.tmdbTitle}" (${s.tmdbCandidate.tmdbYear ?? 'unknown year'}, tmdbId ${s.tmdbCandidate.tmdbId}, score ${s.tmdbCandidate.confidenceScore}), known episodes: ${s.tmdbTotalEpisodeCount ?? 'unknown'}`
          : '- TMDb: no candidate on file',
      );
      lines.push(
        s.tvmazeCandidate
          ? `- TVmaze: "${s.tvmazeCandidate.tvmazeTitle}" (${s.tvmazeCandidate.tvmazeYear ?? 'unknown year'}, tvmazeId ${s.tvmazeCandidate.tvmazeId}), known episodes: ${s.tvmazeRegularEpisodeCount ?? 'unknown'}`
          : '- TVmaze: no candidate on file',
      );
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
