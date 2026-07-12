// Pure local-library matching logic — no Prisma, no provider calls. Given
// one external search candidate and a pre-loaded snapshot of the user's
// whole library, decides which of the three SearchResultLibraryMatch shapes
// applies. Reuses this codebase's existing canonical identity primitives
// (checkTitleYearSanity, classifyIdentityConfidence, titleSimilarity,
// classifySeriesForAttention) rather than inventing a second matching
// algorithm — same "reuse, don't rebuild" posture as
// search-provider-candidates-for-series.ts's own doc comment.
//
// Matching priority, checked in order, for one candidate:
//   1. Strong-ID match — a library series whose confirmed ExternalIds
//      already carries this exact (provider, providerId). Always EXACT.
//      needsAttention here can still be true (e.g. the identity is
//      confirmed but the title is on the known episode-numbering/
//      season-shift risk list) — identity confirmation and structural
//      trust are independent questions, see classifySeriesForAttention.
//   2. Fuzzy-title match against a library series with NO confirmed
//      identity yet — this is exactly the Migration Workbench's "Needs
//      Attention" population (see the architecture audit: no dedicated
//      needsAttention column exists, hasConfirmedProviderMatch === false
//      IS the signal). A HIGH_CONFIDENCE title match is treated as EXACT
//      (needsAttention: true, primaryAction REVIEW_SERIES) — confident
//      enough that this clearly IS that local series, just not yet
//      identity-confirmed; BORDERLINE is treated as POSSIBLE instead
//      (too uncertain to claim it's definitely the same series).
//   3. Fuzzy-title match against a library series that DOES already have a
//      confirmed identity, but under a DIFFERENT provider/providerId than
//      this candidate — never silently treated as EXACT (a true EXACT
//      would have already been caught by step 1). Always POSSIBLE:
//      title similarity alone is not proof this isn't a same-titled
//      reboot/remake/different-year show, per this feature's explicit
//      "title similarity alone is not identity proof" constraint.
//   4. No library series clears even the BORDERLINE floor — NONE, a
//      genuinely new series.

import { UserSeriesStatus } from '@prisma/client';
import { checkTitleYearSanity } from '../../../library-health/provider-confirmation-decisions-logic';
import { classifyIdentityConfidence } from '../../../library-health/migration-policy-logic';
import { extractTitleYearHint, normalizeTitle, titleSimilarity } from '../../../trakt-enrichment/scoring';
import { classifySeriesForAttention } from '../../common/classify-series-for-attention';
import { FanoutCandidate } from './search-provider-fanout';
import { SearchResultLibraryMatch, SearchResultNextEpisode } from './search-types';

export interface LibrarySnapshotEntry {
  seriesId: string;
  title: string;
  userStatus: UserSeriesStatus;
  tmdbId: string | null;
  provider: string | null;
  providerId: string | null;
  hasConfirmedProviderMatch: boolean;
  nextEpisode: SearchResultNextEpisode | null;
}

// Cheap prefilter before running full Levenshtein similarity — bounds the
// N×M cost of comparing every search candidate against the whole library.
// Deliberately simple (no new DB extension/index — see the approved UX
// planning decision): catches a shared normalized-title prefix or a
// substring relationship either direction, which covers the common cases
// (subtitle differences, minor typos, truncation) at the cost of missing
// genuinely dissimilar-looking aliases — an accepted v1 tradeoff.
const PREFILTER_PREFIX_LENGTH = 3;

function passesCheapPrefilter(localTitle: string, candidateTitle: string): boolean {
  const a = normalizeTitle(localTitle);
  const b = normalizeTitle(candidateTitle);
  if (a.length === 0 || b.length === 0) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const prefixLen = Math.min(PREFILTER_PREFIX_LENGTH, a.length, b.length);
  return a.slice(0, prefixLen) === b.slice(0, prefixLen);
}

