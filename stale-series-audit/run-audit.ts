// Read-only stale-series ("Haven't Watched For A While") accuracy audit.
// Never writes to any app table — replicates MeService.getStaleSeries'
// exact query, cross-references the documented episode-numbering risk list
// and cached single-series-enrichment reports, and writes report files only.
//
// This is a single atomic snapshot: userSeriesProgress can change in real
// time (a user actively marking episodes watched via the live app), so
// every number here is only as fresh as generatedAt below.

import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { PrismaClient, UserSeriesStatus } from '@prisma/client';
import { titleSimilarity } from '../trakt-enrichment/scoring';
import { DEV_USER_ID } from '../src/common/constants';
import { isEpisodeReleased } from '../src/common/is-episode-released';
import { classifyStaleSeries, RecommendedAction, StaleSeriesCategory } from './classify';

const OUT_DIR = path.join(__dirname, 'output');
const SINGLE_SERIES_OUTPUT_DIR = path.join(__dirname, '..', 'tmdb-enrichment', 'output', 'single-series');
const RISK_LIST_DOC = path.join(__dirname, '..', 'docs', 'episode-numbering-and-season-shift-risk.md');

// Same include-list as MeService.getStaleSeries (docs/status-model-plan.md §8).
const STALE_INCLUDED_STATUSES: UserSeriesStatus[] = [UserSeriesStatus.WATCHING, UserSeriesStatus.CAUGHT_UP];

// Same default as StaleSeriesQueryDto.afterDays — matches what the app's
// Home screen actually requests today. The product definition in this
// audit's brief describes a "3+ months" notion of staleness, which does not
// match this 30-day default; that mismatch is reported as a finding below,
// not silently changed.
const DEFAULT_AFTER_DAYS = 30;

// The explicit "do not trust" list from
// docs/episode-numbering-and-season-shift-risk.md §5 — kept as a literal
// array (not parsed from the doc's prose) so the check is exact and
// auditable; the doc's existence is still verified below so this list can
// never silently drift from "the doc exists but says something different."
const RISK_LIST_TITLES = ['Jujutsu Kaisen', 'JUJUTSU KAISEN', 'Rurouni Kenshin', 'One Piece', 'ONE PIECE (2023)', 'InuYasha', "InuYasha: The Final Act"];

const TITLE_DUPLICATE_SIMILARITY_THRESHOLD = 0.85;

interface StaleSeriesAuditRow {
  seriesId: string;
  seriesTitle: string;
  userStatus: string;
  releaseStatus: string;
  lastWatchedAt: string | null;
  daysSinceLastWatched: number | null;
  nextEpisodeId: string | null;
  nextEpisode: { seasonNumber: number; episodeNumber: number; title: string | null; airDate: string | null } | null;
  nextEpisodeIsReleased: boolean | null;
  lastWatchedEpisode: { seasonNumber: number; episodeNumber: number; title: string | null; watchedAt: string } | null;
  watchedEpisodeCount: number;
  knownEpisodeCount: number;
  releasedKnownEpisodeCount: number;
  hasTmdbMatch: boolean;
  onRiskList: boolean;
  enrichedInBatch: boolean;
  hasKnownSeasonShiftOrphan: boolean;
  nextEpisodeTitleDuplicatesLastWatched: boolean;
  hasSeasonZeroOrEpisodeZero: boolean;
  watchedCloseToReleasedCount: boolean;
  nextEpisodeIsSequential: boolean | null;
  category: StaleSeriesCategory;
  recommendedAction: RecommendedAction;
  reason: string;
}

function loadBatchOrphanInfo(seriesId: string): { watchedAtApply: number; matchedAtApply: number } | null {
  const dryRunPath = path.join(SINGLE_SERIES_OUTPUT_DIR, `${seriesId}-dry-run-report.json`);
  const applyPath = path.join(SINGLE_SERIES_OUTPUT_DIR, `${seriesId}-apply-report.json`);
  const reportPath = existsSync(applyPath) ? applyPath : existsSync(dryRunPath) ? dryRunPath : null;
  if (!reportPath) return null;

  const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
  return {
    watchedAtApply: report.watchedEpisodeCountPreserved,
    matchedAtApply: report.planned.episodesUpdated.length,
  };
}

