// Targeted, single-series TVmaze enrichment + progress correction for
// "Mom" ONLY — not a batch operation, never touches any other series. The
// TVmaze match itself was manually confirmed by the user (Mom / CBS / 2013 /
// Ended) — this script's job is to verify the live fetch actually returns
// that exact show (never trusting the confirmation blindly), fetch its full
// episode catalog, and reconcile it against the local DB.
//
// Default mode is dry-run — nothing is written unless --apply is passed.
// Both modes recompute the exact same plan from live data (TVmaze fetch +
// current DB state), so a dry-run report can never drift from what a
// following --apply run would actually do. Aborts (writes only the dry-run
// report, with abortReasons, and never proceeds to apply) if: the local
// "Mom" match is missing/ambiguous, the live TVmaze show doesn't exactly
// match the confirmed name/network/premiered-year/status, or the desired
// next episode (S5E14) isn't present in the fetched TVmaze catalog.
//
// Writes: creates missing Season/Episode rows (full catalog completion, not
// cutoff-limited) and EpisodeWatch rows only for episodes at or before S5E13
// (the user's confirmed "watched through" point) that aren't already
// watched. Never touches an existing Episode or EpisodeWatch row. Never
// marks S5E14 or anything after it watched. Never touches Series.posterUrl/
// backdropUrl, ExternalIds, or releaseStatus — out of this task's explicit
// scope. Single transaction, single series.

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { ImportIssueSeverity, ImportStatus, PrismaClient, UserSeriesStatus } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { TvMazeClient } from '../secondary-provider-audit/tvmaze-client';
import { TvMazeEpisode } from '../secondary-provider-audit/tvmaze-types';
import {
  buildMergedEpisodeRows,
  checkAbortConditions,
  ExpectedTvMazeMatch,
  findEpisodeBySeasonEpisode,
  LocalEpisodeForPlan,
  MergedEpisodeRow,
  MomEnrichmentPlan,
  parseTvMazeDate,
  planMomEnrichment,
  SeasonEpisodeRef,
  stripHtml,
  TvMazeEpisodeForPlan,
  validateTvMazeShowMatch,
} from './mom-tvmaze-logic';

const OUT_DIR = path.join(__dirname, 'output');
const BATCH_SOURCE = 'mom-tvmaze-targeted-enrichment';

const EXPECTED_MATCH: ExpectedTvMazeMatch = { name: 'Mom', network: 'CBS', premieredYear: 2013, status: 'Ended' };
const WATCHED_THROUGH_CUTOFF: SeasonEpisodeRef = { seasonNumber: 5, episodeNumber: 13 };
const DESIRED_NEXT_EPISODE: SeasonEpisodeRef = { seasonNumber: 5, episodeNumber: 14 };
const EXPECTED_NEXT_EPISODE_TITLE = 'Charlotte Brontë and a Backhoe';

interface CliOptions {
  apply: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  return { apply: argv.includes('--apply') };
}

function seasonCounts(rows: SeasonEpisodeRef[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const r of rows) counts[r.seasonNumber] = (counts[r.seasonNumber] ?? 0) + 1;
  return counts;
}

function episodeLabel(ref: SeasonEpisodeRef, title: string | null): string {
  return `S${ref.seasonNumber}E${ref.episodeNumber}${title ? ` — "${title}"` : ''}`;
}

interface ReportData {
  generatedAt: string;
  aborted: boolean;
  abortReasons: string[];
  seriesId: string | null;
  tvMazeShowId: number | null;
  tvMazeShowMatch: { name: string; network: string | null; premiered: string | null; status: string | null } | null;
  localEpisodeCountsBySeason: Record<number, number>;
  tvMazeEpisodeCountsBySeason: Record<number, number>;
  episodesToCreate: Array<SeasonEpisodeRef & { title: string | null }>;
  episodesAlreadyExisting: Array<SeasonEpisodeRef & { title: string | null }>;
  episodeWatchesToCreate: Array<SeasonEpisodeRef & { title: string | null }>;
  episodeWatchesPreserved: number;
  previousUserStatus: string | null;
  proposedUserStatus: string | null;
  previousNextEpisodeId: string | null;
  proposedNextEpisodeLabel: string | null;
  nextEpisodeTitleCrossCheck: { expected: string; actual: string | null; matches: boolean } | null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const generatedAt = new Date();

  console.log(`Mom TVmaze targeted enrichment — mode: ${options.apply ? 'REAL APPLY' : 'DRY RUN (default)'}`);
  console.log('  Single series only (Mom). Not a batch operation.');

