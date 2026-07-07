// Read-only image-coverage report. Never writes to any app table — queries
// the current database plus the most recent tmdb-enrichment dry-run's saved
// needs-review/data-quality files (matched by exact title, same technique
// used by the recovery remap tools — those files' seriesIds may be stale
// after a database rebuild, but title is a stable enough key for this
// report's purposes), and writes report files only.

import 'dotenv/config';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { detectDuplicateTitleGroups } from '../tmdb-enrichment/data-quality';
import { classifyMissingImage, ImageCoverageIssueCategory } from './classify';

const DEFAULT_OUTPUT_DIR = path.join(__dirname, 'output');
const TMDB_ENRICHMENT_OUTPUT_ROOT = path.join(__dirname, '..', 'tmdb-enrichment', 'output');

interface CliOptions {
  outDir: string;
  tmdbBatchDir?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { outDir: DEFAULT_OUTPUT_DIR };
  for (const arg of argv) {
    if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
    else if (arg.startsWith('--tmdb-batch=')) options.tmdbBatchDir = path.resolve(arg.slice('--tmdb-batch='.length));
  }
  return options;
}

function findLatestTmdbBatchDir(): string | null {
  if (!existsSync(TMDB_ENRICHMENT_OUTPUT_ROOT)) return null;
  const dirs = readdirSync(TMDB_ENRICHMENT_OUTPUT_ROOT)
    .map((name) => path.join(TMDB_ENRICHMENT_OUTPUT_ROOT, name))
    .filter((p) => statSync(p).isDirectory() && existsSync(path.join(p, 'tmdb-needs-review.json')))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0] ?? null;
}

interface NeedsReviewEntry {
  mytvSeriesTitle: string;
  tier: 'NEEDS_REVIEW' | 'NO_MATCH';
  closeCompetitorDetected: boolean;
}

interface DataQualityEntry {
  mytvSeriesTitle: string;
  issueType: string;
}

interface EnrichmentReportCandidate {
  mytvSeriesTitle: string;
}

interface SeriesReportRow {
  seriesId: string;
  title: string;
  hasTmdbMatch: boolean;
  missingPoster: boolean;
  missingBackdrop: boolean;
  category: ImageCoverageIssueCategory | null; // null when the series has both images
  reason: string | null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tmdbBatchDir = options.tmdbBatchDir ?? findLatestTmdbBatchDir();

  console.log('Image coverage report — read-only, writes report files only, never app tables.');
  console.log(`  TMDb dry-run source: ${tmdbBatchDir ?? 'none found — mismatch/prior-attempt detection will be unavailable'}`);

  let needsReviewByTitle = new Map<string, NeedsReviewEntry>();
  let dataQualityFlaggedTitles = new Set<string>();
  let priorDryRunTitles = new Set<string>();

  if (tmdbBatchDir) {
    const needsReview: NeedsReviewEntry[] = JSON.parse(readFileSync(path.join(tmdbBatchDir, 'tmdb-needs-review.json'), 'utf-8'));
    needsReviewByTitle = new Map(needsReview.map((e) => [e.mytvSeriesTitle, e]));
    priorDryRunTitles = new Set(needsReview.map((e) => e.mytvSeriesTitle));

    const dataQualityPath = path.join(tmdbBatchDir, 'tmdb-data-quality-issues.json');
    if (existsSync(dataQualityPath)) {
      const dataQuality: DataQualityEntry[] = JSON.parse(readFileSync(dataQualityPath, 'utf-8'));
      dataQualityFlaggedTitles = new Set(
        dataQuality.filter((d) => d.issueType === 'REMAKE_COLLISION' || d.issueType === 'DUPLICATE_TITLE_DIFFERENT_YEAR_SUFFIX').map((d) => d.mytvSeriesTitle),
      );
    }

    const enrichmentReportPath = path.join(tmdbBatchDir, 'tmdb-enrichment-report.json');
    if (existsSync(enrichmentReportPath)) {
      const enrichmentReport = JSON.parse(readFileSync(enrichmentReportPath, 'utf-8'));
      const autoMatchCandidates: EnrichmentReportCandidate[] = enrichmentReport.autoMatchCandidates ?? [];
      for (const c of autoMatchCandidates) priorDryRunTitles.add(c.mytvSeriesTitle);
    }
  }

  const prisma = new PrismaClient();

  const series = await prisma.series.findMany({
    select: { id: true, title: true, posterUrl: true, backdropUrl: true, externalIds: { select: { tmdbId: true } } },
    orderBy: { title: 'asc' },
  });

