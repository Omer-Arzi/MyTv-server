// Read-only manual progress correction PLAN — never writes to any app
// table. Generates a proposed correction for each of 19 user-provided manual
// decisions on known provider-risk/mismatch series (docs/episode-numbering-
// and-season-shift-risk.md), gathers each series' real current DB state, and
// reports what a safe apply step would change — without applying it.
//
// Each item's series id, confidence, and risk notes below were determined by
// directly inspecting the current DB (season/episode breakdowns, watched
// counts, external ids) before writing this file — see the report's
// `investigationNotes` field on each item for the specific finding. This is
// deliberately NOT a generic classifier: 19 distinct manual decisions don't
// reduce to one inferred rule the way a single audit category does.

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { PrismaClient, ReleaseStatus, UserSeriesStatus } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import {
  computeUnwatchedKnownEpisodes,
  deriveStatusAfterMarkAllWatched,
  EpisodeRef,
  findEpisodeByAbsolutePosition,
  findEpisodeByExactTitle,
  findEpisodeBySeasonEpisode,
} from './plan-logic';

const OUT_DIR = path.join(__dirname, 'output');

type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';
type ReadinessCategory = 'SAFE_TO_APPLY' | 'NEEDS_MAPPING' | 'AMBIGUOUS' | 'DO_NOT_TOUCH' | 'DATA_INCOMPLETE';

interface EpisodeLabel {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
}

interface CorrectionPlanItem {
  itemKey: string;
  itemLabel: string;
  userRequestSummary: string;
  matchedSeriesTitle: string | null;
  matchedSeriesId: string | null;
  confidence: Confidence;
  readinessCategory: ReadinessCategory;
  current: {
    userStatus: string | null;
    releaseStatus: string | null;
    externalIds: { tmdbId: string | null; traktId: string | null; imdbId: string | null; matchSource: string | null } | null;
    watchedEpisodeCount: number;
    knownEpisodeCount: number;
    nextEpisodeId: string | null;
    nextEpisodeLabel: string | null;
    lastWatchedAt: string | null;
    inWatchNext?: boolean;
    inStaleSeries?: boolean;
  };
  proposedAction: string;
  episodesToMarkWatched: EpisodeLabel[];
  progressChange: {
    userStatus: { from: string | null; to: string | null };
    nextEpisodeId: { from: string | null; to: string | null };
  } | null;
  investigationNotes: string[];
  risks: string[];
  requiresUserConfirmation: boolean;
  // Optional per-item hint copied into the decisions template's `notes`
  // field — used sparingly (see Devil May Cry (2025) below) when an item's
  // recommended manual decision needs to be spelled out beyond what
  // proposedAction/readinessCategory already convey.
  templateNoteHint?: string;
}

function toEpisodeRef(e: { id: string; episodeNumber: number; title: string | null; airDate: Date | null; season: { seasonNumber: number } }): EpisodeRef {
  return { id: e.id, seasonNumber: e.season.seasonNumber, episodeNumber: e.episodeNumber, title: e.title, airDate: e.airDate };
}

function toLabel(e: EpisodeRef | null): EpisodeLabel | null {
  return e ? { id: e.id, seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber, title: e.title } : null;
}

function labelText(e: EpisodeLabel | null): string | null {
  if (!e) return null;
  return `S${e.seasonNumber}E${e.episodeNumber}${e.title ? ` — "${e.title}"` : ''}`;
}

interface SeriesSnapshot {
  seriesId: string;
  title: string;
  releaseStatus: ReleaseStatus;
  externalIds: { tmdbId: string | null; traktId: string | null; imdbId: string | null; matchSource: string | null } | null;
  userStatus: UserSeriesStatus | null;
  lastWatchedAt: Date | null;
  nextEpisodeId: string | null;
  nextEpisodeLabel: EpisodeLabel | null;
  episodes: EpisodeRef[]; // ordered season asc, episode asc
  watchedEpisodeIds: Set<string>;
}