  const prisma = new PrismaClient();
  const tvMazeClient = new TvMazeClient();

  // --- Step 1: resolve the local "Mom" series, aborting on ambiguity ---
  const localMatches = await prisma.series.findMany({ where: { title: 'Mom' } });
  const seriesId = localMatches.length === 1 ? localMatches[0].id : null;

  // --- Step 2: live TVmaze search + validate the confirmed match ---
  const searchResults = await tvMazeClient.searchShows('Mom');
  const exactCandidates = searchResults.filter((r) => r.show.name.trim().toLowerCase() === 'mom');

  let tvMazeShowId: number | null = null;
  let showMatchValidation = { valid: false, reasons: ['no candidate named exactly "Mom" was returned by TVmaze search'] };
  let matchedShowSummary: { name: string; network: string | null; premiered: string | null; status: string | null } | null = null;

  if (exactCandidates.length > 0) {
    // Validate every exact-name candidate; only proceed if precisely one
    // also matches network/premiered-year/status (guards against a
    // same-titled different show, e.g. a different "Mom").
    const validated = exactCandidates.map((c) => ({
      candidate: c,
      validation: validateTvMazeShowMatch({ name: c.show.name, network: c.show.network?.name ?? null, premiered: c.show.premiered, status: c.show.status }, EXPECTED_MATCH),
    }));
    const fullyValid = validated.filter((v) => v.validation.valid);

    if (fullyValid.length === 1) {
      tvMazeShowId = fullyValid[0].candidate.show.id;
      showMatchValidation = fullyValid[0].validation;
      matchedShowSummary = {
        name: fullyValid[0].candidate.show.name,
        network: fullyValid[0].candidate.show.network?.name ?? null,
        premiered: fullyValid[0].candidate.show.premiered,
        status: fullyValid[0].candidate.show.status,
      };
    } else if (fullyValid.length > 1) {
      showMatchValidation = { valid: false, reasons: [`${fullyValid.length} candidates all matched name/network/premiered/status exactly — ambiguous, refusing to guess`] };
    } else {
      // Report the closest candidate's validation failure for visibility.
      showMatchValidation = validated[0].validation;
      matchedShowSummary = {
        name: validated[0].candidate.show.name,
        network: validated[0].candidate.show.network?.name ?? null,
        premiered: validated[0].candidate.show.premiered,
        status: validated[0].candidate.show.status,
      };
    }
  }

  // --- Step 3: fetch full episode catalog for the matched show (if any) ---
  let tvMazeEpisodes: TvMazeEpisodeForPlan[] = [];
  let rawEpisodes: TvMazeEpisode[] = [];
  if (tvMazeShowId !== null) {
    const showWithEpisodes = await tvMazeClient.getShowWithEpisodes(tvMazeShowId);
    rawEpisodes = showWithEpisodes._embedded?.episodes ?? [];
    tvMazeEpisodes = rawEpisodes
      .filter((ep) => ep.number !== null) // skip specials with no episode number — can't store them as a normal Episode row
      .map((ep) => ({
        seasonNumber: ep.season,
        episodeNumber: ep.number!,
        tvMazeId: ep.id,
        title: ep.name,
        overview: stripHtml(ep.summary ?? null),
        airDate: parseTvMazeDate(ep.airdate),
        runtimeMinutes: ep.runtime ?? null,
      }));
  }

  const nextEpisodeTvMazeMatch = findEpisodeBySeasonEpisode(tvMazeEpisodes, DESIRED_NEXT_EPISODE.seasonNumber, DESIRED_NEXT_EPISODE.episodeNumber);

  // --- Step 4: combined abort check ---
  const abortCheck = checkAbortConditions({
    localSeriesMatchCount: localMatches.length,
    showMatchValidation,
    nextEpisodeFoundInTvMaze: nextEpisodeTvMazeMatch !== null,
  });