async function main() {
  console.log('Stale-series accuracy audit — read-only, writes report files only, never app tables.');

  if (!existsSync(RISK_LIST_DOC)) {
    console.error(`Risk-list doc not found at ${RISK_LIST_DOC} — refusing to proceed without it (this report depends on it).`);
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const userId = DEV_USER_ID;
  const generatedAt = new Date();
  const cutoff = new Date(generatedAt.getTime() - DEFAULT_AFTER_DAYS * 24 * 60 * 60 * 1000);

  const progress = await prisma.userSeriesProgress.findMany({
    where: {
      userId,
      userStatus: { in: STALE_INCLUDED_STATUSES },
      lastWatchedAt: { not: null, lt: cutoff },
    },
    orderBy: { lastWatchedAt: 'asc' },
    include: {
      series: { include: { externalIds: true } },
      nextEpisode: { include: { season: true } },
    },
  });

  const rows: StaleSeriesAuditRow[] = [];

  for (const p of progress) {
    const series = p.series;
    const seriesId = p.seriesId;
    const nextEp = p.nextEpisode;

    const watchRows = await prisma.episodeWatch.findMany({
      where: { userId, episode: { season: { seriesId } } },
      orderBy: { watchedAt: 'desc' },
      include: { episode: { include: { season: true } } },
    });

    const knownEpisodes = await prisma.episode.findMany({
      where: { season: { seriesId } },
      include: { season: true },
    });
    const knownEpisodeCount = knownEpisodes.length;
    const releasedKnownEpisodeCount = knownEpisodes.filter((e) => isEpisodeReleased(e.airDate, generatedAt)).length;
    const hasSeasonZeroOrEpisodeZero = knownEpisodes.some((e) => e.season.seasonNumber === 0 || e.episodeNumber === 0);

    const lastWatch = watchRows[0];
    const lastWatchedEpisode = lastWatch
      ? {
          seasonNumber: lastWatch.episode.season.seasonNumber,
          episodeNumber: lastWatch.episode.episodeNumber,
          title: lastWatch.episode.title,
          watchedAt: lastWatch.watchedAt.toISOString(),
        }
      : null;

    const onRiskList = RISK_LIST_TITLES.includes(series.title);
    const batchOrphanInfo = loadBatchOrphanInfo(seriesId);
    const enrichedInBatch = batchOrphanInfo !== null;
    const hasKnownSeasonShiftOrphan = batchOrphanInfo !== null && batchOrphanInfo.matchedAtApply < batchOrphanInfo.watchedAtApply;

    const hasTmdbMatch = !!series.externalIds?.tmdbId;
    const hasNextEpisode = !!p.nextEpisodeId && !!nextEp;
    const nextEpisodeDataIncomplete = hasNextEpisode ? !nextEp!.title && !nextEp!.airDate : false;
    const nextEpisodeTitleDuplicatesLastWatched =
      hasNextEpisode && !!nextEp!.title && !!lastWatchedEpisode?.title && titleSimilarity(nextEp!.title, lastWatchedEpisode.title) >= TITLE_DUPLICATE_SIMILARITY_THRESHOLD;

    // Informational only (not a classification input): does nextEpisode
    // immediately follow the last-watched episode in season/episode order?
    // Either the same season with episodeNumber+1, or season+1 episode 1.
    let nextEpisodeIsSequential: boolean | null = null;
    if (hasNextEpisode && lastWatchedEpisode) {
      const sameSeasonNext = nextEp!.season.seasonNumber === lastWatchedEpisode.seasonNumber && nextEp!.episodeNumber === lastWatchedEpisode.episodeNumber + 1;
      const nextSeasonFirst = nextEp!.season.seasonNumber === lastWatchedEpisode.seasonNumber + 1 && nextEp!.episodeNumber === 1;
      nextEpisodeIsSequential = sameSeasonNext || nextSeasonFirst;
    }

    const daysSinceLastWatched = p.lastWatchedAt ? Math.floor((generatedAt.getTime() - p.lastWatchedAt.getTime()) / (24 * 60 * 60 * 1000)) : null;
    const watchedCloseToReleasedCount = releasedKnownEpisodeCount > 0 && watchRows.length >= releasedKnownEpisodeCount - 1;

    const { category, recommendedAction, reason } = classifyStaleSeries({
      isOnRiskList: onRiskList,
      userStatusIsCaughtUp: p.userStatus === UserSeriesStatus.CAUGHT_UP,
      hasNextEpisode,
      hasTmdbMatch,
      nextEpisodeDataIncomplete,
      hasKnownSeasonShiftOrphan,
      nextEpisodeTitleDuplicatesLastWatched,
      hasSeasonZeroOrEpisodeZero,
    });

    rows.push({
      seriesId,
      seriesTitle: series.title,
      userStatus: p.userStatus,
      releaseStatus: series.releaseStatus,
      lastWatchedAt: p.lastWatchedAt?.toISOString() ?? null,
      daysSinceLastWatched,
      nextEpisodeId: p.nextEpisodeId,
      nextEpisode: hasNextEpisode
        ? {
            seasonNumber: nextEp!.season.seasonNumber,
            episodeNumber: nextEp!.episodeNumber,
            title: nextEp!.title,
            airDate: nextEp!.airDate?.toISOString() ?? null,
          }
        : null,
      nextEpisodeIsReleased: hasNextEpisode ? isEpisodeReleased(nextEp!.airDate, generatedAt) : null,
      lastWatchedEpisode,
      watchedEpisodeCount: watchRows.length,
      knownEpisodeCount,
      releasedKnownEpisodeCount,
      hasTmdbMatch,
      onRiskList,
      enrichedInBatch,
      hasKnownSeasonShiftOrphan,
      nextEpisodeTitleDuplicatesLastWatched,
      hasSeasonZeroOrEpisodeZero,
      watchedCloseToReleasedCount,
      nextEpisodeIsSequential,
      category,
      recommendedAction,
      reason,
    });
  }

  await prisma.$disconnect();

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.category] = (counts[r.category] ?? 0) + 1;

  console.log(`\nGenerated at: ${generatedAt.toISOString()}`);
  console.log(JSON.stringify({ staleSeriesCount: rows.length, byCategory: counts }, null, 2));

  mkdirSync(OUT_DIR, { recursive: true });

  const jsonReport = {
    generatedAt: generatedAt.toISOString(),
    note: 'userSeriesProgress can change in real time — treat this as a single point-in-time snapshot, not a live view.',
    writesToAppTables: false,
    afterDaysUsed: DEFAULT_AFTER_DAYS,
    findings: [
      "GET /me/stale-series has no nextEpisodeId requirement at all (unlike GET /me/watch-next's nextEpisodeId: { not: null }), so a WATCHING row with no known next episode is included purely because lastWatchedAt is old.",
      'GET /me/stale-series includes CAUGHT_UP rows purely by lastWatchedAt age, with no check that anything is actually left to watch — CAUGHT_UP means nothing is left by definition.',
      "GET /me/stale-series never runs nextEpisode through filterReleasedNextEpisodes or any other trust/release check the way GET /me/watch-next does.",
      `This audit's product definition describes staleness as "3+ months" (~90 days), but the endpoint's actual default afterDays is ${DEFAULT_AFTER_DAYS} — the current default is stricter than the stated product intent.`,
      'releasedKnownEpisodeCount reads as 0 for most unenriched (TV Time import only) series even when many episodes were watched — TV Time carries no airDate data at all, and a null airDate is conservatively treated as "not released" (src/common/is-episode-released.ts). Do not read a low releasedKnownEpisodeCount on a DATA_INCOMPLETE item as "nothing has aired" — it means airDate is simply unknown until the series is enriched.',
    ],
    riskListSource: RISK_LIST_DOC,
    summary: { staleSeriesCount: rows.length, byCategory: counts },
    items: rows,
  };
  const jsonPath = path.join(OUT_DIR, 'stale-series-accuracy-report.json');
  writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2));
  console.log(`\nWrote ${jsonPath}`);

  const mdPath = path.join(OUT_DIR, 'stale-series-accuracy-report.md');
  writeFileSync(mdPath, buildMarkdown(generatedAt, rows, counts, jsonReport.findings));
  console.log(`Wrote ${mdPath}`);
}

