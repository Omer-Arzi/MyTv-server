// Pure, read-only decision logic for the released-episode Watch Next audit
// (watch-next-audit/run-released-episode-audit.ts —
// docs/watch-next-released-episode-semantics-todo.md Phase 8). No Prisma
// calls, no I/O. Reuses the project's one canonical released predicate
// (isEpisodeReleased) — no separate release-date rule here.
//
// Distinct from audit-logic.ts's categories (title/season-numbering-
// confidence concerns) — this audit is specifically about the "released
// episodes only" contract: is the stored main episode actually released,
// does it match what the current local catalog says the first released
// unwatched episode should be, and does the additional-episodes count
// leak future episodes.

import { isEpisodeReleased } from '../src/common/is-episode-released';

export interface AuditEpisode {
  id: string;
  airDate: Date | null;
  watched: boolean;
}

export type WatchNextReleaseAuditGroup =
  | 'correct'
  | 'future-main-episode-exposed'
  | 'future-episodes-in-queue'
  | 'additional-count-includes-future'
  | 'stale-progress-requiring-reconciliation'
  | 'ambiguous-manual-review';

export interface WatchNextReleaseAuditInput {
  seriesId: string;
  seriesTitle: string;
  storedNextEpisodeId: string | null;
  // Every episode in the series, already sorted (seasonNumber,
  // episodeNumber) ascending — same ordering contract as
  // findFirstUnwatchedEpisodeId.
  orderedEpisodes: AuditEpisode[];
  now?: Date;
}

export interface WatchNextReleaseAuditResult {
  seriesId: string;
  seriesTitle: string;
  storedMainEpisodeId: string | null;
  // null when there is no stored main episode, or the stored id doesn't
  // resolve to a real row in the given catalog (ambiguous — see group).
  storedMainEpisodeReleased: boolean | null;
  computedFirstReleasedUnwatchedEpisodeId: string | null;
  totalUnwatchedCatalogEpisodes: number;
  releasedUnwatchedEpisodeCount: number;
  futureUnwatchedEpisodeCount: number;
  // What the pre-fix formula (raw catalog position, no release/watched
  // filter) would have displayed — for audit visibility only, never
  // reused by any live code path.
  legacyAdditionalCount: number | null;
  // What the fixed formula (docs/watch-next-released-episode-semantics-todo.md
  // Phase 3) actually returns.
  correctedAdditionalCount: number | null;
  group: WatchNextReleaseAuditGroup;
  reason: string;
}

export function auditWatchNextSeries(input: WatchNextReleaseAuditInput): WatchNextReleaseAuditResult {
  const now = input.now ?? new Date();
  const ordered = input.orderedEpisodes;

  const releasedUnwatched = ordered.filter((e) => !e.watched && isEpisodeReleased(e.airDate, now));
  const totalUnwatched = ordered.filter((e) => !e.watched).length;
  const computedFirstReleasedUnwatchedEpisodeId = releasedUnwatched[0]?.id ?? null;

  const storedIndex = input.storedNextEpisodeId ? ordered.findIndex((e) => e.id === input.storedNextEpisodeId) : -1;
  const storedFoundButMissing = input.storedNextEpisodeId !== null && storedIndex === -1;
  const storedMainEpisodeReleased = storedIndex === -1 ? null : isEpisodeReleased(ordered[storedIndex].airDate, now);

  const legacyAdditionalCount = storedIndex === -1 ? null : ordered.length - storedIndex - 1;
  const correctedAdditionalCount =
    storedIndex === -1 ? null : ordered.slice(storedIndex + 1).filter((e) => !e.watched && isEpisodeReleased(e.airDate, now)).length;

  const base = {
    seriesId: input.seriesId,
    seriesTitle: input.seriesTitle,
    storedMainEpisodeId: input.storedNextEpisodeId,
    storedMainEpisodeReleased,
    computedFirstReleasedUnwatchedEpisodeId,
    totalUnwatchedCatalogEpisodes: totalUnwatched,
    releasedUnwatchedEpisodeCount: releasedUnwatched.length,
    futureUnwatchedEpisodeCount: totalUnwatched - releasedUnwatched.length,
    legacyAdditionalCount,
    correctedAdditionalCount,
  };

  if (storedFoundButMissing) {
    return { ...base, group: 'ambiguous-manual-review', reason: 'stored nextEpisodeId does not correspond to any episode in the current local catalog' };
  }

  if (storedMainEpisodeReleased === false) {
    return { ...base, group: 'future-main-episode-exposed', reason: 'the stored main episode has a future (or unknown) airDate — Watch Next would show it as watchable, which it is not' };
  }

  if (input.storedNextEpisodeId !== computedFirstReleasedUnwatchedEpisodeId) {
    return {
      ...base,
      group: 'stale-progress-requiring-reconciliation',
      reason: `stored main episode (${input.storedNextEpisodeId ?? 'null'}) does not match the first released, unwatched episode currently computable from local data (${computedFirstReleasedUnwatchedEpisodeId ?? 'null'}) — run progress reconciliation`,
    };
  }

  // No separate episode "queue" is exposed by this app beyond the +N count
  // itself (confirmed in Phase 1 — WatchNextCard has no carousel/multi-
  // episode navigation), so "future episodes in queue" and "additional
  // count includes future" are the same real-world condition here; both
  // categories are reported for literal alignment with the task's
  // requested groups, but will always coincide in this app's current
  // architecture — documented rather than forced into an artificial split.
  if (legacyAdditionalCount !== null && correctedAdditionalCount !== null && legacyAdditionalCount > correctedAdditionalCount) {
    return {
      ...base,
      group: 'additional-count-includes-future',
      reason: `pre-fix formula would show +${legacyAdditionalCount}, correct value is ${correctedAdditionalCount} — the difference is future and/or already-watched episodes sitting after the main episode in catalog order`,
    };
  }

  return { ...base, group: 'correct', reason: 'stored main episode is released and matches the first released unwatched episode; additional count already correct' };
}
