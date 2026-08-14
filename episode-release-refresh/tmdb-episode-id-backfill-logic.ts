// Pure logic for the one-time Episode.tmdbEpisodeId backfill. No I/O.
//
// Context: Phase 1 of the episode-identity architecture work
// (docs/episode-numbering-and-season-shift-risk.md) started capturing
// TMDb's stable per-episode id on every FUTURE Pipeline-B insert, but every
// episode already in the database — including every already-watched one —
// still has tmdbEpisodeId: null. This backfill closes that gap for
// existing rows, per a real-device investigation (Re:Zero) that found a
// series can have genuine duplicate Episode rows for the same real
// broadcast (an actively-synced absolute-numbered season alongside a stale
// legacy per-arc import), with no way to detect that duplication until
// both sides carry the same stable identity.
//
// Matching is deliberately conservative — never a plausible guess, always
// "uncertain -> unresolved" (the user's explicit instruction, safeguards
// #1/#2 in docs/... plan). Two, and only two, match rules are trusted:
//
// 1. Season/episode-key match: the local row's (seasonNumber, episodeNumber)
//    already agrees with a provider episode's (season_number, episode_number).
//    This is the common case — a correctly-numbered row just needs its
//    identity captured. Still cross-checked against airDate when BOTH sides
//    have one non-null, to catch the opposite risk (a season/episode number
//    that coincidentally matches despite being genuinely different content,
//    e.g. after a real renumbering) — a disagreement there is downgraded to
//    ambiguous, never silently trusted.
// 2. Orphan match by exact (airDate, title) equality: for a local row whose
//    (seasonNumber, episodeNumber) has no provider counterpart (the "legacy
//    season" case), matched only when BOTH airDate and title are non-null
//    on the local row, exactly equal a single provider episode's, and that
//    combination isn't shared by more than one provider episode. A local
//    row with a null airDate or title (Re:Zero's own Season 2-4 rows,
//    imported from TV Time with no metadata at all) has no signal to match
//    on and is correctly left unmatched here — resolving that requires the
//    dedicated, individually-reviewed repair (a later phase), not a generic
//    heuristic applied to every series' library.
//
// Any local row a candidate tmdbEpisodeId would collide on (two local rows
// independently resolving to the same provider episode id) is pulled out
// of both match buckets into `collisions` — never written, regardless of
// mode. The caller (run-backfill-tmdb-episode-ids.ts) must refuse to apply
// anything for a series whose plan has any collision or ambiguous entry.

export interface LocalEpisodeForBackfill {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  airDate: Date | null;
}

export interface ProviderEpisodeForBackfill {
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  airDate: Date | null;
  tmdbEpisodeId: number;
}

export interface BackfillMatch {
  localEpisodeId: string;
  localLabel: string;
  tmdbEpisodeId: number;
  matchedOn: 'season-episode-key' | 'air-date-and-title';
}

export interface AmbiguousBackfillEntry {
  localEpisodeId: string;
  localLabel: string;
  reason: string;
  candidateTmdbEpisodeIds: number[];
}

export interface UnmatchedLocalEpisode {
  localEpisodeId: string;
  localLabel: string;
  reason: string;
}

export interface UnmatchedProviderEpisode {
  seasonNumber: number;
  episodeNumber: number;
  tmdbEpisodeId: number;
}

export interface BackfillCollision {
  tmdbEpisodeId: number;
  localEpisodeIds: string[];
  localLabels: string[];
}

export interface SeriesBackfillPlan {
  exactMatches: BackfillMatch[];
  ambiguous: AmbiguousBackfillEntry[];
  unmatchedLocal: UnmatchedLocalEpisode[];
  unmatchedProvider: UnmatchedProviderEpisode[];
  collisions: BackfillCollision[];
}

function label(seasonNumber: number, episodeNumber: number): string {
  return `S${seasonNumber}E${episodeNumber}`;
}

function episodeKey(seasonNumber: number, episodeNumber: number): string {
  return `${seasonNumber}:${episodeNumber}`;
}

function airDateTitleKey(airDate: Date, title: string): string {
  return `${airDate.toISOString()}|${title}`;
}