  if (abortCheck.shouldAbort) {
    console.error('\nABORTING — one or more safety conditions failed:');
    for (const r of abortCheck.reasons) console.error(`  - ${r}`);

    mkdirSync(OUT_DIR, { recursive: true });
    const report: ReportData = {
      generatedAt: generatedAt.toISOString(),
      aborted: true,
      abortReasons: abortCheck.reasons,
      seriesId,
      tvMazeShowId,
      tvMazeShowMatch: matchedShowSummary,
      localEpisodeCountsBySeason: {},
      tvMazeEpisodeCountsBySeason: seasonCounts(tvMazeEpisodes),
      episodesToCreate: [],
      episodesAlreadyExisting: [],
      episodeWatchesToCreate: [],
      episodeWatchesPreserved: 0,
      previousUserStatus: null,
      proposedUserStatus: null,
      previousNextEpisodeId: null,
      proposedNextEpisodeLabel: null,
      nextEpisodeTitleCrossCheck: null,
    };
    writeFileSync(path.join(OUT_DIR, 'mom-tvmaze-enrichment-dry-run.json'), JSON.stringify(report, null, 2));
    writeFileSync(path.join(OUT_DIR, 'mom-tvmaze-enrichment-dry-run.md'), buildAbortMarkdown(report));
    console.log(`\nWrote abort report to ${path.join(OUT_DIR, 'mom-tvmaze-enrichment-dry-run.json')} / .md`);
    await prisma.$disconnect();
    process.exit(1);
  }

  // From here on, seriesId/tvMazeShowId are guaranteed non-null by the abort check above.
  const resolvedSeriesId = seriesId!;

  // --- Step 5: gather local state and build the plan ---
  const localEpisodeRows = await prisma.episode.findMany({
    where: { season: { seriesId: resolvedSeriesId } },
    include: { season: true },
  });
  const localEpisodes: LocalEpisodeForPlan[] = localEpisodeRows.map((e) => ({ seasonNumber: e.season.seasonNumber, episodeNumber: e.episodeNumber, id: e.id }));

  const existingWatches = await prisma.episodeWatch.findMany({
    where: { userId: DEV_USER_ID, episode: { season: { seriesId: resolvedSeriesId } } },
    select: { episodeId: true },
  });
  const watchedLocalEpisodeIds = new Set(existingWatches.map((w) => w.episodeId));

  const progress = await prisma.userSeriesProgress.findUnique({ where: { userId_seriesId: { userId: DEV_USER_ID, seriesId: resolvedSeriesId } } });

  const mergedRows: MergedEpisodeRow[] = buildMergedEpisodeRows(tvMazeEpisodes, localEpisodes, watchedLocalEpisodeIds);
  const plan: MomEnrichmentPlan = planMomEnrichment(mergedRows, WATCHED_THROUGH_CUTOFF);

  const nextEpisodeTitleCrossCheck = {
    expected: EXPECTED_NEXT_EPISODE_TITLE,
    actual: nextEpisodeTvMazeMatch!.title,
    matches: (nextEpisodeTvMazeMatch!.title ?? '').trim().toLowerCase() === EXPECTED_NEXT_EPISODE_TITLE.trim().toLowerCase(),
  };
  if (!nextEpisodeTitleCrossCheck.matches) {
    console.warn(
      `WARNING: TVmaze's S5E14 title ("${nextEpisodeTitleCrossCheck.actual}") does not match the user-confirmed title ("${EXPECTED_NEXT_EPISODE_TITLE}") — proceeding anyway since season/episode number is the authoritative identifier, but flagging for review.`,
    );
  }

  const proposedUserStatus = UserSeriesStatus.WATCHING;