  const duplicateGroups = detectDuplicateTitleGroups(series.map((s) => ({ id: s.id, title: s.title })));
  const duplicateTitles = new Set(duplicateGroups.flatMap((g) => g.members.map((m) => m.title)));

  const [episodesWithImage, episodesWithoutImage] = await Promise.all([
    prisma.episode.count({ where: { imageUrl: { not: null } } }),
    prisma.episode.count({ where: { imageUrl: null } }),
  ]);

  await prisma.$disconnect();

  const rows: SeriesReportRow[] = series.map((s) => {
    const hasTmdbMatch = s.externalIds?.tmdbId != null;
    const missingPoster = !s.posterUrl;
    const missingBackdrop = !s.backdropUrl;

    if (!missingPoster && !missingBackdrop) {
      return { seriesId: s.id, title: s.title, hasTmdbMatch, missingPoster, missingBackdrop, category: null, reason: null };
    }

    const needsReview = needsReviewByTitle.get(s.title);
    const isPossibleMismatch = dataQualityFlaggedTitles.has(s.title) || duplicateTitles.has(s.title) || !!needsReview?.closeCompetitorDetected;
    const hasPriorDryRunData = priorDryRunTitles.has(s.title);

    const { category, reason } = classifyMissingImage({ hasTmdbMatch, isPossibleMismatch, hasPriorDryRunData });

    return { seriesId: s.id, title: s.title, hasTmdbMatch, missingPoster, missingBackdrop, category, reason };
  });

  const missingRows = rows.filter((r) => r.category !== null);
  const counts: Record<string, number> = {};
  for (const r of missingRows) counts[r.category!] = (counts[r.category!] ?? 0) + 1;

  const summary = {
    totalSeries: series.length,
    seriesWithPoster: series.filter((s) => s.posterUrl).length,
    seriesWithoutPoster: series.filter((s) => !s.posterUrl).length,
    seriesWithBackdrop: series.filter((s) => s.backdropUrl).length,
    seriesWithoutBackdrop: series.filter((s) => !s.backdropUrl).length,
    enrichedSeries: series.filter((s) => s.externalIds?.tmdbId != null).length,
    unenrichedSeries: series.filter((s) => s.externalIds?.tmdbId == null).length,
    episodesWithImage,
    episodesWithoutImage,
    totalEpisodes: episodesWithImage + episodesWithoutImage,
    missingImageIssueCounts: counts,
  };

  console.log('\n' + JSON.stringify(summary, null, 2));

  mkdirSync(options.outDir, { recursive: true });

  const jsonReport = {
    generatedAt: new Date().toISOString(),
    tmdbDryRunSource: tmdbBatchDir,
    writesToAppTables: false,
    summary,
    seriesMissingImages: missingRows,
    duplicateTitleGroups: duplicateGroups,
  };
  const jsonPath = path.join(options.outDir, 'image-coverage-report.json');
  writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2));
  console.log(`\nWrote ${jsonPath}`);

  const mdPath = path.join(options.outDir, 'image-coverage-report.md');
  writeFileSync(mdPath, buildMarkdown(summary, missingRows));
  console.log(`Wrote ${mdPath}`);
}

function buildMarkdown(summary: Record<string, unknown>, missingRows: SeriesReportRow[]): string {
  const lines: string[] = [];
  lines.push('# Image Coverage Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  for (const [key, value] of Object.entries(summary)) {
    if (key === 'missingImageIssueCounts') continue;
    lines.push(`- ${key}: ${value}`);
  }
  lines.push('');
  lines.push('## Missing-image issue breakdown');
  lines.push('');
  for (const [category, count] of Object.entries(summary.missingImageIssueCounts as Record<string, number>)) {
    lines.push(`- **${category}**: ${count}`);
  }
  lines.push('');
  lines.push('## Series missing images, by category');
  lines.push('');
  const byCategory = new Map<string, SeriesReportRow[]>();
  for (const r of missingRows) {
    const list = byCategory.get(r.category!) ?? [];
    list.push(r);
    byCategory.set(r.category!, list);
  }
  for (const [category, rows] of byCategory) {
    lines.push(`### ${category} (${rows.length})`);
    lines.push('');
    for (const r of rows) {
      const missing = [r.missingPoster ? 'poster' : null, r.missingBackdrop ? 'backdrop' : null].filter(Boolean).join('+');
      lines.push(`- ${r.title} — missing ${missing}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
