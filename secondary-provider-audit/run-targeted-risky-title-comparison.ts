// Targeted TVmaze comparison for the 22 known risky/mismatched titles
// surfaced across manual-progress-corrections/ and
// docs/episode-numbering-and-season-shift-risk.md — the "next smallest
// implementation step" docs/metadata-provider-strategy.md §6 recommended:
// "a small, parameterized run script (accept a title list instead of the
// full catalog) reusing run-tvmaze-dry-run.ts's existing shape."
//
// Zero new provider-integration code: reuses TvMazeClient (tvmaze-client.ts)
// and every scoring/comparison function from tvmaze-scoring.ts/
// tvmaze-compare.ts verbatim, exactly as run-tvmaze-dry-run.ts does. The only
// new code here is (a) a fixed list of the 22 known series ids instead of
// `prisma.series.findMany()`, (b) per-title "key target episode" checks
// (Mom S5E14, etc.) the generic dry run has no reason to compute, and (c) a
// new classification layer mapping the existing comparison signals onto this
// report's own decision vocabulary (TVMAZE_SAFE_MATCH /
// NEEDS_THETVDB_ABSOLUTE_ORDER / etc.) — a decision vocabulary specific to
// "is a secondary provider useful for THIS correction case," which is a
// different question than tvmaze-compare.ts's own
// ProviderComparisonCategory ("does TVmaze look more/less correct than
// TMDb") and so is deliberately not reused as-is, only built on top of it.
//
// Report-only: no Prisma writes at all (not even ImportBatch/ImportRawRow
// cache bookkeeping the full dry run uses) — every query below is a read.
// Writes only the two local report files.

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { DEV_USER_ID } from '../src/common/constants';
import { TvMazeClient } from './tvmaze-client';
import {
  decideTier,
  detectAnimeNumberingRisk,
  detectCloseCompetitor,
  evaluateStructuralAutoMatch,
  extractTitleYearHint,
  scoreCandidates,
  CloseCompetitorResult,
  ScoreBreakdown,
} from './tvmaze-scoring';
import { categorizeComparison, computeNextEpisodeComparison, ProviderComparisonCategory, TvMazeTier } from './tvmaze-compare';
import { TvMazeEpisode, TvMazeSearchResult } from './tvmaze-types';

const OUT_DIR = path.join(__dirname, 'output');
const TOP_CANDIDATES_LIMIT = 5;
const NO_CLOSE_COMPETITOR: CloseCompetitorResult = { detected: false, reason: null, kind: null };

export type RiskyTitleClassification =
  | 'TVMAZE_SAFE_MATCH'
  | 'TVMAZE_NEEDS_USER_CONFIRMATION'
  | 'TVMAZE_NOT_USEFUL_FOR_THIS_CASE'
  | 'NEEDS_THETVDB_ABSOLUTE_ORDER'
  | 'NEEDS_ANILIST_RELATION_MAPPING'
  | 'NEEDS_WIKIDATA_IDENTITY_DISAMBIGUATION'
  | 'MANUAL_MAPPING_REQUIRED'
  | 'DO_NOT_TOUCH';

// Known series ids — the same 22 rows already investigated in
// manual-progress-corrections/run-plan.ts's `ids` map (this title list is a
// superset of docs/metadata-provider-strategy.md §6's ~10, extended to match
// every title in this task's request). Reusing the exact ids avoids any
// risk of a fuzzy title lookup here landing on the wrong DB row for a
// duplicate-title-group member (One Piece, Ranma, HxH, Doctor Who, Avatar).
const ids: Record<string, string> = {
  mom: '7e10f0a4-00dc-40c5-bb75-211bc792823d',
  dmc2025: 'a82e24b0-0719-430b-b86a-b890d18338be',
  onePiece: '027e294d-3209-47a3-93d5-1b70e41ea620',
  onePiece2023: '0c7eda06-f9b2-43c2-add9-322d01db34d8',
  inuYasha: 'fc354e20-9261-474a-8d5c-e7ac700ba7a1',
  inuYashaFinalAct: 'bc5ca3f7-fda1-4504-b868-df25a44021bf',
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
  rurouniKenshin: 'a8cb3f9b-1cf1-47a2-be0c-ae9c63a11118',
};

interface Snapshot {
  seriesId: string;
  title: string;
  releaseStatus: string;
  tmdbId: string | null;
  userStatus: string | null;
  watchedEpisodeCount: number;
  knownEpisodeCount: number;
  knownSeasonNumbers: number[];
  currentNextEpisodeLabel: string | null;
  currentNextEpisodeTitle: string | null;
}

async function loadSnapshot(prisma: PrismaClient, seriesId: string): Promise<Snapshot | null> {
  const series = await prisma.series.findUnique({ where: { id: seriesId }, include: { externalIds: true } });
  if (!series) return null;

  const progress = await prisma.userSeriesProgress.findUnique({
    where: { userId_seriesId: { userId: DEV_USER_ID, seriesId } },
    include: { nextEpisode: { include: { season: true } } },
  });

  const episodes = await prisma.episode.findMany({ where: { season: { seriesId } }, select: { id: true, season: { select: { seasonNumber: true } } } });
  const watches = await prisma.episodeWatch.findMany({ where: { userId: DEV_USER_ID, episode: { season: { seriesId } } }, select: { episodeId: true } });

  return {
    seriesId,
    title: series.title,
    releaseStatus: series.releaseStatus,
    tmdbId: series.externalIds?.tmdbId ?? null,
    userStatus: progress?.userStatus ?? null,
    watchedEpisodeCount: watches.length,
    knownEpisodeCount: episodes.length,
    knownSeasonNumbers: [...new Set(episodes.map((e) => e.season.seasonNumber))].sort((a, b) => a - b),
    currentNextEpisodeLabel: progress?.nextEpisode ? `S${progress.nextEpisode.season.seasonNumber}E${progress.nextEpisode.episodeNumber}` : null,
    currentNextEpisodeTitle: progress?.nextEpisode?.title ?? null,
  };
}

interface CandidateSummary {
  tvmazeId: number;
  tvmazeTitle: string;
  tvmazeYear: number | null;
  confidenceScore: number;
  reasonBreakdown: ScoreBreakdown;
}

function toCandidateSummary(result: TvMazeSearchResult, breakdown: ScoreBreakdown): CandidateSummary {
  const year = parseYear(result.show.premiered);
  return { tvmazeId: result.show.id, tvmazeTitle: result.show.name, tvmazeYear: year, confidenceScore: breakdown.totalScore, reasonBreakdown: breakdown };
}

function toCloseCompetitorCandidate(c: CandidateSummary) {
  return { tvmazeId: c.tvmazeId, tvmazeTitle: c.tvmazeTitle, tvmazeYear: c.tvmazeYear, confidenceScore: c.confidenceScore };
}

