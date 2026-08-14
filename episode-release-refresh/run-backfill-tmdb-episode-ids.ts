// Episode.tmdbEpisodeId Backfill — a one-time fix for a gap Phase 1 of the
// episode-identity architecture work left behind on purpose: capturing
// TMDb's stable per-episode id only started on FUTURE Pipeline-B inserts.
// Every episode already in the database — including every already-watched
// one — still has tmdbEpisodeId: null until this backfill runs. See
// docs/episode-numbering-and-season-shift-risk.md and the architecture
// plan for the real-device investigation (Re:Zero) that found this gap.
//
// Default mode is DRY RUN: fetches every series with a confirmed TMDb
// identity, builds a per-series matching plan (tmdb-episode-id-backfill-logic.ts),
// reports it in full, writes nothing. Apply mode requires the explicit
// --apply-tmdb-episode-id-backfill flag.
//
// Safeguards (binding, per the architecture plan):
// - Matching is conservative only — season/episode-key agreement, or an
//   exact unshared (airDate, title) match. Never fuzzy/heuristic.
// - A series with ANY ambiguous match or ANY collision writes NOTHING for
//   that series — not even its otherwise-clean exact matches — until a
//   human has reviewed the flagged entries (see the markdown report's
//   "Flagged" section). This is a per-series gate, not a whole-run abort:
//   one problematic series never blocks every other series' clean backfill.
// - Never touches seasonNumber/episodeNumber, EpisodeWatch, or any other
//   column — the ONLY field this script ever writes is tmdbEpisodeId, one
//   row at a time with its own try/catch (same isolation convention as
//   run-backfill-tmdb-external-ids.ts), so one unexpected failure never
//   blocks another row.
// - The @unique constraint on Episode.tmdbEpisodeId is NOT added by this
//   script or added yet at all — that migration is a deliberate separate
//   step, run only after this backfill's real output has been inspected
//   and confirmed collision-free (safeguard #4 in the architecture plan).

import 'dotenv/config';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { MAX_APPEND_TO_RESPONSE_ITEMS, TmdbClient } from '../tmdb-enrichment/tmdb-client';
import { getAppendedSeason, TmdbSeason } from '../tmdb-enrichment/tmdb-types';
import { chunkArray } from './refresh-logic';
import { buildEpisodeBackfillPlan, LocalEpisodeForBackfill, ProviderEpisodeForBackfill } from './tmdb-episode-id-backfill-logic';
import {
  BackfillErrorEntry,
  buildTmdbEpisodeIdBackfillMarkdownReport,
  buildTmdbEpisodeIdBackfillReport,
  SeriesBackfillReportEntry,
  writeTmdbEpisodeIdBackfillReports,
} from './tmdb-episode-id-backfill-reports';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');
const APPLY_FLAG = '--apply-tmdb-episode-id-backfill';

interface CliOptions {
  outDir: string;
  apply: boolean;
  limit?: number;
  seriesId?: string;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('--apply') && !argv.includes(APPLY_FLAG)) {
    console.log(`Note: bare --apply is not the trigger for this script. Re-run with ${APPLY_FLAG} to actually write. Continuing as dry-run.`);
  }
  const options: CliOptions = { outDir: DEFAULT_OUT_DIR, apply: argv.includes(APPLY_FLAG) };
  for (const arg of argv) {
    if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice('--limit='.length));
    else if (arg.startsWith('--series=')) options.seriesId = arg.slice('--series='.length);
  }
  return options;
}

interface SeriesToBackfill {
  id: string;
  title: string;
  tmdbId: string;
  episodes: (LocalEpisodeForBackfill & { hasExistingTmdbEpisodeId: boolean })[];
}

async function loadSeriesToBackfill(prisma: PrismaClient, limit?: number, seriesId?: string): Promise<SeriesToBackfill[]> {
  const rows = await prisma.series.findMany({
    where: seriesId ? { id: seriesId } : { externalIds: { tmdbId: { not: null } } },
    take: limit,
    select: {
      id: true,
      title: true,
      externalIds: { select: { tmdbId: true } },
      seasons: {
        select: {
          seasonNumber: true,
          episodes: { select: { id: true, episodeNumber: true, title: true, airDate: true, tmdbEpisodeId: true } },
        },
      },
    },
  });

  return rows
    .filter((r) => r.externalIds?.tmdbId)
    .map((r) => ({
      id: r.id,
      title: r.title,
      tmdbId: r.externalIds!.tmdbId!,
      episodes: r.seasons.flatMap((season) =>
        season.episodes.map((ep) => ({
          id: ep.id,
          seasonNumber: season.seasonNumber,
          episodeNumber: ep.episodeNumber,
          title: ep.title,
          airDate: ep.airDate,
          hasExistingTmdbEpisodeId: ep.tmdbEpisodeId != null,
        })),
      ),
    }));
}

