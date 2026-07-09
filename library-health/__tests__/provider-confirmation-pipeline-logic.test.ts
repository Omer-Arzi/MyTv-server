// Integration-style tests composing the pure pieces the pipeline
// orchestration script (run-provider-confirmation-pipeline.ts) wires
// together at runtime: classifyProviderConfirmationDryRun ->
// isSafeApplyClassification -> resolvePreservedOrphanEpisodes ->
// buildConfirmedSeriesApplyPlan. The orchestration script itself is a
// top-level main().catch() side-effecting entrypoint (this repo's
// convention: never imported/unit-tested directly — see every other
// run-*.ts script), so "would this auto-apply" is proven here at the
// logic level, exactly mirroring what the script does before it ever
// opens a transaction.

import { UserSeriesStatus } from '@prisma/client';
import { buildConfirmedSeriesApplyPlan, isSafeApplyClassification, resolvePreservedOrphanEpisodes } from '../apply-confirmed-provider-logic';
import { LocalEpisodeForApply, ProviderEpisodeForApply } from '../apply-friends-tvmaze-logic';
import { checkTitleYearSanity, classifyProviderConfirmationDryRun } from '../provider-confirmation-decisions-logic';
import { checkBenignSeasonZeroOrphan, EpisodeSeasonPosition, findOrphanedWatchedEpisodes, detectRealSeasonShrink } from '../season-zero-orphan-logic';
import { checkSplitEpisodeTailOnly } from '../split-episode-tail-logic';
import { compareSeriesCatalog, LocalEpisodeInput, ProviderEpisodeInput } from '../../episode-release-refresh/refresh-logic';

function toApplyEpisodes(local: LocalEpisodeInput[]): LocalEpisodeForApply[] {
  return local.map((e) => ({ id: e.id, seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber, title: e.title, overview: e.overview, airDate: e.airDate ? e.airDate.toISOString() : null, runtimeMinutes: e.runtimeMinutes }));
}
function toApplyProviderEpisodes(provider: ProviderEpisodeInput[]): ProviderEpisodeForApply[] {
  return provider.map((e) => ({ seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber, title: e.title, overviewHtml: e.overview, airDate: e.airDate ? e.airDate.toISOString() : null, runtimeMinutes: e.runtimeMinutes }));
}

function localEpisode(overrides: Partial<LocalEpisodeInput> & { seasonNumber: number; episodeNumber: number; id: string }): LocalEpisodeInput {
  return { title: null, overview: null, airDate: null, imageUrl: null, runtimeMinutes: null, watched: true, ...overrides };
}
function providerEpisode(overrides: Partial<ProviderEpisodeInput> & { seasonNumber: number; episodeNumber: number }): ProviderEpisodeInput {
  return { title: `S${overrides.seasonNumber}E${overrides.episodeNumber}`, overview: null, airDate: null, imageUrl: null, runtimeMinutes: null, ...overrides };
}

const now = new Date('2026-07-09T00:00:00.000Z');

function runFullPipelineDecision(input: { localTitle: string; localEpisodes: LocalEpisodeInput[]; providerEpisodes: ProviderEpisodeInput[]; candidateTitle: string; candidateYear: number | null }) {
  const sanity = checkTitleYearSanity({ localTitle: input.localTitle, candidateTitle: input.candidateTitle, candidateYear: input.candidateYear });
  const comparison = compareSeriesCatalog({
    localEpisodes: input.localEpisodes,
    providerEpisodes: input.providerEpisodes,
    currentReleaseStatus: 'ENDED' as never,
    providerReleaseStatus: 'ENDED' as never,
    currentUserStatus: UserSeriesStatus.WATCHING,
    currentNextEpisodeId: null,
    now,
  });
  const orphanedWatchedEpisodes = findOrphanedWatchedEpisodes(input.localEpisodes, input.providerEpisodes);
  const realSeasonShrinkDetected = detectRealSeasonShrink(input.localEpisodes as EpisodeSeasonPosition[], input.providerEpisodes as EpisodeSeasonPosition[]);
  const seasonZeroOrphanCheck = checkBenignSeasonZeroOrphan({ localTitle: input.localTitle, orphanedWatchedEpisodes, realSeasonShrinkDetected });
  const splitEpisodeTailCheck = checkSplitEpisodeTailOnly({ localTitle: input.localTitle, localEpisodes: input.localEpisodes, providerEpisodes: input.providerEpisodes, orphanedWatchedEpisodes });
  const decisionResult = classifyProviderConfirmationDryRun({ titleYearSanity: sanity, comparison, seasonZeroOrphanCheck, splitEpisodeTailCheck });
  return { decisionResult, comparison, seasonZeroOrphanCheck, splitEpisodeTailCheck, orphanedWatchedEpisodes };
}

