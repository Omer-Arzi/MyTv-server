// Pure decision logic for the focused INCOMPLETE_CATALOG investigation
// report. No I/O, no Prisma, no TMDb calls — this only ever reasons about
// data already handed to it (a completed live TMDb comparison, or the fact
// that one couldn't be attempted), same pattern as health-logic.ts and
// episode-release-refresh/refresh-logic.ts.
//
// This deliberately reuses episode-release-refresh/refresh-logic.ts's
// compareSeriesCatalog for the actual local-vs-provider structural
// comparison rather than reimplementing it — that function already embodies
// the season-shift/watched-episode-alignment safety gates this report needs,
// and reusing it means the two pipelines can never quietly disagree about
// what counts as risky.

import { CompareSeriesCatalogResult } from '../episode-release-refresh/refresh-logic';
import { RiskFlag } from './health-logic';

export type IncompleteCatalogIssueClassification =
  | 'SAFE_PROVIDER_REFRESH_CANDIDATE'
  | 'NEEDS_PROVIDER_MATCH'
  | 'NEEDS_ABSOLUTE_NUMBERING_PROVIDER'
  | 'PROVIDER_STRUCTURE_RISK'
  | 'LIKELY_ALREADY_COMPLETE_BUT_UNTRUSTED'
  | 'NEEDS_MANUAL_USER_CONFIRMATION';

export type IncompleteCatalogRecommendedAction =
  | 'RUN_TARGETED_TMDB_REFRESH_DRY_RUN'
  | 'RUN_TVMAZE_COMPARISON'
  | 'ADD_TO_PROVIDER_STRUCTURE_RISK_LIST'
  | 'USE_ABSOLUTE_NUMBERING_PROVIDER_LATER'
  | 'ASK_USER_TO_CONFIRM_PROGRESS'
  | 'NO_ACTION';

// The outcome of attempting a live TMDb fetch+compare for one series —
// only ever constructed by run-incomplete-catalog-investigation.ts, never
// by this file. `null` means "no tmdbId, never attempted" (see
// InvestigateIncompleteCatalogInput.hasTmdbId).
export type ProviderComparisonOutcome =
  | { succeeded: true; comparison: CompareSeriesCatalogResult; providerSeasonCount: number }
  | { succeeded: false; error: string };

export interface InvestigateIncompleteCatalogInput {
  hasTmdbId: boolean;
  // Why health-logic.ts's classifySeriesHealth flagged this series in the
  // first place — folded into the narrative `reason` below so the report
  // explains both "why we looked" and "what we found."
  healthRiskFlags: RiskFlag[];
  localSeasonCount: number;
  // null exactly when hasTmdbId is false (never attempted).
  providerComparison: ProviderComparisonOutcome | null;
}

export interface IncompleteCatalogInvestigationResult {
  issueClassification: IncompleteCatalogIssueClassification;
  recommendedNextAction: IncompleteCatalogRecommendedAction;
  reason: string;
}

function describeHealthRiskFlags(flags: RiskFlag[]): string {
  const parts: string[] = [];
  if (flags.includes('NO_LOCAL_EPISODES')) parts.push('no local episodes are recorded at all');
  if (flags.includes('MOSTLY_UNENRICHED_EPISODES')) parts.push('most local episodes have no title/airDate — looks like an unenriched TV Time import');
  if (flags.includes('NEXT_EPISODE_INCONSISTENT')) {
    parts.push('the stored nextEpisodeId does not match what the local catalog + watch history actually compute');
  }
  return parts.length > 0 ? parts.join('; ') : 'flagged by the Library Health report';
}