// Duplicated from refresh-one-series.ts/run-refresh.ts on purpose — this
// repo's convention for small per-tool I/O helpers (see those files' own
// header comments). This copy additionally captures ep.id (TMDb's stable
// episode id), which is the entire point of this script.
async function fetchProviderEpisodes(tmdb: TmdbClient, tmdbId: string, localSeasonNumbers: number[]): Promise<ProviderEpisodeForBackfill[]> {
  const details = await tmdb.getShowDetails(tmdbId);
  const providerSeasonNumbers = Array.from({ length: details.number_of_seasons ?? 0 }, (_, i) => i + 1);
  const seasonNumbers = [...new Set([...localSeasonNumbers, ...providerSeasonNumbers])].sort((a, b) => a - b);

  const episodes: ProviderEpisodeForBackfill[] = [];
  for (const batch of chunkArray(seasonNumbers, MAX_APPEND_TO_RESPONSE_ITEMS)) {
    const response = await tmdb.getSeasonsBatch(tmdbId, batch);
    for (const seasonNumber of batch) {
      const season: TmdbSeason | undefined = getAppendedSeason(response, seasonNumber);
      if (!season?.episodes) continue;
      for (const ep of season.episodes) {
        episodes.push({
          seasonNumber: ep.season_number,
          episodeNumber: ep.episode_number,
          title: ep.name ?? null,
          airDate: ep.air_date ? new Date(ep.air_date) : null,
          tmdbEpisodeId: ep.id,
        });
      }
    }
  }
  return episodes;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  const generatedAt = new Date();
  const accessToken = process.env.TMDB_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('TMDB_ACCESS_TOKEN is not set — cannot fetch provider data.');
    process.exit(1);
  }
  const tmdb = new TmdbClient({ accessToken });

  console.log(`Episode.tmdbEpisodeId Backfill — mode: ${options.apply ? 'APPLY (writes will happen for clean series)' : 'DRY RUN (no writes)'}`);

  const series = await loadSeriesToBackfill(prisma, options.limit, options.seriesId);
  console.log(`  series with a confirmed TMDb identity: ${series.length}`);

  const entries: SeriesBackfillReportEntry[] = [];
  const errors: BackfillErrorEntry[] = [];

  for (const s of series) {
    const localForMatching = s.episodes.filter((ep) => !ep.hasExistingTmdbEpisodeId);
    if (localForMatching.length === 0) {
      // Already fully backfilled (or has no episodes at all) — nothing to do,
      // not worth a report entry.
      continue;
    }

    try {
      const localSeasonNumbers = [...new Set(s.episodes.map((ep) => ep.seasonNumber))];
      const providerEpisodes = await fetchProviderEpisodes(tmdb, s.tmdbId, localSeasonNumbers);
      const plan = buildEpisodeBackfillPlan({ localEpisodes: localForMatching, providerEpisodes });
      const skippedDueToCollisionOrAmbiguity = plan.ambiguous.length > 0 || plan.collisions.length > 0;

      let appliedCount = 0;
      if (options.apply && !skippedDueToCollisionOrAmbiguity) {
        for (const match of plan.exactMatches) {
          try {
            await prisma.episode.update({ where: { id: match.localEpisodeId }, data: { tmdbEpisodeId: match.tmdbEpisodeId } });
            appliedCount++;
          } catch (err) {
            errors.push({ seriesId: s.id, seriesTitle: s.title, message: `${match.localLabel} (id ${match.localEpisodeId}): ${(err as Error).message}` });
          }
        }
      }

      entries.push({ seriesId: s.id, seriesTitle: s.title, plan, appliedCount, skippedDueToCollisionOrAmbiguity });
      const status = skippedDueToCollisionOrAmbiguity ? 'FLAGGED — skipped' : options.apply ? `applied ${appliedCount}` : `would apply ${plan.exactMatches.length}`;
      console.log(`  [${status}] ${s.title} — ${plan.exactMatches.length} exact, ${plan.ambiguous.length} ambiguous, ${plan.collisions.length} collision(s), ${plan.unmatchedLocal.length} unmatched local`);
    } catch (err) {
      errors.push({ seriesId: s.id, seriesTitle: s.title, message: (err as Error).message });
      console.log(`  [ERROR] ${s.title} — ${(err as Error).message}`);
    }
  }

  const report = buildTmdbEpisodeIdBackfillReport({ generatedAt, applied: options.apply, entries, errors });
  const markdown = buildTmdbEpisodeIdBackfillMarkdownReport(report);
  const written = writeTmdbEpisodeIdBackfillReports(options.outDir, report, markdown);

  console.log(`\nDone. Reports written:`);
  console.log(`  ${written.latestJsonPath}`);
  console.log(`  ${written.latestMarkdownPath}`);
  console.log(`  ${written.archivedJsonPath}`);
  console.log(`  ${written.archivedMarkdownPath}`);
  console.log('\nSummary:');
  console.log(
    JSON.stringify(
      {
        seriesProcessed: report.seriesProcessed,
        totalExactMatches: report.totalExactMatches,
        totalAmbiguous: report.totalAmbiguous,
        totalUnmatchedLocal: report.totalUnmatchedLocal,
        totalCollisions: report.totalCollisions,
        seriesWithAnyCollisionOrAmbiguity: report.seriesWithAnyCollisionOrAmbiguity,
        totalApplied: report.totalApplied,
        errorCount: report.errors.length,
      },
      null,
      2,
    ),
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