async function loadSnapshot(prisma: PrismaClient, seriesId: string): Promise<SeriesSnapshot | null> {
  const series = await prisma.series.findUnique({ where: { id: seriesId }, include: { externalIds: true } });
  if (!series) return null;

  const progress = await prisma.userSeriesProgress.findUnique({
    where: { userId_seriesId: { userId: DEV_USER_ID, seriesId } },
    include: { nextEpisode: { include: { season: true } } },
  });

  const episodeRows = await prisma.episode.findMany({
    where: { season: { seriesId } },
    include: { season: true },
    orderBy: [{ season: { seasonNumber: 'asc' } }, { episodeNumber: 'asc' }],
  });

  const watches = await prisma.episodeWatch.findMany({
    where: { userId: DEV_USER_ID, episode: { season: { seriesId } } },
    select: { episodeId: true },
  });

  return {
    seriesId,
    title: series.title,
    releaseStatus: series.releaseStatus,
    externalIds: series.externalIds
      ? {
          tmdbId: series.externalIds.tmdbId,
          traktId: series.externalIds.traktId,
          imdbId: series.externalIds.imdbId,
          matchSource: series.externalIds.matchSource,
        }
      : null,
    userStatus: progress?.userStatus ?? null,
    lastWatchedAt: progress?.lastWatchedAt ?? null,
    nextEpisodeId: progress?.nextEpisodeId ?? null,
    nextEpisodeLabel: progress?.nextEpisode
      ? { id: progress.nextEpisode.id, seasonNumber: progress.nextEpisode.season.seasonNumber, episodeNumber: progress.nextEpisode.episodeNumber, title: progress.nextEpisode.title }
      : null,
    episodes: episodeRows.map(toEpisodeRef),
    watchedEpisodeIds: new Set(watches.map((w) => w.episodeId)),
  };
}

function baseCurrent(s: SeriesSnapshot) {
  return {
    userStatus: s.userStatus,
    releaseStatus: s.releaseStatus,
    externalIds: s.externalIds,
    watchedEpisodeCount: s.watchedEpisodeIds.size,
    knownEpisodeCount: s.episodes.length,
    nextEpisodeId: s.nextEpisodeId,
    nextEpisodeLabel: labelText(s.nextEpisodeLabel),
    lastWatchedAt: s.lastWatchedAt?.toISOString() ?? null,
  };
}

// Item type: "user says they watched everything currently known/released;
// mark it all watched and derive the resulting status." Every one of the 15
// series this applies to already has watchedEpisodeCount === knownEpisodeCount
// today (verified below in each item's investigationNotes) — none are
// enriched (no airDate data), so this always ends up proposing a pure status
// transition with zero newly-marked episodes, not an actual batch of writes.
function planMarkAllKnownWatched(s: SeriesSnapshot, itemKey: string, itemLabel: string, userRequestSummary: string, extraNotes: string[] = [], extraRisks: string[] = []): CorrectionPlanItem {
  const unwatched = computeUnwatchedKnownEpisodes(s.episodes, s.watchedEpisodeIds);
  const proposedStatus = deriveStatusAfterMarkAllWatched(s.releaseStatus);
  const notes = [
    `Current DB state: ${s.watchedEpisodeIds.size} of ${s.episodes.length} known episodes already watched; ${unwatched.length} unwatched known episode(s) found.`,
    ...extraNotes,
  ];
  const risks = [
    `releaseStatus is ${s.releaseStatus} (${s.externalIds?.tmdbId ? 'enriched' : 'not enriched — no TMDb match'}) — proposed status is CAUGHT_UP unless releaseStatus is already ENDED/CANCELLED, per the app's own deriveUserStatusFromNextEpisode default; would become COMPLETED only once enrichment confirms the show has ended.`,
    'No known episode has airDate data (unenriched) — "released" cannot be independently verified from provider data; this proposal trusts the user\'s explicit statement instead, per this task\'s manual-decision framing.',
    ...extraRisks,
  ];

  return {
    itemKey,
    itemLabel,
    userRequestSummary,
    matchedSeriesTitle: s.title,
    matchedSeriesId: s.seriesId,
    confidence: 'HIGH',
    readinessCategory: 'SAFE_TO_APPLY',
    current: baseCurrent(s),
    proposedAction: unwatched.length > 0 ? 'mark_unwatched_known_episodes_watched_then_set_status' : 'set_status_only_no_episodes_to_mark',
    episodesToMarkWatched: unwatched.map((e) => toLabel(e)!),
    progressChange: {
      userStatus: { from: s.userStatus, to: proposedStatus },
      nextEpisodeId: { from: s.nextEpisodeId, to: null },
    },
    investigationNotes: notes,
    risks,
    requiresUserConfirmation: true,
  };
}

