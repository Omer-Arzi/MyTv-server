import { ReleaseStatus } from '@prisma/client';

// TMDb's status enum is confirmed (community-sourced, docs/tmdb-enrichment-plan.md
// §2: Returning Series/Planned/In Production/Ended/Cancelled/Pilot), unlike
// Trakt's. Still used only for the dry-run report preview
// (docs/status-model-plan.md §7a) — never written to Series.releaseStatus,
// since no apply step exists for this pipeline.
export function mapTmdbStatusToReleaseStatus(rawStatus: string | null | undefined): ReleaseStatus {
  if (!rawStatus) return ReleaseStatus.UNKNOWN;

  switch (rawStatus.trim().toLowerCase()) {
    case 'returning series':
      return ReleaseStatus.RETURNING;
    case 'ended':
      return ReleaseStatus.ENDED;
    case 'canceled':
    case 'cancelled':
      return ReleaseStatus.CANCELLED;
    case 'in production':
    case 'planned':
    case 'pilot':
      return ReleaseStatus.IN_PRODUCTION;
    default:
      return ReleaseStatus.UNKNOWN;
  }
}