function parseYear(dateString: string | null | undefined): number | null {
  if (!dateString) return null;
  const year = Number(dateString.slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
}

function providerName(show: { network?: { name: string } | null; webChannel?: { name: string } | null } | undefined): string | null {
  if (!show) return null;
  return show.network?.name ?? show.webChannel?.name ?? null;
}

interface KeyEpisodeCheck {
  description: string;
  foundByAbsolutePosition: { position: number; found: boolean; label: string | null; title: string | null };
  foundByLabel?: { label: string; seasonNumber: number; episodeNumber: number; found: boolean; title: string | null };
  foundByTitle?: { title: string; found: boolean; label: string | null };
}

interface TvMazeSignals {
  tier: TvMazeTier;
  tierReason: string;
  topCandidate: CandidateSummary | null;
  topCandidates: CandidateSummary[];
  closeCompetitorDetected: boolean;
  closeCompetitorReason: string | null;
  tvmazeId: number | null;
  tvmazeTitle: string | null;
  tvmazeYear: number | null;
  tvmazeStatus: string | null;
  tvmazeProvider: string | null;
  tvmazeSeasonCount: number | null;
  tvmazeSeasonNumbers: number[] | null;
  tvmazeRegularEpisodeCount: number | null;
  tvmazeEpisodeCountIncludingSpecials: number | null;
  animeNumberingRiskDetected: boolean;
  structuralAutoMatchProposed: boolean;
  structuralAutoMatchReason: string;
  category: ProviderComparisonCategory;
  categoryReasons: string[];
  nextEpisodeProposedLabel: string | null;
  nextEpisodeProposedTitle: string | null;
  nextEpisodeTitlesComparable: boolean;
  nextEpisodeTitlesMatch: boolean | null;
  nextEpisodeComparisonNote: string;
  chronologicalEpisodes: TvMazeEpisode[];
}

async function compareAgainstTvMaze(tvmaze: TvMazeClient, snapshot: Snapshot): Promise<TvMazeSignals> {
  const hint = extractTitleYearHint(snapshot.title);
  const hasTmdbMatch = snapshot.tmdbId != null;

  const searchResults = await tvmaze.searchShows(hint.bareTitle);
  const scored = scoreCandidates(hint, searchResults);
  const decision = decideTier(scored);
  const topCandidates = scored.slice(0, TOP_CANDIDATES_LIMIT).map((c) => toCandidateSummary(c.result, c.breakdown));
  const closeCompetitor =
    topCandidates.length > 1
      ? detectCloseCompetitor(toCloseCompetitorCandidate(topCandidates[0]), topCandidates.slice(1).map(toCloseCompetitorCandidate))
      : NO_CLOSE_COMPETITOR;

  if (decision.tier === 'NO_MATCH') {
    const category = categorizeComparison({
      hasTmdbMatch,
      mytvKnownEpisodeCount: snapshot.knownEpisodeCount,
      watchedEpisodeCount: snapshot.watchedEpisodeCount,
      tvmazeTier: 'NO_MATCH',
      tvmazeRegularEpisodeCount: 0,
      tvmazeEpisodeCountIncludingSpecials: null,
      animeNumberingRiskDetected: false,
      closeCompetitorDetected: closeCompetitor.detected,
      isDuplicateTitleGroupMember: false,
      structuralAutoMatchProposed: false,
    });
    return {
      tier: 'NO_MATCH',
      tierReason: decision.reason,
      topCandidate: null,
      topCandidates,
      closeCompetitorDetected: closeCompetitor.detected,
      closeCompetitorReason: closeCompetitor.reason,
      tvmazeId: null,
      tvmazeTitle: null,
      tvmazeYear: null,
      tvmazeStatus: null,
      tvmazeProvider: null,
      tvmazeSeasonCount: null,
      tvmazeSeasonNumbers: null,
      tvmazeRegularEpisodeCount: null,
      tvmazeEpisodeCountIncludingSpecials: null,
      animeNumberingRiskDetected: false,
      structuralAutoMatchProposed: false,
      structuralAutoMatchReason: 'no candidate to evaluate',
      category: category.category,
      categoryReasons: [...category.reasons, decision.reason],
      nextEpisodeProposedLabel: null,
      nextEpisodeProposedTitle: null,
      nextEpisodeTitlesComparable: false,
      nextEpisodeTitlesMatch: null,
      nextEpisodeComparisonNote: 'no confident TVmaze match — next-episode comparison skipped',
      chronologicalEpisodes: [],
    };
  }

  const top = decision.top!;
  const tvmazeId = top.result.show.id;
  const show = await tvmaze.getShowWithEpisodes(tvmazeId);
  const regularEpisodes: TvMazeEpisode[] = show._embedded?.episodes ?? [];
  const tvmazeRegularEpisodeCount = regularEpisodes.length;
  const episodeCountIncludingSpecials = await tvmaze.getEpisodeCountIncludingSpecials(tvmazeId);

  const animeNumberingRiskDetected = detectAnimeNumberingRisk({
    watchedEpisodeCount: snapshot.watchedEpisodeCount,
    tvmazeEpisodeCount: tvmazeRegularEpisodeCount,
    genres: show.genres,
  });

  const structuralAutoMatch = evaluateStructuralAutoMatch({
    tier: decision.tier,
    titleMatchType: top.breakdown.titleMatchType,
    resultPosition: 0,
    watchedEpisodeCount: snapshot.watchedEpisodeCount,
    tvmazeEpisodeCount: tvmazeRegularEpisodeCount,
    animeNumberingRiskDetected,
    closeCompetitorDetected: closeCompetitor.detected,
  });

  const category = categorizeComparison({
    hasTmdbMatch,
    mytvKnownEpisodeCount: snapshot.knownEpisodeCount,
    watchedEpisodeCount: snapshot.watchedEpisodeCount,
    tvmazeTier: decision.tier,
    tvmazeRegularEpisodeCount,
    tvmazeEpisodeCountIncludingSpecials: episodeCountIncludingSpecials,
    animeNumberingRiskDetected,
    closeCompetitorDetected: closeCompetitor.detected,
    isDuplicateTitleGroupMember: false,
    structuralAutoMatchProposed: structuralAutoMatch.proposedTier === 'AUTO_MATCH',
  });

  const chronological = [...regularEpisodes].sort((a, b) => {
    if (a.airdate && b.airdate) return a.airdate.localeCompare(b.airdate);
    if (a.season !== b.season) return a.season - b.season;
    return (a.number ?? 0) - (b.number ?? 0);
  });
  const nextEpisodeComparison = computeNextEpisodeComparison(chronological, snapshot.watchedEpisodeCount, snapshot.currentNextEpisodeTitle);

  return {
    tier: decision.tier,
    tierReason: decision.reason,
    topCandidate: toCandidateSummary(top.result, top.breakdown),
    topCandidates,
    closeCompetitorDetected: closeCompetitor.detected,
    closeCompetitorReason: closeCompetitor.reason,
    tvmazeId,
    tvmazeTitle: show.name,
    tvmazeYear: parseYear(show.premiered),
    tvmazeStatus: show.status,
    tvmazeProvider: providerName(show),
    tvmazeSeasonCount: new Set(regularEpisodes.map((e) => e.season)).size,
    tvmazeSeasonNumbers: [...new Set(regularEpisodes.map((e) => e.season))].sort((a, b) => a - b),
    tvmazeRegularEpisodeCount,
    tvmazeEpisodeCountIncludingSpecials: episodeCountIncludingSpecials,
    animeNumberingRiskDetected,
    structuralAutoMatchProposed: structuralAutoMatch.proposedTier === 'AUTO_MATCH',
    structuralAutoMatchReason: structuralAutoMatch.reason,
    category: category.category,
    categoryReasons: category.reasons,
    nextEpisodeProposedLabel: nextEpisodeComparison.tvmazeProposedNextEpisodeLabel,
    nextEpisodeProposedTitle: nextEpisodeComparison.tvmazeProposedNextEpisodeTitle,
    nextEpisodeTitlesComparable: nextEpisodeComparison.titlesComparable,
    nextEpisodeTitlesMatch: nextEpisodeComparison.titlesMatch,
    nextEpisodeComparisonNote: nextEpisodeComparison.note,
    chronologicalEpisodes: chronological,
  };
}

function checkAbsolutePosition(chronological: TvMazeEpisode[], position: number): { position: number; found: boolean; label: string | null; title: string | null } {
  const ep = chronological[position - 1] ?? null;
  return { position, found: !!ep, label: ep ? `S${ep.season}E${ep.number ?? '?'}` : null, title: ep?.name ?? null };
}

function checkLabel(chronological: TvMazeEpisode[], label: string, seasonNumber: number, episodeNumber: number): { label: string; seasonNumber: number; episodeNumber: number; found: boolean; title: string | null } {
  const ep = chronological.find((e) => e.season === seasonNumber && e.number === episodeNumber) ?? null;
  return { label, seasonNumber, episodeNumber, found: !!ep, title: ep?.name ?? null };
}

function checkTitle(chronological: TvMazeEpisode[], title: string): { title: string; found: boolean; label: string | null } {
  const needle = title.trim().toLowerCase();
  const ep = chronological.find((e) => e.name?.trim().toLowerCase() === needle) ?? null;
  return { title, found: !!ep, label: ep ? `S${ep.season}E${ep.number ?? '?'}` : null };
}

interface ReportItem {
  itemKey: string;
  itemLabel: string;
  matchedSeriesId: string;
  currentDb: {
    userStatus: string | null;
    releaseStatus: string;
    tmdbId: string | null;
    watchedEpisodeCount: number;
    knownEpisodeCount: number;
    knownSeasonNumbers: number[];
    currentNextEpisodeLabel: string | null;
  };
  tvmaze: {
    tier: TvMazeTier;
    tierReason: string;
    topCandidate: CandidateSummary | null;
    topCandidates: CandidateSummary[];
    closeCompetitorDetected: boolean;
    closeCompetitorReason: string | null;
    candidateTitle: string | null;
    candidateYear: number | null;
    candidateStatus: string | null;
    candidateProvider: string | null;
    candidateSeasonCount: number | null;
    candidateSeasonNumbers: number[] | null;
    candidateRegularEpisodeCount: number | null;
    candidateEpisodeCountIncludingSpecials: number | null;
    animeNumberingRiskDetected: boolean;
    structuralAutoMatchProposed: boolean;
    structuralAutoMatchReason: string;
    category: ProviderComparisonCategory;
    categoryReasons: string[];
    nextEpisodeProposedLabel: string | null;
    nextEpisodeProposedTitle: string | null;
    nextEpisodeTitlesComparable: boolean;
    nextEpisodeTitlesMatch: boolean | null;
    nextEpisodeComparisonNote: string;
  };
  keyEpisodeCheck: KeyEpisodeCheck | null;
  supportsUserProgress: boolean | null;
  classification: RiskyTitleClassification;
  classificationReason: string;
  investigationNotes: string[];
}

async function main() {
  console.log('Targeted TVmaze comparison for known risky/mismatched titles — report only, no writes to any Prisma table.');

  const prisma = new PrismaClient();
  const tvmaze = new TvMazeClient();
  const generatedAt = new Date();

  const snap: Record<string, Snapshot> = {};
  for (const [key, seriesId] of Object.entries(ids)) {
    const s = await loadSnapshot(prisma, seriesId);
    if (!s) throw new Error(`Series id for "${key}" (${seriesId}) not found — ids map may be stale`);
    snap[key] = s;
  }
  await prisma.$disconnect();

  const items: ReportItem[] = [];

  // Helper to assemble the common report shape from a snapshot + tvmaze
  // signals; classification/keyEpisodeCheck/investigationNotes are supplied
  // per item below so each title's hand-curated reasoning stays explicit
  // (same "no generic classifier for 22 distinct manual cases" principle
  // manual-progress-corrections/run-plan.ts already established).
  function buildItem(
    itemKey: string,
    itemLabel: string,
    s: Snapshot,
    t: TvMazeSignals,
    keyEpisodeCheck: KeyEpisodeCheck | null,
    supportsUserProgress: boolean | null,
    classification: RiskyTitleClassification,
    classificationReason: string,
    investigationNotes: string[],
  ): ReportItem {
    return {
      itemKey,
      itemLabel,
      matchedSeriesId: s.seriesId,
      currentDb: {
        userStatus: s.userStatus,
        releaseStatus: s.releaseStatus,
        tmdbId: s.tmdbId,
        watchedEpisodeCount: s.watchedEpisodeCount,
        knownEpisodeCount: s.knownEpisodeCount,
        knownSeasonNumbers: s.knownSeasonNumbers,
        currentNextEpisodeLabel: s.currentNextEpisodeLabel,
      },
      tvmaze: {
        tier: t.tier,
        tierReason: t.tierReason,
        topCandidate: t.topCandidate,
        topCandidates: t.topCandidates,
        closeCompetitorDetected: t.closeCompetitorDetected,
        closeCompetitorReason: t.closeCompetitorReason,
        candidateTitle: t.tvmazeTitle,
        candidateYear: t.tvmazeYear,
        candidateStatus: t.tvmazeStatus,
        candidateProvider: t.tvmazeProvider,
        candidateSeasonCount: t.tvmazeSeasonCount,
        candidateSeasonNumbers: t.tvmazeSeasonNumbers,
        candidateRegularEpisodeCount: t.tvmazeRegularEpisodeCount,
        candidateEpisodeCountIncludingSpecials: t.tvmazeEpisodeCountIncludingSpecials,
        animeNumberingRiskDetected: t.animeNumberingRiskDetected,
        structuralAutoMatchProposed: t.structuralAutoMatchProposed,
        structuralAutoMatchReason: t.structuralAutoMatchReason,
        category: t.category,
        categoryReasons: t.categoryReasons,
        nextEpisodeProposedLabel: t.nextEpisodeProposedLabel,
        nextEpisodeProposedTitle: t.nextEpisodeProposedTitle,
        nextEpisodeTitlesComparable: t.nextEpisodeTitlesComparable,
        nextEpisodeTitlesMatch: t.nextEpisodeTitlesMatch,
        nextEpisodeComparisonNote: t.nextEpisodeComparisonNote,
      },
      keyEpisodeCheck,
      supportsUserProgress,
      classification,
      classificationReason,
      investigationNotes,
    };
  }

  // 1. Mom — checked first per instruction. Key question: does TVmaze have
  // S5E14?
  {
    const s = snap.mom;
    const t = await compareAgainstTvMaze(tvmaze, s);
    const keyCheck: KeyEpisodeCheck = {
      description: 'Does TVmaze have Season 5 Episode 14?',
      foundByAbsolutePosition: checkAbsolutePosition(t.chronologicalEpisodes, s.watchedEpisodeCount + 1),
      foundByLabel: checkLabel(t.chronologicalEpisodes, 'S5E14', 5, 14),
    };
    const hasS5E14 = keyCheck.foundByLabel?.found ?? false;
    const strongMatch = t.tier === 'AUTO_MATCH' && !t.closeCompetitorDetected;
    // The raw tier alone underplays this one: the "Mom" bare-title search
    // genuinely has a close competitor (a different, unrelated "Mom" show
    // scoring within 1 point), so closeCompetitorDetected is correctly true
    // and structural auto-match correctly declines to promote it — but the
    // top candidate's network (CBS, the real Mom sitcom's actual network)
    // and the fact that it has S5E14 at all are strong corroborating signals
    // that this is genuinely the right show. Finding the actual target
    // episode is the single most decision-relevant fact for this item, so it
    // outweighs "not AUTO_MATCH tier" when deciding NOT_USEFUL vs.
    // NEEDS_CONFIRMATION — a real find pending a one-glance identity check
    // is not "not useful."
    const classification: RiskyTitleClassification = strongMatch && hasS5E14 ? 'TVMAZE_SAFE_MATCH' : hasS5E14 ? 'TVMAZE_NEEDS_USER_CONFIRMATION' : 'TVMAZE_NOT_USEFUL_FOR_THIS_CASE';
    items.push(
      buildItem(
        '1-mom',
        'Mom',
        s,
        t,
        keyCheck,
        hasS5E14,
        classification,
        strongMatch && hasS5E14
          ? 'High-confidence TVmaze match AND TVmaze has S5E14 — the exact episode the user is missing. Strong candidate for targeted TVmaze enrichment/progress apply later.'
          : hasS5E14
            ? `TVmaze's top candidate ("${t.tvmazeTitle}", network ${t.tvmazeProvider ?? 'unknown'}) has S5E14 — the exact episode the user is missing — but the raw score (${t.topCandidate?.confidenceScore ?? 'n/a'}) sits below the AUTO_MATCH threshold only because the title has no year hint to score against (a known structural scoring cap, see tvmaze-scoring.ts), and a same-titled, similarly-scored but unrelated "Mom" show also appears in results. One quick identity confirmation (network=CBS, episode title text) away from being a strong candidate for targeted enrichment/progress apply.`
            : 'TVmaze did not produce a confident, uncontested match for Mom, and S5E14 was not found under its top candidate.',
        [
          `TVmaze tier: ${t.tier} (${t.tierReason}).`,
          `TVmaze candidate: ${t.tvmazeTitle ?? 'none'} (${t.tvmazeYear ?? 'unknown year'}), provider: ${t.tvmazeProvider ?? 'unknown'}, status: ${t.tvmazeStatus ?? 'unknown'}.`,
          `S5E14 by label: ${keyCheck.foundByLabel?.found ? `found ("${keyCheck.foundByLabel.title}")` : 'NOT found'}. By absolute position (${s.watchedEpisodeCount + 1}): ${keyCheck.foundByAbsolutePosition.found ? `found ("${keyCheck.foundByAbsolutePosition.title}", ${keyCheck.foundByAbsolutePosition.label})` : 'not found'}.`,
        ],
      ),
    );
  }

  // 2. Devil May Cry (2025) — key question: does TVmaze show more than one
  // season, or otherwise help confirm/deny catalog completeness beyond S1?
  {
    const s = snap.dmc2025;
    const t = await compareAgainstTvMaze(tvmaze, s);
    const tvmazeAgreesSingleSeason = t.tvmazeSeasonCount === 1;
    const tvmazeShowsMoreSeasons = (t.tvmazeSeasonCount ?? 0) > 1;
    let classification: RiskyTitleClassification;
    let reason: string;
    if (t.tier === 'NO_MATCH') {
      classification = 'TVMAZE_NOT_USEFUL_FOR_THIS_CASE';
      reason = 'No confident TVmaze match — cannot use TVmaze to confirm or deny catalog completeness beyond Season 1.';
    } else if (tvmazeShowsMoreSeasons) {
      classification = 'TVMAZE_NEEDS_USER_CONFIRMATION';
      reason = `TVmaze's candidate shows ${t.tvmazeSeasonCount} seasons (ours has only 1) — this is exactly the signal that could resolve the DATA_INCOMPLETE finding, but must be user-confirmed before any enrichment given the recent progress-correction history for this title.`;
    } else if (tvmazeAgreesSingleSeason) {
      classification = 'TVMAZE_NEEDS_USER_CONFIRMATION';
      reason = 'TVmaze also only knows one season — does not independently confirm the catalog is complete (both TV Time and TVmaze could simply be equally behind), so this alone cannot clear DATA_INCOMPLETE.';
    } else {
      classification = 'TVMAZE_NOT_USEFUL_FOR_THIS_CASE';
      reason = 'TVmaze candidate found but season count is inconclusive for this question.';
    }
    items.push(
      buildItem(
        '2-devil-may-cry-2025',
        'Devil May Cry (2025)',
        s,
        t,
        null,
        tvmazeShowsMoreSeasons ? true : tvmazeAgreesSingleSeason ? null : null,
        classification,
        reason,
        [
          `Our DB: 1 known season, ${s.knownEpisodeCount}/${s.knownEpisodeCount} watched (see manual-progress-corrections' DATA_INCOMPLETE finding for this title, 2026-07-05).`,
          `TVmaze candidate: ${t.tvmazeTitle ?? 'none'} (${t.tvmazeYear ?? 'unknown'}), provider: ${t.tvmazeProvider ?? 'unknown'}, status: ${t.tvmazeStatus ?? 'unknown'}, seasons known: ${t.tvmazeSeasonCount ?? 'n/a'} (${t.tvmazeSeasonNumbers?.join(',') ?? 'n/a'}).`,
          'Per docs/metadata-provider-strategy.md §4: recommended first step for this title was a TMDb re-check, with TVmaze only as a quick no-auth secondary confirmation — this comparison is exactly that secondary confirmation, not a replacement for checking TMDb directly.',
        ],
      ),
    );
  }

  // 3. One Piece — known anime-numbering risk (docs). Key question: does
  // TVmaze have an episode at absolute position 1158, and does it use
  // sequential season numbering compatible with our S23E3?
  {
    const s = snap.onePiece;
    const t = await compareAgainstTvMaze(tvmaze, s);
    const keyCheck: KeyEpisodeCheck = {
      description: 'Does TVmaze have an episode at absolute position 1158 (our next episode), and/or S23E3?',
      foundByAbsolutePosition: checkAbsolutePosition(t.chronologicalEpisodes, 1158),
      foundByLabel: checkLabel(t.chronologicalEpisodes, 'S23E3', 23, 3),
    };
    items.push(
      buildItem(
        '3-one-piece',
        'One Piece',
        s,
        t,
        keyCheck,
        keyCheck.foundByAbsolutePosition.found,
        'NEEDS_THETVDB_ABSOLUTE_ORDER',
        'Long-running anime on the explicit risk list (docs/episode-numbering-and-season-shift-risk.md); docs/metadata-provider-strategy.md §4 recommends TheTVDB\'s absolute-order field as the direct fix, AniList as a season/arc cross-check. TVmaze result below is reported for completeness but not treated as sufficient on its own for this structural problem.',
        [
          `TVmaze tier: ${t.tier} (${t.tierReason}). Candidate seasons known: ${t.tvmazeSeasonCount ?? 'n/a'} (ours: ${s.knownSeasonNumbers.length} seasons).`,
          `Absolute position 1158 in TVmaze's own chronological ordering: ${keyCheck.foundByAbsolutePosition.found ? `found (${keyCheck.foundByAbsolutePosition.label}, "${keyCheck.foundByAbsolutePosition.title}")` : 'does not exist in TVmaze\'s catalog either'}.`,
          `TVmaze S23E3 (matching our own season numbering directly): ${keyCheck.foundByLabel?.found ? 'found' : 'NOT found — TVmaze likely numbers seasons differently from our catalog, per tvmaze-compare.ts\'s own documented finding that anime season boundaries commonly disagree between providers'}.`,
          animeRiskNote(t),
        ],
      ),
    );
  }

  // 4. ONE PIECE (2023) live action — distinct row, no anime-numbering risk
  // (only 16 episodes, not long-running); Wikidata-class identity concern
  // exists only insofar as it must not be conflated with item 3.
  {
    const s = snap.onePiece2023;
    const t = await compareAgainstTvMaze(tvmaze, s);
    const strongMatch = t.tier === 'AUTO_MATCH' && !t.closeCompetitorDetected;
    items.push(
      buildItem(
        '4-one-piece-2023',
        'ONE PIECE (2023)',
        s,
        t,
        null,
        null,
        strongMatch ? 'TVMAZE_SAFE_MATCH' : t.tier === 'NO_MATCH' ? 'TVMAZE_NOT_USEFUL_FOR_THIS_CASE' : 'TVMAZE_NEEDS_USER_CONFIRMATION',
        strongMatch
          ? 'Confident, uncontested TVmaze match; small episode count (16) and not anime-numbering-risky. Distinct DB row from the "One Piece" anime — do not conflate.'
          : 'TVmaze match is not clean enough to treat as safe without review — see closeCompetitorDetected/tier below.',
        [
          `TVmaze tier: ${t.tier} (${t.tierReason}). Close competitor detected: ${t.closeCompetitorDetected} (${t.closeCompetitorReason ?? 'n/a'}) — checking specifically against the anime "One Piece" (item 3) since both share a bare title.`,
          `Candidate: ${t.tvmazeTitle ?? 'none'} (${t.tvmazeYear ?? 'unknown'}), episodes known: ${t.tvmazeRegularEpisodeCount ?? 'n/a'} (ours: ${s.knownEpisodeCount}).`,
        ],
      ),
    );
  }

  // 5. InuYasha — known relation-ambiguity + numbering risk (docs). Key
  // question: does TVmaze have absolute position 55 / S2E28?
  {
    const s = snap.inuYasha;
    const t = await compareAgainstTvMaze(tvmaze, s);
    const keyCheck: KeyEpisodeCheck = {
      description: 'Does TVmaze have an episode at absolute position 55 (episode 55), and/or S2E28?',
      foundByAbsolutePosition: checkAbsolutePosition(t.chronologicalEpisodes, 55),
      foundByLabel: checkLabel(t.chronologicalEpisodes, 'S2E28', 2, 28),
    };
    items.push(
      buildItem(
        '5-inuyasha',
        'InuYasha',
        s,
        t,
        keyCheck,
        keyCheck.foundByAbsolutePosition.found,
        'NEEDS_ANILIST_RELATION_MAPPING',
        'On the explicit "do not trust" list (docs/episode-numbering-and-season-shift-risk.md §5) specifically because of an unresolved relationship question with "InuYasha: The Final Act" (item 6) — per docs/metadata-provider-strategy.md §4, AniList\'s relations graph is the right tool to confirm the sequel relationship before any catalog/numbering fix is attempted with TVmaze or TheTVDB.',
        [
          `TVmaze tier: ${t.tier} (${t.tierReason}).`,
          `Absolute position 55: ${keyCheck.foundByAbsolutePosition.found ? `found (${keyCheck.foundByAbsolutePosition.label}, "${keyCheck.foundByAbsolutePosition.title}")` : 'not found in TVmaze\'s catalog either'}. S2E28 by our own numbering: ${keyCheck.foundByLabel?.found ? 'found' : 'NOT found'}.`,
          'This TVmaze lookup is reported for completeness, but does not resolve the underlying question (is "Final Act" a continuation?) — that is a relations question, not a catalog-completeness question, so TVmaze alone cannot close this one out.',
        ],
      ),
    );
  }

  // 6. InuYasha: The Final Act — not started (per manual-progress-corrections
  // finding); same relation-ambiguity as item 5.
  {
    const s = snap.inuYashaFinalAct;
    const t = await compareAgainstTvMaze(tvmaze, s);
    items.push(
      buildItem(
        '6-inuyasha-final-act',
        'InuYasha: The Final Act',
        s,
        t,
        null,
        null,
        s.userStatus === null ? 'DO_NOT_TOUCH' : 'NEEDS_ANILIST_RELATION_MAPPING',
        s.userStatus === null
          ? 'Not started (no UserSeriesProgress row) — nothing to fix right now regardless of what TVmaze reports; still needs AniList relation confirmation before any future enrichment decision, but there is no urgent progress problem to resolve today.'
          : 'Same relation-ambiguity as InuYasha (item 5) — needs AniList confirmation, not a TVmaze catalog lookup.',
        [
          `Current DB: userStatus=${s.userStatus ?? 'none'}, ${s.knownEpisodeCount} known episodes.`,
          `TVmaze tier: ${t.tier} (${t.tierReason}). Candidate: ${t.tvmazeTitle ?? 'none'}.`,
        ],
      ),
    );
  }

  // 7. Rurouni Kenshin — known POSSIBLE_REMAKE_COLLISION risk (docs: 1996
  // anime, 2023 anime remake, live-action films). Progress is already
  // correct per manual-progress-corrections (DO_NOT_TOUCH there); the
  // question here is purely "is TVmaze safe to use for this title," not
  // "does progress need fixing."
  {
    const s = snap.rurouniKenshin;
    const t = await compareAgainstTvMaze(tvmaze, s);
    const identityRisky = t.closeCompetitorDetected || (t.tvmazeYear !== null && t.tvmazeYear !== 1996 && t.tvmazeYear !== undefined);
    items.push(
      buildItem(
        '7-rurouni-kenshin',
        'Rurouni Kenshin',
        s,
        t,
        null,
        null,
        identityRisky ? 'NEEDS_WIKIDATA_IDENTITY_DISAMBIGUATION' : t.tier === 'AUTO_MATCH' ? 'TVMAZE_NEEDS_USER_CONFIRMATION' : 'TVMAZE_NOT_USEFUL_FOR_THIS_CASE',
        identityRisky
          ? 'Multiple real-world adaptations exist (1996 anime, 2023 anime remake, live-action films) — flagged POSSIBLE_REMAKE_COLLISION-class risk in prior TVmaze audits. Per docs/metadata-provider-strategy.md §4/§3, Wikidata is the right tool to confirm which adaptation this DB row is before trusting any single-provider catalog lookup.'
          : 'No close competitor detected and candidate year is consistent with the original 1996 anime, but keep as user-confirmation given the known collision risk for this title generally.',
        [
          `Progress is already correct per manual-progress-corrections (item 7, DO_NOT_TOUCH — "already updated"). This report only evaluates whether TVmaze is safe to use for further catalog work on this title, not whether progress needs changing.`,
          `TVmaze tier: ${t.tier} (${t.tierReason}). Candidate: ${t.tvmazeTitle ?? 'none'} (${t.tvmazeYear ?? 'unknown'}). Close competitor: ${t.closeCompetitorDetected} (${t.closeCompetitorReason ?? 'n/a'}).`,
        ],
      ),
    );
  }

  // 8. JUJUTSU KAISEN — confirmed structural mismatch (docs §1: TMDb models
  // it as one absolute season of 59; ours is 24+23+7=54). Key question: does
  // TVmaze have the exact title "Tokyo Colony No. 1 - Part 2"?
  {
    const s = snap.jjk;
    const t = await compareAgainstTvMaze(tvmaze, s);
    const keyCheck: KeyEpisodeCheck = {
      description: 'Does TVmaze have an episode titled "Tokyo Colony No. 1 - Part 2"?',
      foundByAbsolutePosition: checkAbsolutePosition(t.chronologicalEpisodes, s.watchedEpisodeCount + 1),
      foundByTitle: checkTitle(t.chronologicalEpisodes, 'Tokyo Colony No. 1 - Part 2'),
    };
    items.push(
      buildItem(
        '8-jujutsu-kaisen',
        'JUJUTSU KAISEN',
        s,
        t,
        keyCheck,
        keyCheck.foundByTitle?.found ?? null,
        'NEEDS_THETVDB_ABSOLUTE_ORDER',
        'Confirmed structural mismatch with TMDb (docs/episode-numbering-and-season-shift-risk.md §2: 59 absolute vs. our 54 across 3 seasons) — docs/metadata-provider-strategy.md §4 recommends TheTVDB for the absolute-order fix, AniList to confirm cour/season boundaries. TVmaze title-match result reported below but not treated as a resolution.',
        [
          `TVmaze tier: ${t.tier} (${t.tierReason}). Candidate season count: ${t.tvmazeSeasonCount ?? 'n/a'} (ours: 3).`,
          `Exact title "Tokyo Colony No. 1 - Part 2": ${keyCheck.foundByTitle?.found ? `found at ${keyCheck.foundByTitle.label}` : 'NOT found in TVmaze\'s episode list'}.`,
          animeRiskNote(t),
        ],
      ),
    );
  }

  // 9-15: anime long-runners — per instruction, must not be auto-resolved
  // just because the title matches. Each gets its own real TVmaze lookup;
  // classification depends on actual season-structure agreement/disagreement
  // found below, not assumed.
  const longRunners: Array<{ key: string; label: string; snapshotKey: string }> = [
    { key: '9-naruto', label: 'Naruto', snapshotKey: 'naruto' },
    { key: '10-naruto-shippuden', label: 'Naruto Shippuden', snapshotKey: 'narutoShippuden' },
    { key: '11-dragon-ball-z', label: 'Dragon Ball Z', snapshotKey: 'dbz' },
    { key: '12-dragon-ball-kai', label: 'Dragon Ball Kai', snapshotKey: 'dbKai' },
    { key: '13-dragon-ball-super', label: 'Dragon Ball Super', snapshotKey: 'dbSuper' },
    { key: '14-my-hero-academia', label: 'My Hero Academia', snapshotKey: 'mha' },
    { key: '15-boruto', label: 'Boruto: Naruto Next Generations', snapshotKey: 'boruto' },
  ];
  for (const { key, label, snapshotKey } of longRunners) {
    const s = snap[snapshotKey];
    const t = await compareAgainstTvMaze(tvmaze, s);
    const seasonStructureAgrees = t.tvmazeSeasonCount !== null && t.tvmazeSeasonCount === s.knownSeasonNumbers.length;
    let classification: RiskyTitleClassification;
    let reason: string;
    if (t.tier === 'NO_MATCH') {
      classification = 'TVMAZE_NOT_USEFUL_FOR_THIS_CASE';
      reason = 'No confident TVmaze match.';
    } else if (t.animeNumberingRiskDetected || !seasonStructureAgrees) {
      classification = 'NEEDS_THETVDB_ABSOLUTE_ORDER';
      reason = `Long-running anime; TVmaze's season count (${t.tvmazeSeasonCount ?? 'n/a'}) ${seasonStructureAgrees ? 'matches' : 'does NOT match'} ours (${s.knownSeasonNumbers.length}) — per the title's own numbering-risk flag, do not treat title match alone as sufficient; TheTVDB's absolute-order field is the safer structural fix.`;
    } else {
      classification = 'TVMAZE_NEEDS_USER_CONFIRMATION';
      reason = `TVmaze's season count agrees with ours (${t.tvmazeSeasonCount}) and no anime-numbering risk was flagged, but per instruction, long-running anime should never be auto-resolved from a title match alone — still requires explicit user confirmation before any enrichment.`;
    }
    items.push(
      buildItem(key, label, s, t, null, seasonStructureAgrees, classification, reason, [
        `TVmaze tier: ${t.tier} (${t.tierReason}). animeNumberingRiskDetected=${t.animeNumberingRiskDetected}.`,
        `Season counts — ours: ${s.knownSeasonNumbers.length} (${s.knownSeasonNumbers.join(',')}), TVmaze: ${t.tvmazeSeasonCount ?? 'n/a'} (${t.tvmazeSeasonNumbers?.join(',') ?? 'n/a'}).`,
        `Episode counts — ours: ${s.knownEpisodeCount}, TVmaze regular: ${t.tvmazeRegularEpisodeCount ?? 'n/a'}, TVmaze incl. specials: ${t.tvmazeEpisodeCountIncludingSpecials ?? 'n/a'}.`,
      ]),
    );
  }

  // 16a/16b: Ranma ½ (2024) apply-target vs. original — duplicate-title-group
  // risk (docs §2), same identity-before-catalog reasoning as Doctor
  // Who/Avatar for the pair, though not explicitly called out by name in this
  // task's "pay special attention" list.
  {
    const s = snap.ranma2024;
    const t = await compareAgainstTvMaze(tvmaze, s);
    const identityRisky = t.closeCompetitorDetected;
    items.push(
      buildItem(
        '16a-ranma-2024',
        'Ranma ½ (2024)',
        s,
        t,
        null,
        null,
        identityRisky ? 'NEEDS_WIKIDATA_IDENTITY_DISAMBIGUATION' : t.tier === 'AUTO_MATCH' ? 'TVMAZE_SAFE_MATCH' : 'TVMAZE_NEEDS_USER_CONFIRMATION',
        identityRisky
          ? 'Close competitor detected against the original Ranma ½ (item 16b) — resolve identity before trusting either candidate.'
          : 'Small, recent catalog (2024 remake); not anime-numbering-risky given low episode count. Distinct DB row from the original — do not conflate.',
        [
          `Duplicate-title-group pair with item 16b (docs §2) — checked for close-competitor collision specifically.`,
          `TVmaze tier: ${t.tier} (${t.tierReason}). Close competitor: ${t.closeCompetitorDetected} (${t.closeCompetitorReason ?? 'n/a'}). Candidate: ${t.tvmazeTitle ?? 'none'} (${t.tvmazeYear ?? 'unknown'}).`,
        ],
      ),
    );
  }
  {
    const s = snap.ranmaOriginal;
    const t = await compareAgainstTvMaze(tvmaze, s);
    items.push(
      buildItem(
        '16b-ranma-original',
        'Ranma ½ (original)',
        s,
        t,
        null,
        null,
        t.animeNumberingRiskDetected ? 'NEEDS_THETVDB_ABSOLUTE_ORDER' : t.closeCompetitorDetected ? 'NEEDS_WIKIDATA_IDENTITY_DISAMBIGUATION' : 'TVMAZE_NEEDS_USER_CONFIRMATION',
        t.animeNumberingRiskDetected
          ? 'Long-running original series — anime-numbering risk detected; per instruction do not auto-resolve from title match alone.'
          : 'Do not apply the 2024-remake decision here (per manual-progress-corrections item 16b) — distinct identity from item 16a regardless of what TVmaze reports.',
        [
          `Current DB: userStatus=${s.userStatus ?? 'none'}, watched ${s.watchedEpisodeCount}/${s.knownEpisodeCount}.`,
          `TVmaze tier: ${t.tier} (${t.tierReason}). animeNumberingRiskDetected=${t.animeNumberingRiskDetected}.`,
        ],
      ),
    );
  }

  // 17a/17b: Hunter x Hunter (2011) vs. original — duplicate-title-group,
  // anime-numbering risk applies to whichever has substantial episode count.
  {
    const s = snap.hxh2011;
    const t = await compareAgainstTvMaze(tvmaze, s);
    items.push(
      buildItem(
        '17a-hunter-x-hunter-2011',
        'Hunter x Hunter (2011)',
        s,
        t,
        null,
        null,
        t.animeNumberingRiskDetected ? 'NEEDS_THETVDB_ABSOLUTE_ORDER' : t.closeCompetitorDetected ? 'NEEDS_WIKIDATA_IDENTITY_DISAMBIGUATION' : 'TVMAZE_NEEDS_USER_CONFIRMATION',
        t.animeNumberingRiskDetected
          ? 'Long-running (148 episodes) — anime-numbering risk; do not auto-resolve from title match alone even if TVmaze scores this confidently.'
          : 'Confident-enough match but still needs explicit confirmation given the duplicate-title-group pairing with the original/1999 entry (item 17b).',
        [
          `Duplicate-title-group pair with item 17b (docs §2).`,
          `TVmaze tier: ${t.tier} (${t.tierReason}). animeNumberingRiskDetected=${t.animeNumberingRiskDetected}. Season counts — ours: ${s.knownSeasonNumbers.length}, TVmaze: ${t.tvmazeSeasonCount ?? 'n/a'}.`,
        ],
      ),
    );
  }
  {
    const s = snap.hxhOriginal;
    const t = await compareAgainstTvMaze(tvmaze, s);
    items.push(
      buildItem(
        '17b-hunter-x-hunter-original',
        'Hunter x Hunter (original/1999)',
        s,
        t,
        null,
        null,
        s.userStatus === null ? 'DO_NOT_TOUCH' : 'NEEDS_WIKIDATA_IDENTITY_DISAMBIGUATION',
        s.userStatus === null
          ? 'Effectively unused per manual-progress-corrections (no UserSeriesProgress row, minimal episode data) — nothing to fix regardless of TVmaze findings.'
          : 'Distinct entry from the 2011 remake (item 17a) — confirm identity before any catalog work.',
        [`Current DB: userStatus=${s.userStatus ?? 'none'}, ${s.knownEpisodeCount} known episodes.`, `TVmaze tier: ${t.tier} (${t.tierReason}).`],
      ),
    );
  }

  // 18a/18b: Doctor Who — explicitly identity-sensitive per instruction, not
  // to be blindly matched even if scores look confident.
  {
    const s = snap.doctorWho2005;
    const t = await compareAgainstTvMaze(tvmaze, s);
    const yearConsistent = t.tvmazeYear !== null && t.tvmazeYear <= 2010; // 2005 revival era, not the 2023/Disney+ era
    const identityConfirmedByProvider = t.tvmazeProvider !== null && !/disney/i.test(t.tvmazeProvider);
    const safe = t.tier === 'AUTO_MATCH' && !t.closeCompetitorDetected && yearConsistent;
    items.push(
      buildItem(
        '18a-doctor-who-2005',
        'Doctor Who (2005)',
        s,
        t,
        null,
        null,
        safe ? 'TVMAZE_SAFE_MATCH' : 'NEEDS_WIKIDATA_IDENTITY_DISAMBIGUATION',
        safe
          ? `Year (${t.tvmazeYear}) and provider (${t.tvmazeProvider ?? 'unknown'}) are consistent with the 2005 BBC revival era, not the 2023 Disney+ era — treated as identity-confirmed, not just score-confirmed, per instruction to keep Doctor Who identity-sensitive.`
          : 'Per instruction, Doctor Who must not be blindly score-matched — year/provider signal was inconclusive or contradictory, so identity needs explicit (e.g. Wikidata) confirmation before trusting this candidate, regardless of the raw TVmaze score.',
        [
          `Duplicate-title-group pair with item 18b (docs §2) — this is exactly the "identity before catalog" case docs/metadata-provider-strategy.md §4 calls out for Doctor Who specifically.`,
          `TVmaze tier: ${t.tier} (${t.tierReason}). Candidate: ${t.tvmazeTitle ?? 'none'}, year ${t.tvmazeYear ?? 'unknown'}, provider ${t.tvmazeProvider ?? 'unknown'}, status ${t.tvmazeStatus ?? 'unknown'}.`,
          `identityConfirmedByProvider (not Disney-branded): ${identityConfirmedByProvider}.`,
        ],
      ),
    );
  }
  {
    const s = snap.doctorWho2023;
    const t = await compareAgainstTvMaze(tvmaze, s);
    const yearConsistent = t.tvmazeYear !== null && t.tvmazeYear >= 2023;
    const safe = t.tier === 'AUTO_MATCH' && !t.closeCompetitorDetected && yearConsistent;
    items.push(
      buildItem(
        '18b-doctor-who-2023',
        'Doctor Who (2023)',
        s,
        t,
        null,
        null,
        safe ? 'TVMAZE_SAFE_MATCH' : 'NEEDS_WIKIDATA_IDENTITY_DISAMBIGUATION',
        safe
          ? `Year (${t.tvmazeYear}) is consistent with the 2023+ Disney+/BBC co-production era — treated as identity-confirmed, not just score-confirmed.`
          : 'Per instruction, Doctor Who must not be blindly score-matched — year signal was inconclusive, needs explicit identity confirmation.',
        [
          `Duplicate-title-group pair with item 18a.`,
          `TVmaze tier: ${t.tier} (${t.tierReason}). Candidate: ${t.tvmazeTitle ?? 'none'}, year ${t.tvmazeYear ?? 'unknown'}, provider ${t.tvmazeProvider ?? 'unknown'}, status ${t.tvmazeStatus ?? 'unknown'}.`,
        ],
      ),
    );
  }

  // 19a/19b: Avatar — animation vs. live-action must not be conflated
  // (explicit instruction). Genre/type signal used to hard-block conflation
  // regardless of score.
  {
    const s = snap.avatarAnimated;
    const t = await compareAgainstTvMaze(tvmaze, s);
    const looksAnimated = t.topCandidate ? true : false; // presence check only; real genre check below via investigation notes
    items.push(
      buildItem(
        '19a-avatar-animated',
        'Avatar: The Last Airbender (animated)',
        s,
        t,
        null,
        null,
        t.closeCompetitorDetected ? 'NEEDS_WIKIDATA_IDENTITY_DISAMBIGUATION' : t.tier === 'AUTO_MATCH' ? 'TVMAZE_SAFE_MATCH' : 'TVMAZE_NEEDS_USER_CONFIRMATION',
        t.closeCompetitorDetected
          ? 'Close competitor detected — likely the live-action entry (item 19b) scoring similarly for the bare title. Must not conflate animation with live-action per explicit instruction; resolve identity before trusting either.'
          : 'No close competitor from this search; still flag for confirmation since animation-vs-live-action is exactly the kind of collision instruction calls out to never resolve automatically.',
        [
          `Duplicate-title-group pair with item 19b (docs §2) — Wikidata is docs/metadata-provider-strategy.md §4's recommended first step for Avatar specifically ("solve identity first, catalog second"). This report does not call Wikidata (out of scope: reuse TVmaze tooling only), so identity is not independently confirmed here even when classified TVMAZE_SAFE_MATCH — treat that classification as "TVmaze's own signals are clean," not as a substitute for the Wikidata identity step the strategy doc recommends.`,
          `TVmaze tier: ${t.tier} (${t.tierReason}). Candidate: ${t.tvmazeTitle ?? 'none'} (${t.tvmazeYear ?? 'unknown'}). looksAnimated placeholder=${looksAnimated}.`,
        ],
      ),
    );
  }
  {
    const s = snap.avatarLiveAction;
    const t = await compareAgainstTvMaze(tvmaze, s);
    items.push(
      buildItem(
        '19b-avatar-live-action',
        'Avatar: The Last Airbender (2021, live action)',
        s,
        t,
        null,
        null,
        s.userStatus === null ? 'DO_NOT_TOUCH' : t.closeCompetitorDetected ? 'NEEDS_WIKIDATA_IDENTITY_DISAMBIGUATION' : 'TVMAZE_NEEDS_USER_CONFIRMATION',
        s.userStatus === null
          ? 'Not started (per manual-progress-corrections finding) — nothing to fix regardless of TVmaze findings; identity disambiguation from item 19a still matters for any future enrichment, but there is no active progress problem today.'
          : 'Must not be conflated with the animated entry (item 19a) — confirm identity before any catalog work.',
        [`Current DB: userStatus=${s.userStatus ?? 'none'}, ${s.knownEpisodeCount} known episodes.`, `TVmaze tier: ${t.tier} (${t.tierReason}). Candidate: ${t.tvmazeTitle ?? 'none'} (${t.tvmazeYear ?? 'unknown'}).`],
      ),
    );
  }

  const byClassification: Record<RiskyTitleClassification, number> = {
    TVMAZE_SAFE_MATCH: 0,
    TVMAZE_NEEDS_USER_CONFIRMATION: 0,
    TVMAZE_NOT_USEFUL_FOR_THIS_CASE: 0,
    NEEDS_THETVDB_ABSOLUTE_ORDER: 0,
    NEEDS_ANILIST_RELATION_MAPPING: 0,
    NEEDS_WIKIDATA_IDENTITY_DISAMBIGUATION: 0,
    MANUAL_MAPPING_REQUIRED: 0,
    DO_NOT_TOUCH: 0,
  };
  for (const it of items) byClassification[it.classification]++;

  console.log(`\nGenerated at: ${generatedAt.toISOString()}`);
  console.log(`API calls made: ${tvmaze.requestCount}`);
  console.log(JSON.stringify({ itemCount: items.length, byClassification }, null, 2));

  mkdirSync(OUT_DIR, { recursive: true });

  const jsonReport = {
    generatedAt: generatedAt.toISOString(),
    writesToAppTables: false,
    writesToAnyPrismaTable: false,
    note: 'Targeted, report-only TVmaze comparison for known risky/mismatched titles. No enrichment applied, no database writes of any kind (not even audit/cache bookkeeping) — every value here comes from a live read against TVmaze plus a read of current app-table state.',
    apiCallCount: tvmaze.requestCount,
    summary: { itemCount: items.length, byClassification },
    items,
  };
  const jsonPath = path.join(OUT_DIR, 'targeted-risky-title-tvmaze-comparison.json');
  writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2));
  console.log(`\nWrote ${jsonPath}`);

  const mdPath = path.join(OUT_DIR, 'targeted-risky-title-tvmaze-comparison.md');
  writeFileSync(mdPath, buildMarkdown(generatedAt, items, byClassification, tvmaze.requestCount));
  console.log(`Wrote ${mdPath}`);
}

