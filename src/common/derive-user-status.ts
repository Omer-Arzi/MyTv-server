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