// Devil May Cry (2025) — 2026-07-05 correction: the user clarified they
// watched only Season 1, not "everything." The generic
// planMarkAllKnownWatched heuristic (watchedEpisodeCount === knownEpisodeCount
// implies caught up) is unsafe here specifically because this series has
// only ONE known season and is unenriched — there is no way to rule out a
// Season 2+ that TV Time's import simply never captured. Withdrawn from the
// SAFE_TO_APPLY / mark_caught_up group; do not generalize this single-season
// coincidence into a global CAUGHT_UP the way the other 13 mark-all-watched
// items do (those all span multiple seasons whose totals line up with
// well-established real-world counts — see run-plan.ts's investigation
// notes on each, and the correction summary this revision produced).
function planDevilMayCry2025(s: SeriesSnapshot): CorrectionPlanItem {
  const season1Episodes = s.episodes.filter((e) => e.seasonNumber === 1);
  const unwatchedSeason1 = computeUnwatchedKnownEpisodes(season1Episodes, s.watchedEpisodeIds);
  const knownSeasons = [...new Set(s.episodes.map((e) => e.seasonNumber))];

  return {
    itemKey: '2-devil-may-cry-2025',
    itemLabel: 'Devil May Cry (2025)',
    userRequestSummary:
      'User clarified (2026-07-05) they watched only Season 1 — watchedEpisodeCount === knownEpisodeCount is not sufficient evidence to mark the whole series caught up.',
    matchedSeriesTitle: s.title,
    matchedSeriesId: s.seriesId,
    confidence: 'HIGH',
    readinessCategory: 'DATA_INCOMPLETE',
    current: baseCurrent(s),
    proposedAction: 'mark_season_1_watched_if_needed__do_not_set_global_caught_up',
    episodesToMarkWatched: unwatchedSeason1.map((e) => toLabel(e)!),
    // No status change proposed — the whole point of this correction is
    // that we do not know enough to confidently derive CAUGHT_UP here.
    progressChange: null,
    investigationNotes: [
      `Current DB state: only ${knownSeasons.length} known season (Season ${knownSeasons.join(', ')}) with ${s.episodes.length} total known episodes, all already watched (${s.watchedEpisodeIds.size}/${s.episodes.length}). Season 1 alone: ${season1Episodes.length} known, ${unwatchedSeason1.length} unwatched.`,
      'Previously this item was in the generic "mark all known episodes watched" group and proposed CAUGHT_UP solely because watchedEpisodeCount === knownEpisodeCount. That heuristic assumed the known catalog was the complete series, which the user has now corrected.',
      'Series is not enriched (no ExternalIds.tmdbId) — nothing in the DB can confirm or rule out additional seasons/episodes beyond what TV Time imported.',
    ],
    risks: [
      'needs_catalog_enrichment_or_manual_mapping: cannot confirm whether Season 2 (or additional Season 1 episodes TV Time never imported) exist until this series is enriched or a manual episode mapping is supplied.',
      'do_not_mark_caught_up_globally: do not set userStatus to CAUGHT_UP for this series from this plan — that would incorrectly assert there is nothing left to watch beyond Season 1, which is exactly the claim the user asked not to make.',
      'Safe action today is limited to Season 1 itself: mark any currently-known, currently-unwatched Season 1 episode as watched (none exist right now — Season 1 is already fully watched) and leave userStatus/nextEpisodeId untouched until the catalog is confirmed complete.',
    ],
    requiresUserConfirmation: true,
    templateNoteHint: 'Recommended: needs_mapping or report_only. Do not choose apply — catalog completeness beyond Season 1 is unconfirmed (see risks in the plan).',
  };
}

function planReportOnly(
  s: SeriesSnapshot | null,
  itemKey: string,
  itemLabel: string,
  userRequestSummary: string,
  confidence: Confidence,
  readinessCategory: ReadinessCategory,
  proposedAction: string,
  investigationNotes: string[],
  risks: string[],
): CorrectionPlanItem {
  return {
    itemKey,
    itemLabel,
    userRequestSummary,
    matchedSeriesTitle: s?.title ?? null,
    matchedSeriesId: s?.seriesId ?? null,
    confidence,
    readinessCategory,
    current: s
      ? baseCurrent(s)
      : { userStatus: null, releaseStatus: null, externalIds: null, watchedEpisodeCount: 0, knownEpisodeCount: 0, nextEpisodeId: null, nextEpisodeLabel: null, lastWatchedAt: null },
    proposedAction,
    episodesToMarkWatched: [],
    progressChange: null,
    investigationNotes,
    risks,
    requiresUserConfirmation: true,
  };
}