// Decides exactly one issueClassification + recommendedNextAction for one
// INCOMPLETE_CATALOG series, given the outcome of (at most) one live TMDb
// comparison attempt. See docs/episode-release-refresh-strategy.md and
// library-health/health-logic.ts for the safety posture this continues:
// never auto-apply, only ever report + recommend.
export function investigateIncompleteCatalog(input: InvestigateIncompleteCatalogInput): IncompleteCatalogInvestigationResult {
  const localReason = describeHealthRiskFlags(input.healthRiskFlags);

  // --- No confirmed provider match: never auto-match, just report. -------
  if (!input.hasTmdbId) {
    return {
      issueClassification: 'NEEDS_PROVIDER_MATCH',
      recommendedNextAction: 'RUN_TVMAZE_COMPARISON',
      reason: `${localReason}. No tmdbId on file — provider confirmation is needed before any catalog refresh can safely be attempted; not auto-matching. TVmaze needs no auth and never auto-applies, making it the safe first comparison signal to gather here.`,
    };
  }

  const outcome = input.providerComparison;

  // --- Fetch never happened or failed: local reasoning only, retry later. -
  if (!outcome || !outcome.succeeded) {
    const errorDetail = outcome && !outcome.succeeded ? outcome.error : 'no attempt was recorded for this run';
    return {
      issueClassification: 'LIKELY_ALREADY_COMPLETE_BUT_UNTRUSTED',
      recommendedNextAction: 'RUN_TARGETED_TMDB_REFRESH_DRY_RUN',
      reason: `${localReason}. A live TMDb comparison could not be completed this run (${errorDetail}) — retry a targeted refresh dry-run later to confirm.`,
    };
  }

  const { comparison, providerSeasonCount } = outcome;

  // --- Season/episode shape mismatch confirmed live: risky, report only. -
  if (comparison.classification === 'RISKY_DO_NOT_APPLY') {
    // TMDb collapsing many local seasons into one (or none) is the classic
    // anime absolute-numbering signature (see
    // docs/episode-numbering-and-season-shift-risk.md) — routed to the more
    // specific "needs a different kind of provider" action. Any other
    // shrink/disappearance pattern gets the generic risk-list action.
    const looksLikeAbsoluteNumberingConsolidation = providerSeasonCount <= 1 && input.localSeasonCount > 1;
    if (looksLikeAbsoluteNumberingConsolidation) {
      return {
        issueClassification: 'NEEDS_ABSOLUTE_NUMBERING_PROVIDER',
        recommendedNextAction: 'USE_ABSOLUTE_NUMBERING_PROVIDER_LATER',
        reason: `${localReason}. Live TMDb comparison shows TMDb consolidating ${input.localSeasonCount} local season(s) into ${providerSeasonCount} — the classic anime absolute-numbering mismatch; needs an absolute-numbering-aware provider (e.g. TheTVDB), not a plain TMDb refresh.`,
      };
    }
    return {
      issueClassification: 'PROVIDER_STRUCTURE_RISK',
      recommendedNextAction: 'ADD_TO_PROVIDER_STRUCTURE_RISK_LIST',
      reason: `${localReason}. Live TMDb comparison confirms a season/episode-shape mismatch: ${comparison.warnings.join('; ')}`,
    };
  }

  // --- Watched episode(s) misaligned, but counts otherwise line up. ------
  if (comparison.classification === 'NEEDS_MANUAL_REVIEW') {
    return {
      issueClassification: 'NEEDS_MANUAL_USER_CONFIRMATION',
      recommendedNextAction: 'ASK_USER_TO_CONFIRM_PROGRESS',
      reason: `${localReason}. Live TMDb comparison found watched episode(s) with no matching provider slot even though season counts line up: ${comparison.warnings.join('; ')}`,
    };
  }

  // --- No structural risk. Genuinely new provider episodes to backfill? --
  if (comparison.releasedNewEpisodeCount > 0 || comparison.futureNewEpisodeCount > 0) {
    return {
      issueClassification: 'SAFE_PROVIDER_REFRESH_CANDIDATE',
      recommendedNextAction: 'RUN_TARGETED_TMDB_REFRESH_DRY_RUN',
      reason: `${localReason}. Live TMDb comparison found ${comparison.newEpisodes.length} new episode(s) (${comparison.releasedNewEpisodeCount} released) not yet in the local catalog, with no structural risk — safe to refresh.`,
    };
  }

  // --- No structural risk, no new provider episodes either. The catalog's
  // SHAPE is provider-confirmed fine; whatever tripped INCOMPLETE_CATALOG
  // (see localReason) is a local metadata/progress problem a refresh would
  // still resolve (resync nextEpisodeId/userStatus, backfill any missing
  // title/airDate/image fields) even though no episodes get added.
  return {
    issueClassification: 'LIKELY_ALREADY_COMPLETE_BUT_UNTRUSTED',
    recommendedNextAction: 'RUN_TARGETED_TMDB_REFRESH_DRY_RUN',
    reason: `${localReason}. Live TMDb comparison found no new episodes and no structural risk — the catalog is likely already complete; a refresh would just resync nextEpisodeId/userStatus and backfill any missing metadata.`,
  };
}