  const dryRunReport: ReportData = {
    generatedAt: generatedAt.toISOString(),
    aborted: false,
    abortReasons: [],
    seriesId: resolvedSeriesId,
    tvMazeShowId,
    tvMazeShowMatch: matchedShowSummary,
    localEpisodeCountsBySeason: seasonCounts(localEpisodes),
    tvMazeEpisodeCountsBySeason: seasonCounts(tvMazeEpisodes),
    episodesToCreate: plan.toCreate.map((r) => ({ seasonNumber: r.seasonNumber, episodeNumber: r.episodeNumber, title: r.title })),
    episodesAlreadyExisting: plan.alreadyExists.map((r) => ({ seasonNumber: r.seasonNumber, episodeNumber: r.episodeNumber, title: r.title })),
    episodeWatchesToCreate: plan.toMarkWatched.map((r) => ({ seasonNumber: r.seasonNumber, episodeNumber: r.episodeNumber, title: r.title })),
    episodeWatchesPreserved: plan.alreadyWatchedAtOrBeforeCutoff.length,
    previousUserStatus: progress?.userStatus ?? null,
    proposedUserStatus,
    previousNextEpisodeId: progress?.nextEpisodeId ?? null,
    proposedNextEpisodeLabel: episodeLabel(DESIRED_NEXT_EPISODE, nextEpisodeTvMazeMatch!.title),
    nextEpisodeTitleCrossCheck,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, 'mom-tvmaze-enrichment-dry-run.json'), JSON.stringify(dryRunReport, null, 2));
  writeFileSync(path.join(OUT_DIR, 'mom-tvmaze-enrichment-dry-run.md'), buildDryRunMarkdown(dryRunReport));
  console.log(`\nWrote ${path.join(OUT_DIR, 'mom-tvmaze-enrichment-dry-run.json')} / .md`);
  console.log(`  Episodes to create: ${plan.toCreate.length}`);
  console.log(`  Episodes already existing: ${plan.alreadyExists.length}`);
  console.log(`  Episode watches to create (through S5E13): ${plan.toMarkWatched.length}`);
  console.log(`  Episode watches preserved (already watched, through S5E13): ${plan.alreadyWatchedAtOrBeforeCutoff.length}`);
  console.log(`  Proposed: userStatus ${dryRunReport.previousUserStatus ?? 'none'} -> ${proposedUserStatus}`);
  console.log(`  Proposed: nextEpisodeId ${dryRunReport.previousNextEpisodeId ?? 'null'} -> (S5E14, to be created/resolved)`);

  if (!options.apply) {
    console.log('\nDry run only — pass --apply to write for real.');
    await prisma.$disconnect();
    return;
  }

  // --- Apply: single transaction, single series ---
  console.log('\nApplying...');
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const batch = await tx.importBatch.create({ data: { source: BATCH_SOURCE, status: ImportStatus.RUNNING, startedAt: now } });

    // Resolve/create Season rows only for seasons this plan actually needs
    // (defensive: every write below is scoped to resolvedSeriesId, never a
    // broader query — this is what guarantees no other series is touched).
    const seasonNumbersNeeded = [...new Set(plan.toCreate.map((r) => r.seasonNumber))];
    const seasonIdByNumber = new Map<number, string>();
    for (const seasonNumber of seasonNumbersNeeded) {
      const season = await tx.season.upsert({
        where: { seriesId_seasonNumber: { seriesId: resolvedSeriesId, seasonNumber } },
        create: { seriesId: resolvedSeriesId, seasonNumber, importBatchId: batch.id },
        update: {},
      });
      seasonIdByNumber.set(seasonNumber, season.id);
    }

    const createdEpisodeIdByKey = new Map<string, string>();
    for (const ep of plan.toCreate) {
      const seasonId = seasonIdByNumber.get(ep.seasonNumber)!;
      const created = await tx.episode.create({
        data: {
          seasonId,
          episodeNumber: ep.episodeNumber,
          title: ep.title,
          overview: ep.overview,
          airDate: ep.airDate,
          runtimeMinutes: ep.runtimeMinutes,
          rawMetadata: { tvMazeEpisodeId: ep.tvMazeId, source: BATCH_SOURCE },
          importBatchId: batch.id,
        },
      });
      createdEpisodeIdByKey.set(`${ep.seasonNumber}:${ep.episodeNumber}`, created.id);
    }

    // Resolve every to-mark-watched item's real local id — either the
    // pre-existing id (rare/defensive case) or the id just created above.
    const watchesToCreate = plan.toMarkWatched.map((r) => {
      const localId = r.localEpisodeId ?? createdEpisodeIdByKey.get(`${r.seasonNumber}:${r.episodeNumber}`);
      if (!localId) throw new Error(`Could not resolve local episode id for S${r.seasonNumber}E${r.episodeNumber} — refusing to proceed`);
      return { seasonNumber: r.seasonNumber, episodeNumber: r.episodeNumber, episodeId: localId };
    });

    if (watchesToCreate.length > 0) {
      await tx.episodeWatch.createMany({
        data: watchesToCreate.map((w) => ({
          userId: DEV_USER_ID,
          episodeId: w.episodeId,
          watchedAt: now,
          // These are backfilled to complete a documented catalog gap, not
          // individually-timestamped real watch events — same convention as
          // TV Time's own bulk-import watches (see EpisodeWatch.watchDateApproximate's doc comment).
          watchDateApproximate: true,
          importBatchId: batch.id,
        })),
      });
    }

    const nextEpisodeLocalId = createdEpisodeIdByKey.get(`${DESIRED_NEXT_EPISODE.seasonNumber}:${DESIRED_NEXT_EPISODE.episodeNumber}`) ?? null;
    if (!nextEpisodeLocalId) {
      throw new Error('S5E14 was not created/resolved locally — refusing to update progress without a real nextEpisodeId');
    }

    await tx.userSeriesProgress.upsert({
      where: { userId_seriesId: { userId: DEV_USER_ID, seriesId: resolvedSeriesId } },
      create: { userId: DEV_USER_ID, seriesId: resolvedSeriesId, lastWatchedAt: now, nextEpisodeId: nextEpisodeLocalId, userStatus: proposedUserStatus },
      update: { lastWatchedAt: now, nextEpisodeId: nextEpisodeLocalId, userStatus: proposedUserStatus },
    });

    await tx.importIssue.create({
      data: {
        importBatchId: batch.id,
        severity: ImportIssueSeverity.INFO,
        relatedEntityType: 'Series',
        relatedEntityId: resolvedSeriesId,
        message: `Mom TVmaze targeted enrichment: created ${plan.toCreate.length} episode(s), created ${watchesToCreate.length} EpisodeWatch row(s) through S5E13, set userStatus=${proposedUserStatus}, nextEpisodeId -> S5E14 (${nextEpisodeLocalId}).`,
      },
    });

    await tx.importBatch.update({ where: { id: batch.id }, data: { status: ImportStatus.COMPLETED, finishedAt: new Date() } });

    return { batchId: batch.id, episodesCreated: plan.toCreate.length, watchesCreated: watchesToCreate.length, nextEpisodeLocalId };
  });

  const applyReport = {
    generatedAt: new Date().toISOString(),
    mode: 'apply',
    writesToAppTables: true,
    importBatchId: result.batchId,
    seriesId: resolvedSeriesId,
    tvMazeShowId,
    episodesCreated: result.episodesCreated,
    episodeWatchesCreated: result.watchesCreated,
    episodeWatchesPreserved: plan.alreadyWatchedAtOrBeforeCutoff.length,
    previousUserStatus: dryRunReport.previousUserStatus,
    newUserStatus: proposedUserStatus,
    previousNextEpisodeId: dryRunReport.previousNextEpisodeId,
    newNextEpisodeId: result.nextEpisodeLocalId,
    nextEpisodeLabel: episodeLabel(DESIRED_NEXT_EPISODE, nextEpisodeTvMazeMatch!.title),
  };

  writeFileSync(path.join(OUT_DIR, 'mom-tvmaze-enrichment-apply-report.json'), JSON.stringify(applyReport, null, 2));
  writeFileSync(path.join(OUT_DIR, 'mom-tvmaze-enrichment-apply-report.md'), buildApplyMarkdown(applyReport));
  console.log(`\nWrote ${path.join(OUT_DIR, 'mom-tvmaze-enrichment-apply-report.json')} / .md`);
  console.log(JSON.stringify(applyReport, null, 2));

  await prisma.$disconnect();
}