async function main() {
  console.log('Manual progress correction PLAN — read-only, report only, writes report files only, never app tables.');

  const prisma = new PrismaClient();
  const generatedAt = new Date();

  // Known series ids, resolved by exact-title lookup and manual inspection
  // ahead of writing this script (see investigationNotes per item below).
  const ids = {
    mom: '7e10f0a4-00dc-40c5-bb75-211bc792823d',
    dmc2025: 'a82e24b0-0719-430b-b86a-b890d18338be',
    onePiece: '027e294d-3209-47a3-93d5-1b70e41ea620',
    onePiece2023: '0c7eda06-f9b2-43c2-add9-322d01db34d8',
    inuYasha: 'fc354e20-9261-474a-8d5c-e7ac700ba7a1',
    inuYashaFinalAct: 'bc5ca3f7-fda1-4504-b868-df25a44021bf',
    rurouniKenshin: 'a8cb3f9b-1cf1-47a2-be0c-ae9c63a11118',
    jjk: '84252f12-3915-4ea4-bd9c-ba132816df36',
    naruto: '04c60106-6103-44c4-ba67-61027a40d18f',
    narutoShippuden: 'e0a86356-403c-443c-bfe9-9f555c9302a9',
    dbz: 'a4b338a3-586b-46b1-af90-dad1d9e7d403',
    dbKai: 'db787e61-dbbf-4f5b-9912-a008af85e971',
    dbSuper: '19960962-fd56-4cde-92ec-34b736d14758',
    mha: '9d2a62bb-8eee-481e-9ea2-3ecd220ac894',
    boruto: '4e438931-623e-4181-b7e1-eda10919373b',
    ranma2024: '669c109a-a2b1-42cd-a473-3fca9dc93a63',
    ranmaOriginal: 'fe3dd74f-e912-4be1-8fc2-2b9437d36051',
    hxh2011: 'a82cc0cc-bc31-4cd5-b03b-61a47124ece8',
    hxhOriginal: '6c2d62a9-9706-4fed-836c-dc8f96d2498f',
    doctorWho2023: '75586101-19ae-418c-b36d-e498cb67e5da',
    doctorWho2005: '76fca414-0311-40a1-837b-31e335b0cb56',
    avatarAnimated: '044a31e8-6ea0-45ae-882a-f4c08fe0f869',
    avatarLiveAction: '8e7ed65e-70c0-4e3d-8af6-f7ab450fea0e',
  };

  const snap: Record<string, SeriesSnapshot | null> = {};
  for (const [key, id] of Object.entries(ids)) {
    snap[key] = await loadSnapshot(prisma, id);
  }

  const items: CorrectionPlanItem[] = [];

  // 1. Mom — desired next S5E14; DB only knows S5E1-E2.
  {
    const s = snap.mom!;
    const desired = findEpisodeBySeasonEpisode(s.episodes, 5, 14);
    const s5Episodes = s.episodes.filter((e) => e.seasonNumber === 5);
    items.push(
      planReportOnly(
        s,
        '1-mom',
        'Mom',
        'User reached S5E13; desired next is S5E14 if it exists.',
        'HIGH',
        'DATA_INCOMPLETE',
        'report_missing_episode_no_change',
        [
          `Season 5 currently has only ${s5Episodes.length} known episode(s) in the DB: ${s5Episodes.map((e) => `E${e.episodeNumber}`).join(', ') || 'none'}.`,
          `Desired next episode S5E14 ${desired ? 'was found' : 'does NOT exist in the current catalog'}.`,
          'Series is not enriched (no ExternalIds.tmdbId) — no airDate data at all.',
        ],
        [
          "The user's stated position (S5E13) is also not represented in the DB (only E1-E2 known) — the catalog is missing S5E3 onward, not just E14.",
          'Cannot set nextEpisodeId to an episode that does not exist. Recommend completing/enriching the Season 5 catalog before any progress change.',
        ],
      ),
    );
  }

  // 2. Devil May Cry (2025) — user clarified they only watched Season 1;
  // do not generalize the known-catalog-fully-watched coincidence into a
  // global CAUGHT_UP (see planDevilMayCry2025's own comment for why this
  // needed a dedicated handler instead of the generic mark-all-watched one).
  items.push(planDevilMayCry2025(snap.dmc2025!));

  // 3. One Piece — desired next: absolute #1158, fallback S23E3.
  {
    const s = snap.onePiece!;
    const byAbsolute = findEpisodeByAbsolutePosition(s.episodes, 1158);
    const byS23E3 = findEpisodeBySeasonEpisode(s.episodes, 23, 3);
    const s23Episodes = s.episodes.filter((e) => e.seasonNumber === 23);
    items.push(
      planReportOnly(
        s,
        '3-one-piece',
        'One Piece',
        'User watched up to episode 1158 exclusive (next = abs #1158, may be S23E3).',
        'HIGH',
        'DATA_INCOMPLETE',
        'report_missing_episode_no_change',
        [
          `Known catalog has exactly ${s.episodes.length} episodes; watchedEpisodeCount is ${s.watchedEpisodeIds.size} — these match, confirming the catalog's absolute ordering lines up with the user's stated position (watched through 1157, i.e. all of S0-S22 plus S23E1-E2).`,
          `Absolute position 1158 in the ordered catalog: ${byAbsolute ? labelText(toLabel(byAbsolute)) : 'does not exist yet'}.`,
          `S23E3 lookup: ${byS23E3 ? 'found' : 'does NOT exist'} — Season 23 currently only has ${s23Episodes.length} known episode(s) (E${s23Episodes.map((e) => e.episodeNumber).join(', E')}).`,
        ],
        [
          'One Piece is on the episode-numbering/season-shift risk list (docs/episode-numbering-and-season-shift-risk.md) — even once S23E3 is added to the catalog, verify it aligns with this DB\'s own numbering before trusting it, rather than importing TMDb/TVmaze absolute numbering directly.',
          'One Piece is also a duplicate-title-group member (a second row, "ONE PIECE (2023)", exists for the unrelated live-action series — already handled separately as item 4).',
        ],
      ),
    );
  }

  // 4. ONE PIECE (2023) live action — mark all watched.
  items.push(
    planMarkAllKnownWatched(snap.onePiece2023!, '4-one-piece-2023', 'ONE PIECE (2023)', 'User watched all episodes of the live-action series; mark all known/released episodes watched, then set CAUGHT_UP/COMPLETED.', [], [
      'Distinct DB row from the "One Piece" anime (item 3) — titles are similar but this is the live-action adaptation; do not confuse the two.',
    ]),
  );

  // 5. InuYasha — desired next: S2E28 (episode 55); DB only has S2 up to E26.
  {
    const s = snap.inuYasha!;
    const desired = findEpisodeBySeasonEpisode(s.episodes, 2, 28);
    const s2Episodes = s.episodes.filter((e) => e.seasonNumber === 2);
    items.push(
      planReportOnly(
        s,
        '5-inuyasha',
        'InuYasha',
        'User watched through episode 54 / S2E27; desired next is episode 55 / S2E28.',
        'HIGH',
        'DATA_INCOMPLETE',
        'report_missing_episode_no_change',
        [
          `Season 2 currently only has ${s2Episodes.length} known episodes (E1-E${Math.max(...s2Episodes.map((e) => e.episodeNumber))}) — neither S2E27 (the user's stated current position) nor S2E28 (desired next) exist in the DB.`,
          `Total known episodes: ${s.episodes.length} (all watched) — TV Time's catalog for this entry appears to stop short of the user's real-world progress.`,
        ],
        [
          'InuYasha is on the explicit "do not trust" risk list (docs/episode-numbering-and-season-shift-risk.md §5) specifically because of an unresolved numbering conflict with "InuYasha: The Final Act" (item 6) — do not enrich or remap this series as part of resolving this data gap without also resolving that.',
          'Cannot set nextEpisodeId to an episode that does not exist. Recommend catalog investigation/completion before any progress change.',
        ],
      ),
    );
  }

  // 6. InuYasha: The Final Act — empty placeholder, not started.
  {
    const s = snap.inuYashaFinalAct!;
    items.push(
      planReportOnly(
        s,
        '6-inuyasha-final-act',
        'InuYasha: The Final Act',
        'If a continuation of InuYasha, unified counting is OK; if separate, user has not started it.',
        'HIGH',
        'DO_NOT_TOUCH',
        'no_action_not_started',
        [
          `Current DB state: ${s.episodes.length} known episodes, no UserSeriesProgress row at all — matches the user's own statement that they have not started this entry.`,
          'This is a distinct Series row from "InuYasha" (item 5), not a season or continuation of it in the current schema — there is no structural link between the two today.',
        ],
        [
          'Both this InuYasha entry and the original are on the risk-list §5 explicitly because they have not been distinguished from each other by TMDb — do not merge automatically.',
          'Safe manual mapping strategy (not proposed here, needs a deliberate future decision): keep as two separate Series rows, and only merge/unify absolute counting if the user explicitly confirms that is what they want and a real, correct TMDb match distinguishes the two — do not decide this from title similarity alone.',
        ],
      ),
    );
  }

  // 7. Rurouni Kenshin — report only, do not touch.
  {
    const s = snap.rurouniKenshin!;
    items.push(
      planReportOnly(
        s,
        '7-rurouni-kenshin',
        'Rurouni Kenshin',
        'User says this was already updated — report current state only, do not modify.',
        'HIGH',
        'DO_NOT_TOUCH',
        'no_action_already_updated',
        [
          `Current state: userStatus=${s.userStatus}, nextEpisodeId=${s.nextEpisodeId ?? 'null'}, lastWatchedAt=${s.lastWatchedAt?.toISOString() ?? 'null'}.`,
          `Watched ${s.watchedEpisodeIds.size} of ${s.episodes.length} known episodes.`,
          'Confirmed via live GET /me/watch-next and GET /me/stale-series (2026-07-05): does not appear in either — consistent with userStatus=CAUGHT_UP and nextEpisodeId=null.',
        ],
        [],
      ),
    );
  }

  // 8. JUJUTSU KAISEN — desired next: exact title match, fallback S3E8.
  {
    const s = snap.jjk!;
    const byTitle = findEpisodeByExactTitle(s.episodes, 'Tokyo Colony No. 1 - Part 2');
    const byS3E8 = findEpisodeBySeasonEpisode(s.episodes, 3, 8);
    const s3Episodes = s.episodes.filter((e) => e.seasonNumber === 3);
    const s3e7 = findEpisodeBySeasonEpisode(s.episodes, 3, 7);
    const alreadyWatchedThroughS3E7 = s3e7 ? s.watchedEpisodeIds.has(s3e7.id) : false;
    items.push(
      planReportOnly(
        s,
        '8-jujutsu-kaisen',
        'JUJUTSU KAISEN',
        'User watched through S3E7 inclusive; desired next is "Tokyo Colony No. 1 - Part 2" or S3E8.',
        'HIGH',
        'DATA_INCOMPLETE',
        'report_missing_next_episode_no_change',
        [
          `Season 3 currently has exactly ${s3Episodes.length} known episodes (E1-E${Math.max(...s3Episodes.map((e) => e.episodeNumber))}) — matches the user's stated position (through S3E7) exactly, and all are already watched (S3E7 watched: ${alreadyWatchedThroughS3E7}).`,
          `Exact title match for "Tokyo Colony No. 1 - Part 2": ${byTitle ? 'found' : 'NOT found'} — this series has no episode titles at all (unenriched; TV Time carries no episode titles), so a title-based match is not possible today.`,
          `S3E8 fallback: ${byS3E8 ? 'found' : 'does NOT exist'} in the current catalog.`,
        ],
        [
          'JUJUTSU KAISEN is on the explicit "do not trust" risk list (docs/episode-numbering-and-season-shift-risk.md §5) — a prior dry-run found TMDb represents this show as one absolute-numbered season of 59 episodes vs. this DB\'s 3 seasons of 24+23+7=54. Per the instruction "do not use TMDb absolute numbering if it conflicts with current DB numbering," no enrichment or remap is proposed here.',
          'No new episodes can be marked watched or pointed to as nextEpisodeId until Season 3 Episode 8 (or a correctly-mapped equivalent) actually exists in this DB — that requires either enrichment (blocked by the risk-list rule above until the season-shift issue is resolved) or a separate manual single-episode entry.',
        ],
      ),
    );
  }

  // 9-15: mark-all-known-watched items.
  items.push(planMarkAllKnownWatched(snap.naruto!, '9-naruto', 'Naruto', 'User watched all of Naruto; mark all known/released episodes watched, set CAUGHT_UP/COMPLETED.'));
  items.push(
    planMarkAllKnownWatched(snap.narutoShippuden!, '10-naruto-shippuden', 'Naruto Shippuden', 'User watched all of Naruto Shippuden; mark all known/released episodes watched, set CAUGHT_UP/COMPLETED.'),
  );
  items.push(planMarkAllKnownWatched(snap.dbz!, '11-dragon-ball-z', 'Dragon Ball Z', 'User watched all of it; mark all known/released episodes watched, set CAUGHT_UP/COMPLETED.'));
  items.push(planMarkAllKnownWatched(snap.dbKai!, '12-dragon-ball-kai', 'Dragon Ball Kai', 'User watched all of it; mark all known/released episodes watched, set CAUGHT_UP/COMPLETED.'));
  items.push(planMarkAllKnownWatched(snap.dbSuper!, '13-dragon-ball-super', 'Dragon Ball Super', 'User watched all of it; mark all known/released episodes watched, set CAUGHT_UP/COMPLETED.'));
  items.push(
    planMarkAllKnownWatched(
      snap.mha!,
      '14-my-hero-academia',
      'My Hero Academia',
      'User says the series is definitely finished and they watched everything; set COMPLETED if ENDED/CANCELLED else CAUGHT_UP, report mismatch otherwise.',
      [],
      [
        'MISMATCH per this item\'s own rule: the user states the series is "definitely finished," but releaseStatus in the DB is UNKNOWN (not ENDED/CANCELLED) — proposed status is CAUGHT_UP, not COMPLETED, until enrichment confirms the real-world end date. This is exactly the mismatch the task asked to have reported rather than silently resolved.',
      ],
    ),
  );
  items.push(
    planMarkAllKnownWatched(snap.boruto!, '15-boruto', 'Boruto: Naruto Next Generations', 'User watched everything released; mark all known/released episodes watched, set CAUGHT_UP/COMPLETED.'),
  );

  // 16a/16b: Ranma ½ (2024) apply, original do-not-touch.
  items.push(
    planMarkAllKnownWatched(
      snap.ranma2024!,
      '16a-ranma-2024',
      'Ranma ½ (2024)',
      'User watched all released episodes of the 2024 remake/revival; mark all known/released episodes watched, set CAUGHT_UP/COMPLETED.',
      ['Distinct DB row ("Ranma ½ (2024)") from the original "Ranma ½" (item 16b) — titles are clearly disambiguated in this DB already, no merge risk.'],
    ),
  );
  {
    const s = snap.ranmaOriginal!;
    items.push(
      planReportOnly(
        s,
        '16b-ranma-original',
        'Ranma ½ (original)',
        'Do not apply the 2024-remake decision to the original Ranma ½ unless clearly identified as the remake.',
        'HIGH',
        'DO_NOT_TOUCH',
        'no_action_per_user_instruction',
        [`Current state: userStatus=${s.userStatus}, watched ${s.watchedEpisodeIds.size} of ${s.episodes.length} known episodes — left untouched per explicit instruction.`],
        [],
      ),
    );
  }

  // 17. Hunter x Hunter (2011) — apply; original/1999 row is empty.
  {
    const original = snap.hxhOriginal!;
    items.push(
      planMarkAllKnownWatched(
        snap.hxh2011!,
        '17-hunter-x-hunter-2011',
        'Hunter x Hunter (2011)',
        'User watched everything released; be careful with old vs. 2011 duplicate title group.',
        [
          `The other DB row with a similar title ("Hunter x Hunter", no year suffix) has ${original.episodes.length} known episodes and ${original.userStatus ? `userStatus=${original.userStatus}` : 'no UserSeriesProgress row at all'} — effectively unused, so there is no real ambiguity between the two despite the duplicate-title-group risk noted in docs/episode-numbering-and-season-shift-risk.md.`,
        ],
      ),
    );
  }

  // 18a/18b: Doctor Who (2005) and (2023) — both apply; no classic entry found.
  items.push(
    planMarkAllKnownWatched(
      snap.doctorWho2005!,
      '18a-doctor-who-2005',
      'Doctor Who (2005)',
      'User watched everything released in the 2005 revival; mark all known/released episodes watched, set CAUGHT_UP/COMPLETED.',
      ['No classic (1963-1989) Doctor Who entry exists in this DB at all — only "Doctor Who (2005)" and "Doctor Who (2023)" were found, so there is nothing to accidentally touch.'],
    ),
  );
  items.push(
    planMarkAllKnownWatched(
      snap.doctorWho2023!,
      '18b-doctor-who-2023',
      'Doctor Who (2023)',
      'User watched everything released in the newer 2023/2025 revival; mark all known/released episodes watched, set CAUGHT_UP/COMPLETED.',
    ),
  );

  // 19a/19b: Avatar animated apply; live-action do-not-touch.
  items.push(
    planMarkAllKnownWatched(
      snap.avatarAnimated!,
      '19a-avatar-animated',
      'Avatar: The Last Airbender (animated)',
      'User watched all of the animated series; mark all known/released episodes watched, set CAUGHT_UP/COMPLETED.',
    ),
  );
  {
    const s = snap.avatarLiveAction!;
    items.push(
      planReportOnly(
        s,
        '19b-avatar-live-action',
        'Avatar: The Last Airbender (2021, live action)',
        'User has not watched the live-action Avatar — do not mark as watched.',
        'HIGH',
        'DO_NOT_TOUCH',
        'no_action_not_started',
        [`Current state: ${s.episodes.length} known episodes, no UserSeriesProgress row at all — matches the user's own statement that they have not watched this entry.`],
        [],
      ),
    );
  }

  await prisma.$disconnect();

  const counts: Record<ReadinessCategory, number> = { SAFE_TO_APPLY: 0, NEEDS_MAPPING: 0, AMBIGUOUS: 0, DO_NOT_TOUCH: 0, DATA_INCOMPLETE: 0 };
  for (const it of items) counts[it.readinessCategory]++;

  console.log(`\nGenerated at: ${generatedAt.toISOString()}`);
  console.log(JSON.stringify({ itemCount: items.length, byReadiness: counts }, null, 2));

  mkdirSync(OUT_DIR, { recursive: true });

  const jsonReport = {
    generatedAt: generatedAt.toISOString(),
    writesToAppTables: false,
    note: 'This is a proposed correction PLAN only. Nothing in this report has been applied. Every item requires explicit user confirmation via the decisions template before any write.',
    summary: { itemCount: items.length, byReadiness: counts },
    items,
  };
  const jsonPath = path.join(OUT_DIR, 'manual-progress-correction-plan.json');
  writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2));
  console.log(`\nWrote ${jsonPath}`);

  const mdPath = path.join(OUT_DIR, 'manual-progress-correction-plan.md');
  writeFileSync(mdPath, buildMarkdown(generatedAt, items, counts));
  console.log(`Wrote ${mdPath}`);

  const decisionsTemplate = items.map((it) => ({
    seriesTitle: it.matchedSeriesTitle,
    seriesId: it.matchedSeriesId,
    confidence: it.confidence,
    proposedAction: it.proposedAction,
    decision: null,
    allowedDecisions: ['apply', 'skip', 'needs_mapping', 'report_only'],
    notes: it.templateNoteHint ?? '',
  }));
  const decisionsPath = path.join(OUT_DIR, 'manual-progress-correction-decisions.template.json');
  writeFileSync(decisionsPath, JSON.stringify(decisionsTemplate, null, 2));
  console.log(`Wrote ${decisionsPath}`);
}