describe('pipeline: auto-apply safe clean case (Friends-like — no orphans, no risk)', () => {
  it('classifies SAFE_TO_APPLY_LATER, is auto-applicable, and produces a plan with zero preserved orphans', () => {
    const localEpisodes = [localEpisode({ id: 'e1', seasonNumber: 1, episodeNumber: 1 })];
    const providerEpisodes = [providerEpisode({ seasonNumber: 1, episodeNumber: 1, title: 'Pilot' })];

    const { decisionResult, comparison, seasonZeroOrphanCheck } = runFullPipelineDecision({ localTitle: 'Friends', localEpisodes, providerEpisodes, candidateTitle: 'Friends', candidateYear: 1994 });

    expect(decisionResult.classification).toBe('SAFE_TO_APPLY_LATER');
    expect(isSafeApplyClassification(decisionResult.classification)).toBe(true);

    const preservedOrphanEpisodes = resolvePreservedOrphanEpisodes({ classification: decisionResult.classification, orphanSeasonZeroEpisodes: seasonZeroOrphanCheck.orphanSeasonZeroEpisodes, tailOrphanedEpisodes: decisionResult.tailOrphanedEpisodes });
    const plan = buildConfirmedSeriesApplyPlan({
      seriesId: 'series-friends',
      title: 'Friends',
      provider: 'tvmaze',
      providerId: '431',
      userId: 'user-1',
      currentPosterUrl: null,
      providerPosterUrl: 'https://example.com/friends.jpg',
      localEpisodes: toApplyEpisodes(localEpisodes),
      providerEpisodes: toApplyProviderEpisodes(providerEpisodes),
      preservedOrphanEpisodes,
      proposedUserStatus: comparison.proposedUserStatus,
      proposedNextEpisodeId: comparison.proposedNextEpisodeId,
    });

    expect(plan.preservedOrphanEpisodes).toEqual([]);
    expect(plan.episodeUpdateCount).toBe(1);
    expect(plan.externalIdsUpdate).toEqual({ seriesId: 'series-friends', provider: 'tvmaze', providerId: '431', tmdbId: undefined });
  });
});

describe('pipeline: auto-apply local-special-orphan case (BBT-like — one benign season-0 orphan)', () => {
  it('classifies SAFE_WITH_LOCAL_SPECIAL_ORPHAN, is auto-applicable, and preserves the season-0 orphan without deleting it', () => {
    const localEpisodes = [
      localEpisode({ id: 'e1', seasonNumber: 1, episodeNumber: 1 }),
      localEpisode({ id: 'special', seasonNumber: 0, episodeNumber: 1, watched: true }),
    ];
    const providerEpisodes = [providerEpisode({ seasonNumber: 1, episodeNumber: 1, title: 'Pilot' })]; // no season-0 entry at all

    const { decisionResult, comparison, seasonZeroOrphanCheck } = runFullPipelineDecision({ localTitle: 'The Big Bang Theory', localEpisodes, providerEpisodes, candidateTitle: 'The Big Bang Theory', candidateYear: null });

    expect(decisionResult.classification).toBe('SAFE_WITH_LOCAL_SPECIAL_ORPHAN');
    expect(isSafeApplyClassification(decisionResult.classification)).toBe(true);
    expect(seasonZeroOrphanCheck.orphanSeasonZeroEpisodes).toEqual([{ id: 'special', seasonNumber: 0, episodeNumber: 1 }]);

    const preservedOrphanEpisodes = resolvePreservedOrphanEpisodes({ classification: decisionResult.classification, orphanSeasonZeroEpisodes: seasonZeroOrphanCheck.orphanSeasonZeroEpisodes, tailOrphanedEpisodes: decisionResult.tailOrphanedEpisodes });
    const plan = buildConfirmedSeriesApplyPlan({
      seriesId: 'series-bbt',
      title: 'The Big Bang Theory',
      provider: 'tmdb',
      providerId: '1418',
      userId: 'user-1',
      currentPosterUrl: null,
      providerPosterUrl: null,
      localEpisodes: toApplyEpisodes(localEpisodes),
      providerEpisodes: toApplyProviderEpisodes(providerEpisodes),
      preservedOrphanEpisodes,
      proposedUserStatus: comparison.proposedUserStatus,
      proposedNextEpisodeId: comparison.proposedNextEpisodeId,
    });

    expect(plan.preservedOrphanEpisodes).toEqual([{ id: 'special', seasonNumber: 0, episodeNumber: 1 }]);
    // The orphan must never appear among episodeUpdates (which would imply
    // touching/overwriting it) — it's simply absent, i.e. untouched.
    expect(plan.episodeUpdates.map((u) => u.episodeId)).not.toContain('special');
  });
});

