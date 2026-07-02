import { ReleaseStatus, UserSeriesStatus } from '@prisma/client';

// The single source of truth for "what does having/not-having a next
// episode mean for userStatus" — shared by the mark-watched flow and any
// future re-evaluation pass (e.g. once enrichment resolves a series' full
// catalog), so the two can never disagree about what "caught up" means.
// See docs/status-model-plan.md §6.
export function deriveUserStatusFromNextEpisode(hasNextEpisode: boolean, releaseStatus: ReleaseStatus): UserSeriesStatus {
  if (hasNextEpisode) return UserSeriesStatus.WATCHING;

  const isFinished = releaseStatus === ReleaseStatus.ENDED || releaseStatus === ReleaseStatus.CANCELLED;
  return isFinished ? UserSeriesStatus.COMPLETED : UserSeriesStatus.CAUGHT_UP;
}

// A user's userStatus that an enrichment "apply" step must never override —
// dropped/paused are explicit personal intent, not a data-completeness
// artifact enrichment can correct. See docs/status-model-plan.md §2/§7a.
const PROTECTED_USER_STATUSES: UserSeriesStatus[] = [UserSeriesStatus.DROPPED, UserSeriesStatus.PAUSED];

export interface ProposeUserStatusInput {
  currentUserStatus: UserSeriesStatus;
  watchedEpisodeCount: number;
  totalKnownEpisodeCount: number;
  candidateReleaseStatus: ReleaseStatus;
}

export interface ProposedUserStatus {
  proposedUserStatus: UserSeriesStatus;
  reason: string;
}

// Preview-only: computes what userStatus WOULD become if a given enrichment
// candidate's data were applied, without applying it. Used by the Trakt/TMDb
// dry-run reports (docs/status-model-plan.md §7a) so a reviewer can see the
// consequence of a match before any apply step exists. Same rules as
// deriveUserStatusFromNextEpisode/§6-§7, just fed "the fuller picture
// enrichment would provide" instead of MyTv's own (possibly incomplete)
// catalog.
export function proposeUserStatusAfterEnrichment(input: ProposeUserStatusInput): ProposedUserStatus {
  if (PROTECTED_USER_STATUSES.includes(input.currentUserStatus)) {
    return {
      proposedUserStatus: input.currentUserStatus,
      reason: `current status is ${input.currentUserStatus} (user-controlled) — enrichment never overrides explicit personal status`,
    };
  }

  if (input.watchedEpisodeCount === 0) {
    return {
      proposedUserStatus: input.currentUserStatus,
      reason: 'no episodes watched yet — a fuller episode catalog does not change watch status',
    };
  }

  if (input.watchedEpisodeCount >= input.totalKnownEpisodeCount) {
    const isFinished =
      input.candidateReleaseStatus === ReleaseStatus.ENDED || input.candidateReleaseStatus === ReleaseStatus.CANCELLED;
    const proposedUserStatus = isFinished ? UserSeriesStatus.COMPLETED : UserSeriesStatus.CAUGHT_UP;
    return {
      proposedUserStatus,
      reason: `full episode catalog now known (${input.totalKnownEpisodeCount} episodes); watched ${input.watchedEpisodeCount}/${input.totalKnownEpisodeCount} and release status would be ${input.candidateReleaseStatus} — would move to ${proposedUserStatus}`,
    };
  }

  return {
    proposedUserStatus: UserSeriesStatus.WATCHING,
    reason: `full episode catalog now known (${input.totalKnownEpisodeCount} episodes); ${
      input.totalKnownEpisodeCount - input.watchedEpisodeCount
    } unwatched episode(s) remain — would move to WATCHING`,
  };
}
