import { ReleaseStatus } from '@prisma/client';
import { computeEpisodeUrgency, isEpisodeReleased, parseProviderDateOnly } from '../release-date-policy';

describe('parseProviderDateOnly', () => {
  it('parses a bare YYYY-MM-DD provider date as UTC midnight of that calendar date', () => {
    const parsed = parseProviderDateOnly('2026-07-13');
    expect(parsed).not.toBeNull();
    expect(parsed!.toISOString()).toBe('2026-07-13T00:00:00.000Z');
  });

  it('returns null for a missing value', () => {
    expect(parseProviderDateOnly(null)).toBeNull();
    expect(parseProviderDateOnly(undefined)).toBeNull();
  });

  it('returns null for an empty string rather than parsing it as "now"', () => {
    expect(parseProviderDateOnly('')).toBeNull();
  });

  it('returns null for a malformed/invalid provider date instead of throwing', () => {
    expect(parseProviderDateOnly('not-a-date')).toBeNull();
    expect(parseProviderDateOnly('2026-13-99')).toBeNull();
  });

  it('rejects a value that carries a time/offset component — bare-date only, by design', () => {
    expect(parseProviderDateOnly('2026-07-13T00:00:00Z')).toBeNull();
  });
});

describe('isEpisodeReleased — calendar date boundary', () => {
  const airDate = new Date('2026-07-13T00:00:00.000Z');

  it('is NOT released the calendar day before', () => {
    expect(isEpisodeReleased(airDate, new Date('2026-07-12T23:59:59.999Z'))).toBe(false);
  });

  it('IS released at the exact start of the calendar date (UTC midnight)', () => {
    expect(isEpisodeReleased(airDate, new Date('2026-07-13T00:00:00.000Z'))).toBe(true);
  });

  it('IS released later on the calendar date', () => {
    expect(isEpisodeReleased(airDate, new Date('2026-07-13T15:17:00.000Z'))).toBe(true);
  });

  it('IS released on any later date', () => {
    expect(isEpisodeReleased(airDate, new Date('2026-07-20T00:00:00.000Z'))).toBe(true);
  });

  it('a missing airDate is never released, regardless of now', () => {
    expect(isEpisodeReleased(null, new Date('2099-01-01T00:00:00.000Z'))).toBe(false);
  });

  // The policy is deliberately UTC-anchored (see release-date-policy.ts's
  // file header) — its result must depend only on the two Date instants
  // compared, never on the host process's local timezone. `Date` instants
  // themselves are timezone-independent (a single point in time,
  // regardless of what timezone constructed them) — these two "now"
  // instants are the SAME real-world moment expressed via a UTC literal vs
  // an explicit Asia/Jerusalem offset (+03:00 in July, DST), proving the
  // comparison is correct at that shared instant either way.
  it('UTC and an equivalent Asia/Jerusalem-offset instant agree — the policy compares real instants, not wall-clock strings', () => {
    const utcNow = new Date('2026-07-13T00:00:00.000Z');
    const jerusalemEquivalent = new Date('2026-07-13T03:00:00.000+03:00'); // same instant, +03:00 (Israel Daylight Time in July)
    expect(utcNow.getTime()).toBe(jerusalemEquivalent.getTime());
    expect(isEpisodeReleased(airDate, utcNow)).toBe(isEpisodeReleased(airDate, jerusalemEquivalent));
  });

  it('a moment just before UTC midnight, even if already past midnight in a UTC+ timezone, is not yet released — the policy is UTC-anchored, not locale-anchored', () => {
    // 2026-07-12T22:00Z is already 2026-07-13 01:00 in Asia/Jerusalem
    // (UTC+3), but the provider date/UTC boundary has not been crossed yet.
    const now = new Date('2026-07-12T22:00:00.000Z');
    expect(isEpisodeReleased(airDate, now)).toBe(false);
  });

  it('daylight-saving transition instants are handled correctly — comparison is instant-based, immune to any DST rule', () => {
    // US DST spring-forward 2026-03-08 02:00 local -> 03:00 local. Whatever
    // the local wall-clock oddity, the underlying UTC instants are still
    // strictly ordered, and the policy only ever compares those instants.
    const beforeDstJump = new Date('2026-03-08T06:59:00.000Z');
    const afterDstJump = new Date('2026-03-08T07:01:00.000Z');
    const dstAirDate = new Date('2026-03-08T07:00:00.000Z');
    expect(isEpisodeReleased(dstAirDate, beforeDstJump)).toBe(false);
    expect(isEpisodeReleased(dstAirDate, afterDstJump)).toBe(true);
  });
});

describe('computeEpisodeUrgency', () => {
  const now = new Date('2026-07-13T12:00:00Z');
  const HOUR_MS = 60 * 60 * 1000;

  it('overdue (airDate already passed) -> OVERDUE_OR_DUE_TODAY', () => {
    expect(computeEpisodeUrgency({ releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: new Date(now.getTime() - HOUR_MS), now })).toBe('OVERDUE_OR_DUE_TODAY');
  });

  it('due exactly now -> OVERDUE_OR_DUE_TODAY (inclusive boundary)', () => {
    expect(computeEpisodeUrgency({ releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: now, now })).toBe('OVERDUE_OR_DUE_TODAY');
  });

  it('due within 48h -> DUE_WITHIN_48H', () => {
    expect(computeEpisodeUrgency({ releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: new Date(now.getTime() + 47 * HOUR_MS), now })).toBe('DUE_WITHIN_48H');
  });

  it('exactly at the 48h boundary -> DUE_WITHIN_48H (inclusive)', () => {
    expect(computeEpisodeUrgency({ releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: new Date(now.getTime() + 48 * HOUR_MS), now })).toBe('DUE_WITHIN_48H');
  });

  it('just past the 48h boundary and provider still active -> ACTIVE_NO_NEAR_EPISODE', () => {
    expect(computeEpisodeUrgency({ releaseStatus: ReleaseStatus.RETURNING, nextKnownUpcomingAirDate: new Date(now.getTime() + 49 * HOUR_MS), now })).toBe('ACTIVE_NO_NEAR_EPISODE');
  });

  it('no known upcoming episode, provider still active -> ACTIVE_NO_NEAR_EPISODE', () => {
    expect(computeEpisodeUrgency({ releaseStatus: ReleaseStatus.IN_PRODUCTION, nextKnownUpcomingAirDate: null, now })).toBe('ACTIVE_NO_NEAR_EPISODE');
  });

  it('no known upcoming episode, provider ended -> BETWEEN_SEASONS_OR_UNKNOWN', () => {
    expect(computeEpisodeUrgency({ releaseStatus: ReleaseStatus.ENDED, nextKnownUpcomingAirDate: null, now })).toBe('BETWEEN_SEASONS_OR_UNKNOWN');
  });

  it('invalid/missing date input (null) never crashes — degrades to release-status-only classification', () => {
    expect(() => computeEpisodeUrgency({ releaseStatus: ReleaseStatus.UNKNOWN, nextKnownUpcomingAirDate: null, now })).not.toThrow();
  });
});