// Task 7's shorter, human-facing "suggested manual decision" vocabulary —
// intentionally distinct from the system's recommendedAction field (task 5's
// 6-option vocabulary). Mapped to the closest fit; the checkbox itself is
// left unchecked in the markdown for a human to consciously decide, matching
// the watch-next-review precedent.
const MANUAL_DECISION_OPTIONS = ['keep_in_stale', 'mark_caught_up', 'exclude_until_mapped', 'needs_mapping', 'ignore_for_now'] as const;

function suggestedManualDecision(action: RecommendedAction): (typeof MANUAL_DECISION_OPTIONS)[number] {
  switch (action) {
    case 'keep_in_stale':
      return 'keep_in_stale';
    case 'mark_caught_up':
      return 'mark_caught_up';
    case 'exclude_from_stale_until_mapped':
      return 'exclude_until_mapped';
    case 'needs_manual_mapping':
      return 'needs_mapping';
    case 'needs_user_confirmation':
    case 'enrich_catalog_first':
      return 'ignore_for_now';
  }
}

const CATEGORY_ORDER: StaleSeriesCategory[] = [
  'RISK_LIST_DO_NOT_TRUST',
  'SHOULD_BE_CAUGHT_UP',
  'DATA_INCOMPLETE',
  'NEEDS_USER_CONFIRMATION',
  'POSSIBLE_SEASON_SHIFT',
  'POSSIBLE_DUPLICATE_EPISODES',
  'POSSIBLE_SPECIALS_MISMATCH',
  'TRUE_STALE_WATCHING',
];

