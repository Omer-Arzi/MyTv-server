// Whether an episode counts as "out" for the purposes of "next episode to
// watch" — the single place this decision is made, reused by the live
// mark-watched flow (episode-watch.service.ts), the manual status-update
// endpoint (series-query-helpers.ts), and the one-time nextEpisodeId
// backfill (next-episode-backfill/derive-next-episode.ts). Without this,
// each of those three independently computed "next unwatched episode by
// season/episode order" with no awareness of airDate at all — which is
// exactly how a not-yet-aired episode from a full TMDb catalog could end up
// as nextEpisodeId, and from there surface in GET /me/watch-next.
//
// A null airDate is treated as NOT released (conservative): there is no way
// to tell "definitely already aired, TMDb just never recorded the date"
// apart from "not aired yet, no date announced," and treating a null date
// as "ready to watch" risks surfacing an episode that doesn't exist yet.
// Revisit only if a real, confirmed-aired-but-null-airDate episode ever
// turns up — nothing in the current dataset does.
export function isEpisodeReleased(airDate: Date | null, now: Date = new Date()): boolean {
  if (!airDate) return false;
  return airDate.getTime() <= now.getTime();
}