function buildAbortMarkdown(report: ReportData): string {
  const lines: string[] = [];
  lines.push('# Mom TVmaze Enrichment — ABORTED');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push('**Aborted — no data was changed.**');
  lines.push('');
  lines.push('## Reasons');
  lines.push('');
  for (const r of report.abortReasons) lines.push(`- ${r}`);
  lines.push('');
  if (report.tvMazeShowMatch) {
    lines.push('## Closest TVmaze candidate found');
    lines.push('');
    lines.push(`- name: ${report.tvMazeShowMatch.name}`);
    lines.push(`- network: ${report.tvMazeShowMatch.network ?? '_none_'}`);
    lines.push(`- premiered: ${report.tvMazeShowMatch.premiered ?? '_unknown_'}`);
    lines.push(`- status: ${report.tvMazeShowMatch.status ?? '_unknown_'}`);
    lines.push('');
  }
  return lines.join('\n');
}

function buildDryRunMarkdown(report: ReportData): string {
  const lines: string[] = [];
  lines.push('# Mom TVmaze Enrichment — Dry Run');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push('**Dry run — no data was changed.** Re-run with `--apply` to write for real (re-validates everything fresh first).');
  lines.push('');
  lines.push('## Match confirmation');
  lines.push('');
  lines.push(`- local series id: \`${report.seriesId}\``);
  lines.push(`- TVmaze show id: ${report.tvMazeShowId}`);
  lines.push(`- TVmaze match: ${report.tvMazeShowMatch?.name} · ${report.tvMazeShowMatch?.network} · premiered ${report.tvMazeShowMatch?.premiered} · status ${report.tvMazeShowMatch?.status}`);
  lines.push('');
  lines.push('## Episode counts by season');
  lines.push('');
  lines.push('| Season | Local (before) | TVmaze |');
  lines.push('|---|---|---|');
  const allSeasons = [...new Set([...Object.keys(report.localEpisodeCountsBySeason), ...Object.keys(report.tvMazeEpisodeCountsBySeason)].map(Number))].sort((a, b) => a - b);
  for (const s of allSeasons) {
    lines.push(`| ${s} | ${report.localEpisodeCountsBySeason[s] ?? 0} | ${report.tvMazeEpisodeCountsBySeason[s] ?? 0} |`);
  }
  lines.push('');
  lines.push(`## Episodes that will be created (${report.episodesToCreate.length})`);
  lines.push('');
  for (const e of report.episodesToCreate) lines.push(`- S${e.seasonNumber}E${e.episodeNumber}${e.title ? ` — "${e.title}"` : ''}`);
  if (report.episodesToCreate.length === 0) lines.push('_none_');
  lines.push('');
  lines.push(`## Episodes that already exist (${report.episodesAlreadyExisting.length}, left untouched)`);
  lines.push('');
  lines.push(`S1-S4 and S5E1-E2 (90 episodes) — see JSON for the full list.`);
  lines.push('');
  lines.push(`## EpisodeWatch rows that will be created (${report.episodeWatchesToCreate.length}, through S5E13 only)`);
  lines.push('');
  for (const e of report.episodeWatchesToCreate) lines.push(`- S${e.seasonNumber}E${e.episodeNumber}${e.title ? ` — "${e.title}"` : ''}`);
  if (report.episodeWatchesToCreate.length === 0) lines.push('_none_');
  lines.push('');
  lines.push(`## EpisodeWatch rows preserved (already watched, through S5E13): ${report.episodeWatchesPreserved}`);
  lines.push('');
  lines.push('## Progress change');
  lines.push('');
  lines.push(`- userStatus: \`${report.previousUserStatus ?? 'none'}\` → \`${report.proposedUserStatus}\``);
  lines.push(`- nextEpisodeId: \`${report.previousNextEpisodeId ?? 'null'}\` → S5E14 (created fresh, real id assigned at apply time)`);
  lines.push(`- next episode after apply: ${report.proposedNextEpisodeLabel}`);
  lines.push('');
  if (report.nextEpisodeTitleCrossCheck) {
    lines.push('## Next-episode title cross-check');
    lines.push('');
    lines.push(`- expected (user-provided): "${report.nextEpisodeTitleCrossCheck.expected}"`);
    lines.push(`- actual (TVmaze): "${report.nextEpisodeTitleCrossCheck.actual}"`);
    lines.push(`- matches: ${report.nextEpisodeTitleCrossCheck.matches ? 'YES' : 'NO — proceeding anyway, season/episode number is authoritative; flagged for review'}`);
    lines.push('');
  }
  return lines.join('\n');
}

