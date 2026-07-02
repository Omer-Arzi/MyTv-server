import { ReleaseStatus } from '@prisma/client';
import { mapTmdbStatusToReleaseStatus } from '../release-status-mapping';

describe('mapTmdbStatusToReleaseStatus', () => {
  it('maps every confirmed TMDb status value', () => {
    expect(mapTmdbStatusToReleaseStatus('Returning Series')).toBe(ReleaseStatus.RETURNING);
    expect(mapTmdbStatusToReleaseStatus('Ended')).toBe(ReleaseStatus.ENDED);
    expect(mapTmdbStatusToReleaseStatus('Cancelled')).toBe(ReleaseStatus.CANCELLED);
    expect(mapTmdbStatusToReleaseStatus('In Production')).toBe(ReleaseStatus.IN_PRODUCTION);
    expect(mapTmdbStatusToReleaseStatus('Planned')).toBe(ReleaseStatus.IN_PRODUCTION);
    expect(mapTmdbStatusToReleaseStatus('Pilot')).toBe(ReleaseStatus.IN_PRODUCTION);
  });

  it('is case-insensitive', () => {
    expect(mapTmdbStatusToReleaseStatus('returning series')).toBe(ReleaseStatus.RETURNING);
  });

  it('falls back to UNKNOWN for missing or unrecognized values', () => {
    expect(mapTmdbStatusToReleaseStatus(null)).toBe(ReleaseStatus.UNKNOWN);
    expect(mapTmdbStatusToReleaseStatus(undefined)).toBe(ReleaseStatus.UNKNOWN);
    expect(mapTmdbStatusToReleaseStatus('something new TMDb might add')).toBe(ReleaseStatus.UNKNOWN);
  });
});
