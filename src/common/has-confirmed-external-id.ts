// Whether a series has ANY confirmed provider match — the one canonical
// definition, reused by SeriesService.getDetail (which used to inline this
// check) and by the Needs Attention feature (needs-attention-logic.ts).
// A series can have an ExternalIds row and still count as unconfirmed here
// if every actual id field is null (e.g. a row created only to record
// matchSource/matchConfidence metadata without ever landing a real id).
export interface ExternalIdsForConfirmationCheck {
  tmdbId: string | null;
  traktId: string | null;
  imdbId: string | null;
}

export function hasConfirmedExternalId(externalIds: ExternalIdsForConfirmationCheck | null): boolean {
  if (!externalIds) return false;
  return !!(externalIds.tmdbId || externalIds.traktId || externalIds.imdbId);
}
