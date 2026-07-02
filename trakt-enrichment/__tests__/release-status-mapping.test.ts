import { ReleaseStatus } from '@prisma/client';
import { mapTraktStatusToReleaseStatus } from '../release-status-mapping';

describe('mapTraktStatusToReleaseStatus', () => {
  it('maps the expected (provisional) Trakt status strings', () => {
    expect(mapTraktStatusToReleaseStatus('returning series')).toBe(ReleaseStatus.RETURNING);
    expect(mapTraktStatusToReleaseStatus('ended')).toBe(ReleaseStatus.ENDED);
    expect(mapTraktStatusToReleaseStatus('canceled')).toBe(ReleaseStatus.CANCELLED);
    expect(mapTraktStatusToReleaseStatus('cancelled')).toBe(ReleaseStatus.CANCELLED);
    expect(mapTraktStatusToReleaseStatus('upcoming')).toBe(ReleaseStatus.IN_PRODUCTION);
  });

  it('is case-insensitive', () => {
    expect(mapTraktStatusToReleaseStatus('Returning Series')).toBe(ReleaseStatus.RETURNING);
  });

  it('falls back to UNKNOWN for missing or unrecognized values', () => {
    expect(mapTraktStatusToReleaseStatus(null)).toBe(ReleaseStatus.UNKNOWN);
    expect(mapTraktStatusToReleaseStatus(undefined)).toBe(ReleaseStatus.UNKNOWN);
    expect(mapTraktStatusToReleaseStatus('some future value Trakt might add')).toBe(ReleaseStatus.UNKNOWN);
  });
});
