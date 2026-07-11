// Pure post-apply verification logic — Phase 7 of the stable-version
// migration policy work. Compares a "before" and "after" snapshot of one
// series against what the batch manifest (batch-manifest-logic.ts) said
// would happen, and reports pass/fail per check rather than a single
// opaque boolean, so a failure is immediately actionable.
//
// No I/O here — snapshot capture (real Prisma reads) lives in
// verification-snapshot.ts. Keeping this pure means every failure mode
// (extra row, missing row, mutated orphan, lost watch, wrong progress...)
// can be exercised directly with constructed fixtures, no database needed.

export interface CapturedEpisodeRow {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  importBatchId: string | null;
}

export interface CapturedSeasonRow {
  seasonNumber: number;
  importBatchId: string | null;
}

export interface CapturedWatchRow {
  episodeId: string;
}

export interface CapturedProgress {
  userStatus: string;
  nextEpisodeId: string | null;
}

export interface SeriesSnapshot {
  seriesId: string;
  episodes: CapturedEpisodeRow[];
  seasons: CapturedSeasonRow[];
  episodeWatches: CapturedWatchRow[];
  progress: CapturedProgress | null;
}

export interface PostApplyExpectation {
  seriesId: string;
  // The provenance marker every row this batch creates must carry — see
  // CATALOG_RECONCILIATION_IMPORT_BATCH_ID in migration-catalog-plan-logic.ts.
  expectedImportBatchId: string;
  expectedNewSeasonNumbers: number[];
  expectedNewEpisodeCount: number;
  // Episode ids that must exist, unchanged, both before and after — the
  // orphan-preservation guarantee (migration-confirmation-logic.ts's
  // write-path invariant) made externally checkable.
  preservedOrphanEpisodeIds: string[];
  expectedUserStatus: string;
  expectedNextEpisodeId: string | null;
}

export type VerificationCheckStatus = 'PASS' | 'FAIL';

export interface VerificationCheck {
  name: string;
  status: VerificationCheckStatus;
  detail: string;
}

export interface SeriesVerificationResult {
  seriesId: string;
  passed: boolean;
  checks: VerificationCheck[];
}

function check(name: string, ok: boolean, detail: string): VerificationCheck {
  return { name, status: ok ? 'PASS' : 'FAIL', detail };
}

function episodeKeyPart(e: { seasonNumber: number; episodeNumber: number }): string {
  return `S${e.seasonNumber}E${e.episodeNumber}`;
}

