import { ReleaseStatus } from '@prisma/client';

// Trakt's status enum values are UNCONFIRMED against a live response
// (docs/trakt-enrichment-plan.md §2 — expected but never independently
// verified). This mapping is provisional and used only for the dry-run
// report preview (docs/status-model-plan.md §7a) — it is never written to
// Series.releaseStatus, since no apply step exists for this pipeline.
export function mapTraktStatusToReleaseStatus(rawStatus: string | null | undefined): ReleaseStatus {
  if (!rawStatus) return ReleaseStatus.UNKNOWN;

  switch (rawStatus.trim().toLowerCase()) {
    case 'returning series':
      return ReleaseStatus.RETURNING;
    case 'ended':
      return ReleaseStatus.ENDED;
    case 'canceled':
    case 'cancelled':
      return ReleaseStatus.CANCELLED;
    case 'upcoming':
    case 'in production':
    case 'planned':
    case 'pilot':
      return ReleaseStatus.IN_PRODUCTION;
    default:
      return ReleaseStatus.UNKNOWN;
  }
}