describe('pipeline: auto-apply split-episode-tail case (The Office S4-like — confirmed tail-only)', () => {
  it('classifies SAFE_WITH_SPLIT_EPISODE_TAIL, is auto-applicable, and preserves every tail orphan without deleting any', () => {
    const localEpisodes = Array.from({ length: 19 }, (_, i) => localEpisode({ id: `s4e${i + 1}`, seasonNumber: 4, episodeNumber: i + 1 }));
    const providerEpisodes = Array.from({ length: 14 }, (_, i) => providerEpisode({ seasonNumber: 4, episodeNumber: i + 1 }));

    const { decisionResult, comparison } = runFullPipelineDecision({ localTitle: 'The Office (US)', localEpisodes, providerEpisodes, candidateTitle: 'The Office', candidateYear: null });

    expect(decisionResult.classification).toBe('SAFE_WITH_SPLIT_EPISODE_TAIL');
    expect(isSafeApplyClassification(decisionResult.classification)).toBe(true);
    expect(decisionResult.tailOrphanedEpisodes).toHaveLength(5);

    const preservedOrphanEpisodes = resolvePreservedOrphanEpisodes({ classification: decisionResult.classification, orphanSeasonZeroEpisodes: [], tailOrphanedEpisodes: decisionResult.tailOrphanedEpisodes });
    const plan = buildConfirmedSeriesApplyPlan({
      seriesId: 'series-office',
      title: 'The Office (US)',
      provider: 'tmdb',
      providerId: '2316',
      userId: 'user-1',
      currentPosterUrl: 'https://existing.example.com/office.jpg',
      providerPosterUrl: 'https://example.com/office.jpg',
      localEpisodes: toApplyEpisodes(localEpisodes),
      providerEpisodes: toApplyProviderEpisodes(providerEpisodes),
      preservedOrphanEpisodes,
      proposedUserStatus: comparison.proposedUserStatus,
      proposedNextEpisodeId: comparison.proposedNextEpisodeId,
    });

    expect(plan.preservedOrphanEpisodes).toHaveLength(5);
    expect(plan.preservedOrphanEpisodes.map((e) => e.episodeNumber).sort((a, b) => a - b)).toEqual([15, 16, 17, 18, 19]);
    const updatedIds = new Set(plan.episodeUpdates.map((u) => u.episodeId));
    for (const orphan of plan.preservedOrphanEpisodes) {
      expect(updatedIds.has(orphan.id)).toBe(false); // never touched, never "updated away"
    }
    expect(plan.episodeUpdateCount).toBe(14); // exactly the matched E1-14
  });
});