export function verifySeriesPostApply(before: SeriesSnapshot, after: SeriesSnapshot, expected: PostApplyExpectation): SeriesVerificationResult {
  const beforeEpisodeIds = new Set(before.episodes.map((e) => e.id));
  const afterEpisodeById = new Map(after.episodes.map((e) => [e.id, e]));
  const newEpisodes = after.episodes.filter((e) => !beforeEpisodeIds.has(e.id));

  const checks: VerificationCheck[] = [];

  // --- Catalog writes ---------------------------------------------------

  checks.push(
    check(
      'new-episodes-carry-expected-provenance',
      newEpisodes.every((e) => e.importBatchId === expected.expectedImportBatchId),
      newEpisodes.every((e) => e.importBatchId === expected.expectedImportBatchId)
        ? `all ${newEpisodes.length} new episode(s) tagged \`${expected.expectedImportBatchId}\``
        : `unexpected row(s) with a different or missing importBatchId: ${newEpisodes
            .filter((e) => e.importBatchId !== expected.expectedImportBatchId)
            .map((e) => episodeKeyPart(e))
            .join(', ')}`,
    ),
  );

  checks.push(check('new-episode-count-matches-expected', newEpisodes.length === expected.expectedNewEpisodeCount, `expected ${expected.expectedNewEpisodeCount} new episode(s), found ${newEpisodes.length}`));

  const beforeSeasonNumbers = new Set(before.seasons.map((s) => s.seasonNumber));
  const newSeasonNumbers = after.seasons.filter((s) => !beforeSeasonNumbers.has(s.seasonNumber)).map((s) => s.seasonNumber);
  const expectedSeasonSet = new Set(expected.expectedNewSeasonNumbers);
  const newSeasonSet = new Set(newSeasonNumbers);
  const seasonsMatch = expectedSeasonSet.size === newSeasonSet.size && [...expectedSeasonSet].every((n) => newSeasonSet.has(n));
  checks.push(check('new-seasons-match-expected', seasonsMatch, `expected seasons [${expected.expectedNewSeasonNumbers.join(', ')}], found [${newSeasonNumbers.join(', ')}]`));

  const missingEpisodeIds = before.episodes.filter((e) => !afterEpisodeById.has(e.id));
  checks.push(check('no-episode-deletions', missingEpisodeIds.length === 0, missingEpisodeIds.length === 0 ? 'no prior episode rows disappeared' : `missing episode id(s): ${missingEpisodeIds.map((e) => e.id).join(', ')}`));

  const renumbered = before.episodes.filter((e) => {
    const after1 = afterEpisodeById.get(e.id);
    return after1 !== undefined && (after1.seasonNumber !== e.seasonNumber || after1.episodeNumber !== e.episodeNumber);
  });
  checks.push(check('no-unexpected-renumbering', renumbered.length === 0, renumbered.length === 0 ? 'no existing episode changed season/episode number' : `renumbered episode id(s): ${renumbered.map((e) => e.id).join(', ')}`));

  const mutatedOrphans = expected.preservedOrphanEpisodeIds.filter((id) => {
    const b = before.episodes.find((e) => e.id === id);
    const a = afterEpisodeById.get(id);
    if (!b || !a) return true; // missing entirely is also a mutation/violation
    return b.seasonNumber !== a.seasonNumber || b.episodeNumber !== a.episodeNumber || b.importBatchId !== a.importBatchId;
  });
  checks.push(
    check(
      'preserved-orphans-untouched',
      mutatedOrphans.length === 0,
      mutatedOrphans.length === 0 ? `all ${expected.preservedOrphanEpisodeIds.length} preserved orphan(s) unchanged` : `mutated or missing orphan id(s): ${mutatedOrphans.join(', ')}`,
    ),
  );

  // --- Watch history ------------------------------------------------------

  checks.push(
    check('watch-count-non-decreasing', after.episodeWatches.length >= before.episodeWatches.length, `before: ${before.episodeWatches.length}, after: ${after.episodeWatches.length}`),
  );

  const afterWatchedEpisodeIds = new Set(after.episodeWatches.map((w) => w.episodeId));
  const lostWatches = before.episodeWatches.filter((w) => !afterWatchedEpisodeIds.has(w.episodeId));
  checks.push(check('no-lost-watch-records', lostWatches.length === 0, lostWatches.length === 0 ? 'every prior EpisodeWatch.episodeId still present' : `lost watch(es) for episode id(s): ${lostWatches.map((w) => w.episodeId).join(', ')}`));

  const newEpisodeIds = new Set(newEpisodes.map((e) => e.id));
  const newEpisodesAutoWatched = after.episodeWatches.filter((w) => newEpisodeIds.has(w.episodeId));
  checks.push(
    check(
      'new-episodes-not-auto-watched',
      newEpisodesAutoWatched.length === 0,
      newEpisodesAutoWatched.length === 0 ? 'no newly created episode has a watch record' : `unexpectedly watched new episode id(s): ${newEpisodesAutoWatched.map((w) => w.episodeId).join(', ')}`,
    ),
  );

  // --- User progress --------------------------------------------------------

  const progressStatusMatches = after.progress?.userStatus === expected.expectedUserStatus;
  checks.push(check('progress-status-matches-expected', progressStatusMatches, `expected \`${expected.expectedUserStatus}\`, found \`${after.progress?.userStatus ?? 'none'}\``));

  const progressNextEpisodeMatches = (after.progress?.nextEpisodeId ?? null) === expected.expectedNextEpisodeId;
  checks.push(
    check('progress-next-episode-matches-expected', progressNextEpisodeMatches, `expected \`${expected.expectedNextEpisodeId ?? 'none'}\`, found \`${after.progress?.nextEpisodeId ?? 'none'}\``),
  );

  const passed = checks.every((c) => c.status === 'PASS');
  return { seriesId: expected.seriesId, passed, checks };
}

// --- Scope check: only the manifest's own series were touched -------------

export function verifyBatchScope(touchedSeriesIds: string[], manifestSeriesIds: string[]): VerificationCheck {
  const allowedSet = new Set(manifestSeriesIds);
  const unexpected = touchedSeriesIds.filter((id) => !allowedSet.has(id));
  return check('scope-no-unrelated-series-touched', unexpected.length === 0, unexpected.length === 0 ? `only the ${manifestSeriesIds.length} manifest series were touched` : `unrelated series touched: ${unexpected.join(', ')}`);
}

// --- Classification convergence --------------------------------------------
//
// A migrated title should settle into a stable, ongoing-refresh-eligible
// state. AUTO_REFRESH (which covers NO_CHANGE, FUTURE_ONLY, and
// NEW_RELEASE_AVAILABLE — see episode-release-refresh/refresh-operating-outcome.ts)
// is the only acceptable convergence outcome. Explicitly do NOT require
// NO_CHANGE specifically — a remaining future episode (FUTURE_ONLY) is not
// an error, it's the correct, accurate classification for a series with an
// unaired episode still pending.
export function verifyClassificationConvergence(postApplyOperatingClassification: string): VerificationCheck {
  const ok = postApplyOperatingClassification === 'AUTO_REFRESH';
  return check(
    'post-apply-classification-converges',
    ok,
    ok ? 'post-apply state is AUTO_REFRESH-eligible (covers NO_CHANGE / FUTURE_ONLY / NEW_RELEASE_AVAILABLE)' : `post-apply classification is \`${postApplyOperatingClassification}\`, expected AUTO_REFRESH`,
  );
}

// --- Batch-level aggregation ------------------------------------------------

export interface BatchVerificationResult {
  batchId: string;
  passed: boolean;
  seriesResults: SeriesVerificationResult[];
  scopeCheck: VerificationCheck;
}

export function verifyBatch(batchId: string, seriesResults: SeriesVerificationResult[], scopeCheck: VerificationCheck): BatchVerificationResult {
  const passed = scopeCheck.status === 'PASS' && seriesResults.every((r) => r.passed);
  return { batchId, passed, seriesResults, scopeCheck };
}