function findStrongIdMatch(candidate: FanoutCandidate, library: LibrarySnapshotEntry[]): LibrarySnapshotEntry | null {
  if (candidate.provider === 'tmdb') {
    return library.find((e) => e.tmdbId === candidate.providerId) ?? null;
  }
  return library.find((e) => e.provider === candidate.provider && e.providerId === candidate.providerId) ?? null;
}

interface FuzzyMatch {
  entry: LibrarySnapshotEntry;
  confidence: number;
  band: ReturnType<typeof classifyIdentityConfidence>;
  reason: string;
  yearDiff: number;
}

// When two local entries tie on title similarity (e.g. the same bare title,
// one carrying an explicit "(YYYY)" disambiguation suffix and one not —
// same-title/different-year shows sharing a library), the one whose year is
// actually closer to the candidate's wins, never just whichever happened to
// be iterated first. Matches this feature's ranking logic's own "prefer
// year-compatible matches" tie-break rule (search-ranking-logic.ts).
function findBestFuzzyMatch(candidate: FanoutCandidate, library: LibrarySnapshotEntry[]): FuzzyMatch | null {
  let best: FuzzyMatch | null = null;

  for (const entry of library) {
    if (!passesCheapPrefilter(entry.title, candidate.title)) continue;

    const hint = extractTitleYearHint(entry.title);
    const similarity = titleSimilarity(hint.bareTitle, candidate.title);
    const sanity = checkTitleYearSanity({ localTitle: entry.title, candidateTitle: candidate.title, candidateYear: candidate.year });
    const band = classifyIdentityConfidence({ titleYearSanityPassed: sanity.passed, similarity });
    if (band === 'FAILED') continue;

    const yearDiff = hint.titleYear !== null && candidate.year !== null ? Math.abs(hint.titleYear - candidate.year) : Infinity;

    const isBetter = !best || similarity > best.confidence || (similarity === best.confidence && yearDiff < best.yearDiff);
    if (isBetter) {
      best = { entry, confidence: similarity, band, reason: sanity.reason, yearDiff };
    }
  }

  return best;
}

export function matchCandidateAgainstLibrary(candidate: FanoutCandidate, library: LibrarySnapshotEntry[]): SearchResultLibraryMatch {
  const strong = findStrongIdMatch(candidate, library);
  if (strong) {
    const classification = classifySeriesForAttention({ title: strong.title, hasConfirmedProviderMatch: strong.hasConfirmedProviderMatch });
    return {
      type: 'EXACT',
      seriesId: strong.seriesId,
      userStatus: strong.userStatus,
      nextEpisode: strong.nextEpisode,
      needsAttention: classification !== null,
      attentionReasonCode: classification?.reasonCode ?? null,
    };
  }

  const fuzzy = findBestFuzzyMatch(candidate, library);
  if (!fuzzy) return { type: 'NONE' };

  if (fuzzy.band === 'HIGH_CONFIDENCE' && !fuzzy.entry.hasConfirmedProviderMatch) {
    const classification = classifySeriesForAttention({ title: fuzzy.entry.title, hasConfirmedProviderMatch: false });
    return {
      type: 'EXACT',
      seriesId: fuzzy.entry.seriesId,
      userStatus: fuzzy.entry.userStatus,
      nextEpisode: null, // no confirmed catalog to resolve a next episode from yet.
      needsAttention: true,
      attentionReasonCode: classification?.reasonCode ?? 'no-confirmed-provider-match',
    };
  }

  return {
    type: 'POSSIBLE',
    seriesId: fuzzy.entry.seriesId,
    seriesTitle: fuzzy.entry.title,
    seriesUserStatus: fuzzy.entry.userStatus,
    confidence: fuzzy.confidence,
    reason: describePossibleMatchReason(fuzzy),
  };
}

function describePossibleMatchReason(fuzzy: FuzzyMatch): string {
  if (fuzzy.entry.hasConfirmedProviderMatch) {
    return 'Similar title to a series already confirmed under a different provider match — may be the same show, or a different one.';
  }
  return fuzzy.band === 'HIGH_CONFIDENCE' ? 'Very similar title, different year.' : 'Similar title, not an exact match.';
}