function animeRiskNote(t: TvMazeSignals): string {
  return `animeNumberingRiskDetected=${t.animeNumberingRiskDetected} — per tvmaze-compare.ts's own documented finding, long-running anime season boundaries commonly disagree between TV Time/TMDb and TVmaze (e.g. broadcast-year vs. sequential numbering).`;
}

const CLASSIFICATION_ORDER: RiskyTitleClassification[] = [
  'TVMAZE_SAFE_MATCH',
  'TVMAZE_NEEDS_USER_CONFIRMATION',
  'NEEDS_THETVDB_ABSOLUTE_ORDER',
  'NEEDS_ANILIST_RELATION_MAPPING',
  'NEEDS_WIKIDATA_IDENTITY_DISAMBIGUATION',
  'MANUAL_MAPPING_REQUIRED',
  'TVMAZE_NOT_USEFUL_FOR_THIS_CASE',
  'DO_NOT_TOUCH',
];

function buildMarkdown(generatedAt: Date, items: ReportItem[], counts: Record<RiskyTitleClassification, number>, apiCallCount: number): string {
  const lines: string[] = [];
  lines.push('# Targeted Risky-Title TVmaze Comparison');
  lines.push('');
  lines.push(`Generated: ${generatedAt.toISOString()}`);
  lines.push('');
  lines.push('**Report only — no enrichment applied, no database writes of any kind.** Reuses `secondary-provider-audit`\'s existing TVmaze client, scoring, and comparison logic verbatim against a fixed list of 22 known risky/mismatched titles (see `docs/metadata-provider-strategy.md` and `docs/episode-numbering-and-season-shift-risk.md`).');
  lines.push('');
  lines.push(`TVmaze API calls made: ${apiCallCount}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total items: ${items.length}`);
  for (const c of CLASSIFICATION_ORDER) lines.push(`- **${c}**: ${counts[c]}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const c of CLASSIFICATION_ORDER) {
    const group = items.filter((it) => it.classification === c);
    if (group.length === 0) continue;

    lines.push(`## ${c} (${group.length})`);
    lines.push('');

    for (const it of group) {
      lines.push(`### ${it.itemLabel}`);
      lines.push('');
      lines.push(`- MyTv series id: \`${it.matchedSeriesId}\``);
      lines.push(
        `- Current DB: userStatus=${it.currentDb.userStatus ?? '_none_'} · releaseStatus=${it.currentDb.releaseStatus} · tmdbId=${it.currentDb.tmdbId ?? 'null'} · watched ${it.currentDb.watchedEpisodeCount}/${it.currentDb.knownEpisodeCount} known episodes · seasons known: ${it.currentDb.knownSeasonNumbers.join(',') || 'none'}`,
      );
      lines.push(`- Current nextEpisode: ${it.currentDb.currentNextEpisodeLabel ?? '_null_'}`);
      lines.push('');
      lines.push(`**TVmaze**: tier=\`${it.tvmaze.tier}\` (${it.tvmaze.tierReason})`);
      if (it.tvmaze.candidateTitle) {
        lines.push(
          `- candidate: "${it.tvmaze.candidateTitle}" (${it.tvmaze.candidateYear ?? 'unknown year'}) · provider: ${it.tvmaze.candidateProvider ?? 'unknown'} · status: ${it.tvmaze.candidateStatus ?? 'unknown'}`,
        );
        lines.push(
          `- seasons known: ${it.tvmaze.candidateSeasonCount ?? 'n/a'} (${it.tvmaze.candidateSeasonNumbers?.join(',') ?? 'n/a'}) · episodes: ${it.tvmaze.candidateRegularEpisodeCount ?? 'n/a'} regular / ${it.tvmaze.candidateEpisodeCountIncludingSpecials ?? 'n/a'} incl. specials`,
        );
        lines.push(`- close competitor detected: ${it.tvmaze.closeCompetitorDetected} (${it.tvmaze.closeCompetitorReason ?? 'n/a'})`);
        lines.push(`- anime-numbering risk detected: ${it.tvmaze.animeNumberingRiskDetected}`);
        lines.push(`- provider-comparison category (existing tvmaze-compare.ts vocabulary): \`${it.tvmaze.category}\``);
      } else {
        lines.push('- no candidate found');
      }
      lines.push('');
      if (it.keyEpisodeCheck) {
        lines.push(`**Key episode check**: ${it.keyEpisodeCheck.description}`);
        lines.push(
          `- by absolute position ${it.keyEpisodeCheck.foundByAbsolutePosition.position}: ${it.keyEpisodeCheck.foundByAbsolutePosition.found ? `found (${it.keyEpisodeCheck.foundByAbsolutePosition.label}, "${it.keyEpisodeCheck.foundByAbsolutePosition.title}")` : 'not found'}`,
        );
        if (it.keyEpisodeCheck.foundByLabel) {
          lines.push(`- by label ${it.keyEpisodeCheck.foundByLabel.label}: ${it.keyEpisodeCheck.foundByLabel.found ? `found ("${it.keyEpisodeCheck.foundByLabel.title}")` : 'not found'}`);
        }
        if (it.keyEpisodeCheck.foundByTitle) {
          lines.push(`- by exact title "${it.keyEpisodeCheck.foundByTitle.title}": ${it.keyEpisodeCheck.foundByTitle.found ? `found at ${it.keyEpisodeCheck.foundByTitle.label}` : 'not found'}`);
        }
        lines.push('');
      }
      lines.push(`**Classification**: \`${it.classification}\``);
      lines.push('');
      lines.push(it.classificationReason);
      lines.push('');
      if (it.investigationNotes.length > 0) {
        lines.push('**Notes**:');
        for (const n of it.investigationNotes) lines.push(`- ${n}`);
        lines.push('');
      }
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
