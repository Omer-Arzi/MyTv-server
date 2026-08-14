// Pure logic for Phase 5 of the episode-identity architecture work: given a
// newly-confirmed SeriesNumberingMapping and the series' current
// PendingProviderEpisode rows, determines which pending episodes that
// mapping resolves and what their real display season/episode number
// becomes. No I/O — the caller (MigrationWorkbenchService.createNumberingMapping)
// does the actual Episode/Season creation and pending-row deletion inside a
// transaction, reusing season-episode-writer.ts's already-tested write
// path, never a second insert implementation.

export interface PendingEpisodeForPromotion {
  id: string;
  tmdbEpisodeId: number;
  providerSeasonNumber: number;
  providerEpisodeNumber: number;
  title: string | null;
  overview: string | null;
  airDate: Date | null;
  imageUrl: string | null;
  runtimeMinutes: number | null;
}

export interface NewMappingInput {
  providerSeasonNumber: number;
  providerEpisodeStart: number;
  providerEpisodeEnd: number | null;
  localSeasonNumber: number;
  localEpisodeOffset: number;
}

export interface PromotedEpisode {
  pendingId: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  overview: string | null;
  airDate: Date | null;
  imageUrl: string | null;
  runtimeMinutes: number | null;
  tmdbEpisodeId: number;
}

export function findPendingEpisodesCoveredByMapping(pending: PendingEpisodeForPromotion[], mapping: NewMappingInput): PromotedEpisode[] {
  return pending
    .filter(
      (p) =>
        p.providerSeasonNumber === mapping.providerSeasonNumber &&
        p.providerEpisodeNumber >= mapping.providerEpisodeStart &&
        (mapping.providerEpisodeEnd === null || p.providerEpisodeNumber <= mapping.providerEpisodeEnd),
    )
    .map((p) => ({
      pendingId: p.id,
      seasonNumber: mapping.localSeasonNumber,
      episodeNumber: p.providerEpisodeNumber - mapping.localEpisodeOffset,
      title: p.title,
      overview: p.overview,
      airDate: p.airDate,
      imageUrl: p.imageUrl,
      runtimeMinutes: p.runtimeMinutes,
      tmdbEpisodeId: p.tmdbEpisodeId,
    }));
}
