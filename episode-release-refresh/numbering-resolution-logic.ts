// Pure logic for Phase 4 of the episode-identity architecture work
// (docs/episode-numbering-and-season-shift-risk.md): resolves display
// numbering for a genuinely new provider episode (one compareSeriesCatalog
// already determined has no local counterpart, by identity or by
// season/episode key) BEFORE it reaches buildEpisodeInsertPlan.
//
// Deliberately a separate step, not folded into compareSeriesCatalog or
// buildEpisodeInsertPlan themselves — both stay exactly as they were for
// Phases 1-3, zero regression risk to already-deployed, already-tested
// behavior. This step only ever narrows or relabels compareSeriesCatalog's
// own `newEpisodes`/`providerEpisodes` output; it never widens it.
//
// Three-way decision per new episode:
// 1. Its provider season number already matches a KNOWN LOCAL season ->
//    pass through completely unchanged (the overwhelming common case: a
//    new episode of an already-tracked season).
// 2. Its provider season number is new, AND this series has never needed
//    numbering supervision (zero SeriesNumberingMapping rows) -> pass
//    through completely unchanged too. Trusting the provider's own season
//    number directly for a brand-new season is exactly the pre-Phase-4
//    behavior, correct for the vast majority of shows.
// 3. Its provider season number is new, AND this series DOES have at least
//    one confirmed mapping (it's already known to need supervision):
//    - A mapping's range covers this episode -> relabel it to the
//      resolved local season/episode and let it proceed to insertion
//      normally, like case 1/2.
//    - No mapping covers it -> pull it out entirely; the caller stores it
//      as a PendingProviderEpisode instead of inserting it. Never guessed.

import { NewEpisodeFound, ProviderEpisodeInput } from './refresh-logic';

export interface NumberingMappingInput {
  providerSeasonNumber: number;
  providerEpisodeStart: number;
  providerEpisodeEnd: number | null;
  localSeasonNumber: number;
  localEpisodeOffset: number;
}

export interface PendingEpisodeCandidate {
  tmdbEpisodeId: number;
  providerSeasonNumber: number;
  providerEpisodeNumber: number;
  title: string | null;
  overview: string | null;
  airDate: Date | null;
  imageUrl: string | null;
  runtimeMinutes: number | null;
}

export interface NumberingResolutionResult {
  resolvedNewEpisodes: NewEpisodeFound[];
  resolvedProviderEpisodes: ProviderEpisodeInput[];
  pending: PendingEpisodeCandidate[];
  // Non-fatal notice: a "new" episode had no tmdbEpisodeId at all (should
  // not happen for a live TMDb fetch post-Phase-1, but if it ever does,
  // there is nothing stable to hold a pending row against) — falls back to
  // trusting the provider's own numbering directly rather than losing the
  // episode, and is reported here so it's never a silent gap.
  warnings: string[];
}

function episodeKey(seasonNumber: number, episodeNumber: number): string {
  return `${seasonNumber}:${episodeNumber}`;
}

export function resolveEpisodeNumbering(input: {
  newEpisodes: NewEpisodeFound[];
  providerEpisodes: ProviderEpisodeInput[];
  mappings: NumberingMappingInput[];
}): NumberingResolutionResult {
  // Deliberately NOT gated on "does this episode's provider season number
  // already match a known local season" -- that assumption is exactly what
  // breaks down once a series needs supervision at all (a supervised show,
  // by definition, has some provider/local numbering divergence, so
  // "provider season == local season" is no longer safe to assume on its
  // own). The ONLY fast path is "this series has never needed supervision"
  // (zero mapping rows) -- once it has even one, every new episode is
  // resolved strictly through the mapping table, never through a
  // season-number coincidence.
  const seriesHasMappings = input.mappings.length > 0;
  const providerByKey = new Map<string, ProviderEpisodeInput>();
  for (const p of input.providerEpisodes) providerByKey.set(episodeKey(p.seasonNumber, p.episodeNumber), p);

  const resolvedNewEpisodes: NewEpisodeFound[] = [];
  const resolvedProviderEpisodes: ProviderEpisodeInput[] = [...input.providerEpisodes];
  const pending: PendingEpisodeCandidate[] = [];
  const warnings: string[] = [];

  for (const ep of input.newEpisodes) {
    if (!seriesHasMappings) {
      resolvedNewEpisodes.push(ep);
      continue;
    }

    const mapping = input.mappings.find(
      (m) => m.providerSeasonNumber === ep.seasonNumber && ep.episodeNumber >= m.providerEpisodeStart && (m.providerEpisodeEnd === null || ep.episodeNumber <= m.providerEpisodeEnd),
    );

    if (mapping) {
      const resolvedSeasonNumber = mapping.localSeasonNumber;
      const resolvedEpisodeNumber = ep.episodeNumber - mapping.localEpisodeOffset;
      resolvedNewEpisodes.push({ ...ep, seasonNumber: resolvedSeasonNumber, episodeNumber: resolvedEpisodeNumber });
      const full = providerByKey.get(episodeKey(ep.seasonNumber, ep.episodeNumber));
      if (full) resolvedProviderEpisodes.push({ ...full, seasonNumber: resolvedSeasonNumber, episodeNumber: resolvedEpisodeNumber });
      continue;
    }

    const full = providerByKey.get(episodeKey(ep.seasonNumber, ep.episodeNumber));
    if (!full || full.tmdbEpisodeId == null) {
      warnings.push(`new episode S${ep.seasonNumber}E${ep.episodeNumber} has no tmdbEpisodeId -- cannot hold it as pending, falling back to the provider's own numbering rather than losing it`);
      resolvedNewEpisodes.push(ep);
      continue;
    }

    pending.push({
      tmdbEpisodeId: full.tmdbEpisodeId,
      providerSeasonNumber: ep.seasonNumber,
      providerEpisodeNumber: ep.episodeNumber,
      title: full.title,
      overview: full.overview,
      airDate: full.airDate,
      imageUrl: full.imageUrl,
      runtimeMinutes: full.runtimeMinutes,
    });
  }

  return { resolvedNewEpisodes, resolvedProviderEpisodes, pending, warnings };
}