const READINESS_ORDER: ReadinessCategory[] = ['SAFE_TO_APPLY', 'DATA_INCOMPLETE', 'NEEDS_MAPPING', 'AMBIGUOUS', 'DO_NOT_TOUCH'];

function buildMarkdown(generatedAt: Date, items: CorrectionPlanItem[], counts: Record<ReadinessCategory, number>): string {
  const lines: string[] = [];
  lines.push('# Manual Progress Correction Plan');
  lines.push('');
  lines.push(`Generated: ${generatedAt.toISOString()}`);
  lines.push('');
  lines.push('**Report only — nothing in this document has been applied.** Every item requires an explicit decision in the companion decisions template before any write happens.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total items: ${items.length}`);
  for (const category of READINESS_ORDER) lines.push(`- **${category}**: ${counts[category]}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const category of READINESS_ORDER) {
    const group = items.filter((it) => it.readinessCategory === category);
    if (group.length === 0) continue;

    lines.push(`## ${category} (${group.length})`);
    lines.push('');

    for (const it of group) {
      lines.push(`### ${it.itemLabel}`);
      lines.push('');
      lines.push(`**User request**: ${it.userRequestSummary}`);
      lines.push('');
      lines.push(`- matched series: ${it.matchedSeriesTitle ? `${it.matchedSeriesTitle} (\`${it.matchedSeriesId}\`)` : '_not found_'}`);
      lines.push(`- confidence: **${it.confidence}**`);
      lines.push(
        `- current: userStatus=${it.current.userStatus ?? '_none_'} · releaseStatus=${it.current.releaseStatus ?? '_none_'} · tmdbId=${it.current.externalIds?.tmdbId ?? 'null'} · watched ${it.current.watchedEpisodeCount}/${it.current.knownEpisodeCount} known episodes`,
      );
      lines.push(`- current nextEpisodeId: ${it.current.nextEpisodeId ?? '_null_'}${it.current.nextEpisodeLabel ? ` (${it.current.nextEpisodeLabel})` : ''}`);
      lines.push(`- lastWatchedAt: ${it.current.lastWatchedAt ?? '_none_'}`);
      lines.push('');
      lines.push(`**Proposed action**: \`${it.proposedAction}\``);
      lines.push('');
      lines.push(
        it.episodesToMarkWatched.length > 0
          ? `**Episodes to newly mark watched** (${it.episodesToMarkWatched.length}): ${it.episodesToMarkWatched.map((e) => labelText(e)).join(', ')}`
          : '**Episodes to newly mark watched**: none',
      );
      lines.push('');
      if (it.progressChange) {
        lines.push(`**Progress change**: userStatus \`${it.progressChange.userStatus.from ?? 'none'}\` → \`${it.progressChange.userStatus.to ?? 'none'}\`; nextEpisodeId \`${it.progressChange.nextEpisodeId.from ?? 'null'}\` → \`${it.progressChange.nextEpisodeId.to ?? 'null'}\``);
      } else {
        lines.push('**Progress change**: none proposed');
      }
      lines.push('');
      if (it.investigationNotes.length > 0) {
        lines.push('**Investigation notes**:');
        for (const n of it.investigationNotes) lines.push(`- ${n}`);
        lines.push('');
      }
      if (it.risks.length > 0) {
        lines.push('**Risks/ambiguities**:');
        for (const r of it.risks) lines.push(`- ${r}`);
        lines.push('');
      }
      lines.push(`Requires user confirmation before applying: **${it.requiresUserConfirmation ? 'YES' : 'no'}**`);
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
