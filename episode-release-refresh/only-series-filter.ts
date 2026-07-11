// Pure logic for --only=<seriesId> scoping. No I/O — takes the already-
// loaded candidate list (from loadCandidateSeries) and narrows it to
// exactly one series, or to nothing at all if the requested id isn't
// present among the candidates.
//
// The one guarantee this file exists to encode and make testable in
// isolation: an unmatched --only id NEVER falls back to the full candidate
// set. The only possible "not found" output is an empty array — never the
// original list. Everything downstream in run-apply-refresh.ts (the
// eligibility loop, the TMDb fetch, compareSeriesCatalog, the apply
// transaction) only ever iterates whatever this function returns, so a
// correct narrowing here is what makes "only the selected series reaches
// provider fetch/planning" and "unrelated eligible series receive zero
// fetches and zero writes" true structurally, not just by convention.

export interface OnlySeriesFilterResult<T extends { id: string }> {
  candidateSeries: T[];
  found: boolean;
}

export function filterToOnlySeries<T extends { id: string }>(allSeries: T[], onlySeriesId: string | undefined): OnlySeriesFilterResult<T> {
  if (onlySeriesId === undefined) {
    return { candidateSeries: allSeries, found: true };
  }
  const match = allSeries.find((s) => s.id === onlySeriesId);
  return { candidateSeries: match ? [match] : [], found: match !== undefined };
}