export function buildEpisodeBackfillPlan(input: { localEpisodes: LocalEpisodeForBackfill[]; providerEpisodes: ProviderEpisodeForBackfill[] }): SeriesBackfillPlan {
  const providerByKey = new Map<string, ProviderEpisodeForBackfill>();
  for (const p of input.providerEpisodes) providerByKey.set(episodeKey(p.seasonNumber, p.episodeNumber), p);

  // Group provider episodes by (airDate, title) so a combination shared by
  // more than one provider episode is never trusted as a unique match.
  const providerByAirDateTitle = new Map<string, ProviderEpisodeForBackfill[]>();
  for (const p of input.providerEpisodes) {
    if (p.airDate == null || p.title == null) continue;
    const k = airDateTitleKey(p.airDate, p.title);
    const list = providerByAirDateTitle.get(k) ?? [];
    list.push(p);
    providerByAirDateTitle.set(k, list);
  }

  const exactMatches: BackfillMatch[] = [];
  const ambiguous: AmbiguousBackfillEntry[] = [];
  const unmatchedLocal: UnmatchedLocalEpisode[] = [];
  const claimedProviderIds = new Set<number>();

  for (const local of input.localEpisodes) {
    const localLabel = label(local.seasonNumber, local.episodeNumber);
    const keyMatch = providerByKey.get(episodeKey(local.seasonNumber, local.episodeNumber));

    if (keyMatch) {
      const airDatesDisagree = local.airDate != null && keyMatch.airDate != null && local.airDate.getTime() !== keyMatch.airDate.getTime();
      if (airDatesDisagree) {
        ambiguous.push({
          localEpisodeId: local.id,
          localLabel,
          reason: `season/episode number matches provider ${localLabel}, but airDate disagrees (local ${local.airDate!.toISOString()} vs. provider ${keyMatch.airDate!.toISOString()}) — not trusted automatically`,
          candidateTmdbEpisodeIds: [keyMatch.tmdbEpisodeId],
        });
        continue;
      }
      exactMatches.push({ localEpisodeId: local.id, localLabel, tmdbEpisodeId: keyMatch.tmdbEpisodeId, matchedOn: 'season-episode-key' });
      claimedProviderIds.add(keyMatch.tmdbEpisodeId);
      continue;
    }

    // No season/episode-key counterpart — the "legacy orphan" case. Only
    // ever matched via an exact, unshared (airDate, title) combination.
    if (local.airDate == null || local.title == null) {
      unmatchedLocal.push({ localEpisodeId: local.id, localLabel, reason: 'no season/episode-key match, and local row has no airDate/title to match on' });
      continue;
    }
    const candidates = providerByAirDateTitle.get(airDateTitleKey(local.airDate, local.title)) ?? [];
    if (candidates.length === 0) {
      unmatchedLocal.push({ localEpisodeId: local.id, localLabel, reason: 'no season/episode-key match, and no provider episode shares this exact airDate+title' });
    } else if (candidates.length > 1) {
      ambiguous.push({
        localEpisodeId: local.id,
        localLabel,
        reason: `no season/episode-key match; ${candidates.length} provider episodes share the same airDate+title — not unique enough to trust automatically`,
        candidateTmdbEpisodeIds: candidates.map((c) => c.tmdbEpisodeId),
      });
    } else {
      exactMatches.push({ localEpisodeId: local.id, localLabel, tmdbEpisodeId: candidates[0].tmdbEpisodeId, matchedOn: 'air-date-and-title' });
      claimedProviderIds.add(candidates[0].tmdbEpisodeId);
    }
  }

  // Collision pass: two local rows independently resolving to the same
  // provider episode id. Pull every implicated row out of exactMatches.
  const matchesByTmdbId = new Map<number, BackfillMatch[]>();
  for (const m of exactMatches) {
    const list = matchesByTmdbId.get(m.tmdbEpisodeId) ?? [];
    list.push(m);
    matchesByTmdbId.set(m.tmdbEpisodeId, list);
  }
  const collisions: BackfillCollision[] = [];
  const collidedTmdbIds = new Set<number>();
  for (const [tmdbEpisodeId, matches] of matchesByTmdbId) {
    if (matches.length <= 1) continue;
    collidedTmdbIds.add(tmdbEpisodeId);
    collisions.push({ tmdbEpisodeId, localEpisodeIds: matches.map((m) => m.localEpisodeId), localLabels: matches.map((m) => m.localLabel) });
  }
  const finalExactMatches = exactMatches.filter((m) => !collidedTmdbIds.has(m.tmdbEpisodeId));

  const unmatchedProvider: UnmatchedProviderEpisode[] = input.providerEpisodes
    .filter((p) => !claimedProviderIds.has(p.tmdbEpisodeId))
    .map((p) => ({ seasonNumber: p.seasonNumber, episodeNumber: p.episodeNumber, tmdbEpisodeId: p.tmdbEpisodeId }));

  return { exactMatches: finalExactMatches, ambiguous, unmatchedLocal, unmatchedProvider, collisions };
}