function buildApplyMarkdown(report: {
  generatedAt: string;
  importBatchId: string;
  seriesId: string;
  tvMazeShowId: number | null;
  episodesCreated: number;
  episodeWatchesCreated: number;
  episodeWatchesPreserved: number;
  previousUserStatus: string | null;
  newUserStatus: string;
  previousNextEpisodeId: string | null;
  newNextEpisodeId: string;
  nextEpisodeLabel: string;
}): string {
  const lines: string[] = [];
  lines.push('# Mom TVmaze Enrichment — Apply Report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push('**Applied for real — single series (Mom), single transaction.**');
  lines.push('');
  lines.push(`- import batch id: \`${report.importBatchId}\``);
  lines.push(`- series id: \`${report.seriesId}\``);
  lines.push(`- TVmaze show id: ${report.tvMazeShowId}`);
  lines.push(`- episodes created: ${report.episodesCreated}`);
  lines.push(`- episode watches created: ${report.episodeWatchesCreated}`);
  lines.push(`- episode watches preserved (untouched, already watched through S5E13): ${report.episodeWatchesPreserved}`);
  lines.push(`- userStatus: \`${report.previousUserStatus ?? 'none'}\` → \`${report.newUserStatus}\``);
  lines.push(`- nextEpisodeId: \`${report.previousNextEpisodeId ?? 'null'}\` → \`${report.newNextEpisodeId}\``);
  lines.push(`- next episode: ${report.nextEpisodeLabel}`);
  lines.push('');
  return lines.join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