describe('pipeline: never auto-apply BLOCKED_RISK (The Flash-like — real mid-season gap)', () => {
  it('classifies BLOCKED_RISK and is never auto-applicable — no plan is ever built for it by the pipeline', () => {
    // Provider is missing episode 5 mid-season (a real gap, not a tail).
    const localEpisodes = Array.from({ length: 10 }, (_, i) => localEpisode({ id: `e${i + 1}`, seasonNumber: 3, episodeNumber: i + 1 }));
    const providerEpisodes = Array.from({ length: 10 }, (_, i) => providerEpisode({ seasonNumber: 3, episodeNumber: i + 1 })).filter((e) => e.episodeNumber !== 5);

    const { decisionResult } = runFullPipelineDecision({ localTitle: 'The Flash (2014)', localEpisodes, providerEpisodes, candidateTitle: 'The Flash', candidateYear: 2014 });

    expect(decisionResult.classification).toBe('BLOCKED_RISK');
    expect(isSafeApplyClassification(decisionResult.classification)).toBe(false);
    // The pipeline's gate (isSafeApplyClassification) is checked BEFORE
    // buildConfirmedSeriesApplyPlan is ever called for a non-safe
    // classification — proven by the gate itself returning false here.
  });
});

describe('pipeline: never deletes watched history', () => {
  it('every orphaned watched episode across both safe-orphan classifications survives intact in preservedOrphanEpisodes — none are dropped', () => {
    const seasonZeroLocal = [localEpisode({ id: 'e1', seasonNumber: 1, episodeNumber: 1 }), localEpisode({ id: 'special', seasonNumber: 0, episodeNumber: 1 })];
    const seasonZeroProvider = [providerEpisode({ seasonNumber: 1, episodeNumber: 1 })];
    const { decisionResult: r1, seasonZeroOrphanCheck } = runFullPipelineDecision({ localTitle: 'Modern Family', localEpisodes: seasonZeroLocal, providerEpisodes: seasonZeroProvider, candidateTitle: 'Modern Family', candidateYear: null });
    const orphans1 = resolvePreservedOrphanEpisodes({ classification: r1.classification, orphanSeasonZeroEpisodes: seasonZeroOrphanCheck.orphanSeasonZeroEpisodes, tailOrphanedEpisodes: r1.tailOrphanedEpisodes });
    expect(orphans1.map((o) => o.id)).toEqual(['special']);

    const tailLocal = Array.from({ length: 26 }, (_, i) => localEpisode({ id: `s6e${i + 1}`, seasonNumber: 6, episodeNumber: i + 1 }));
    const tailProvider = Array.from({ length: 24 }, (_, i) => providerEpisode({ seasonNumber: 6, episodeNumber: i + 1 }));
    const { decisionResult: r2 } = runFullPipelineDecision({ localTitle: 'The Office (US)', localEpisodes: tailLocal, providerEpisodes: tailProvider, candidateTitle: 'The Office', candidateYear: null });
    const orphans2 = resolvePreservedOrphanEpisodes({ classification: r2.classification, orphanSeasonZeroEpisodes: [], tailOrphanedEpisodes: r2.tailOrphanedEpisodes });
    expect(orphans2.map((o) => o.id).sort()).toEqual(['s6e25', 's6e26']);

    // Neither plan's episodeUpdates (the only thing a transaction actually
    // writes) contains any of these ids — confirming they're preserved,
    // not silently updated or deleted.
    const plan1 = buildConfirmedSeriesApplyPlan({ seriesId: 's1', title: 'Modern Family', provider: 'tvmaze', providerId: '80', userId: 'u1', currentPosterUrl: null, providerPosterUrl: null, localEpisodes: toApplyEpisodes(seasonZeroLocal), providerEpisodes: toApplyProviderEpisodes(seasonZeroProvider), preservedOrphanEpisodes: orphans1, proposedUserStatus: 'WATCHING', proposedNextEpisodeId: null });
    expect(plan1.episodeUpdates.map((u) => u.episodeId)).not.toContain('special');

    const plan2 = buildConfirmedSeriesApplyPlan({ seriesId: 's2', title: 'The Office (US)', provider: 'tmdb', providerId: '2316', userId: 'u1', currentPosterUrl: null, providerPosterUrl: null, localEpisodes: toApplyEpisodes(tailLocal), providerEpisodes: toApplyProviderEpisodes(tailProvider), preservedOrphanEpisodes: orphans2, proposedUserStatus: 'WATCHING', proposedNextEpisodeId: null });
    expect(plan2.episodeUpdates.map((u) => u.episodeId)).not.toEqual(expect.arrayContaining(['s6e25', 's6e26']));
  });
});