function buildMarkdown(generatedAt: Date, rows: StaleSeriesAuditRow[], counts: Record<string, number>, findings: string[]): string {
  const lines: string[] = [];
  lines.push('# Stale-Series Accuracy Report');
  lines.push('');
  lines.push(`Generated: ${generatedAt.toISOString()}`);
  lines.push('');
  lines.push('**Note**: userSeriesProgress can change in real time (e.g. a user marking episodes watched via the live app). This is a single point-in-time snapshot. Report only — no data was changed.');
  lines.push('');
  lines.push('## Findings on current /me/stale-series logic');
  lines.push('');
  for (const f of findings) lines.push(`- ${f}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Current /me/stale-series count: ${rows.length}`);
  for (const category of CATEGORY_ORDER) lines.push(`- **${category}**: ${counts[category] ?? 0}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const category of CATEGORY_ORDER) {
    const items = rows.filter((r) => r.category === category);
    if (items.length === 0) continue;

    lines.push(`## ${category} (${items.length})`);
    lines.push('');

    for (const r of items) {
      lines.push(`### ${r.seriesTitle}`);
      lines.push('');
      lines.push(`**Reason**: ${r.reason}`);
      lines.push('');
      lines.push(`- series id: \`${r.seriesId}\``);
      lines.push(`- current backend opinion: userStatus=${r.userStatus} · releaseStatus=${r.releaseStatus}`);
      lines.push(`- lastWatchedAt: ${r.lastWatchedAt?.slice(0, 10) ?? '_none_'} (${r.daysSinceLastWatched ?? '?'} days ago)`);
      lines.push(`- watched: ${r.watchedEpisodeCount} of ${r.knownEpisodeCount} known episodes (${r.releasedKnownEpisodeCount} released known); watched count close to/at released count: ${r.watchedCloseToReleasedCount ? 'YES' : 'no'}`);
      lines.push(`- has confirmed TMDb match: ${r.hasTmdbMatch ? 'YES' : 'no'} · on episode-numbering risk list: ${r.onRiskList ? 'YES' : 'no'} · enriched in targeted batch: ${r.enrichedInBatch ? 'YES' : 'no'}`);
      lines.push(
        r.nextEpisode
          ? `- next episode: S${r.nextEpisode.seasonNumber}E${r.nextEpisode.episodeNumber}${r.nextEpisode.title ? ` — "${r.nextEpisode.title}"` : ' (no title on file)'} (airDate: ${r.nextEpisode.airDate?.slice(0, 10) ?? 'unknown'}, released: ${r.nextEpisodeIsReleased ? 'yes' : 'no'}, sequential after last watched: ${r.nextEpisodeIsSequential === null ? 'n/a' : r.nextEpisodeIsSequential ? 'yes' : 'no'})`
          : '- next episode: _none (nextEpisodeId is null)_',
      );
      lines.push(
        r.lastWatchedEpisode
          ? `- last watched: S${r.lastWatchedEpisode.seasonNumber}E${r.lastWatchedEpisode.episodeNumber}${r.lastWatchedEpisode.title ? ` — "${r.lastWatchedEpisode.title}"` : ''} on ${r.lastWatchedEpisode.watchedAt.slice(0, 10)}`
          : '- last watched: _none recorded_',
      );
      lines.push(`- season 0 / episode 0 present in catalog: ${r.hasSeasonZeroOrEpisodeZero ? 'YES' : 'no'} · next episode title duplicates last watched: ${r.nextEpisodeTitleDuplicatesLastWatched ? 'YES' : 'no'} · known season-shift orphan: ${r.hasKnownSeasonShiftOrphan ? 'YES' : 'no'}`);
      lines.push(`- system recommendedAction: \`${r.recommendedAction}\``);
      lines.push('');
      lines.push(`Suggested manual decision (fill in): ${MANUAL_DECISION_OPTIONS.map((o) => `[ ] ${o}`).join('  ')}  _(system suggests: ${suggestedManualDecision(r.recommendedAction)})_`);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  return lines.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
