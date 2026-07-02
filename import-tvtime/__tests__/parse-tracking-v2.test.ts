import path from 'path';
import { readCsvFile } from '../csv';
import { classifyRow, groupWatchEvents, parseTrackingV2Rows, parseUserSeriesRow, parseWatchEventRow } from '../parse-tracking-v2';
import { UserSeriesRow, WatchEvent } from '../types';

const fixturePath = path.join(__dirname, '..', 'fixtures', 'tracking-prod-records-v2.sample.csv');

describe('classifyRow', () => {
  it('classifies by key prefix', () => {
    expect(classifyRow('watch-episode-abc')).toBe('watch');
    expect(classifyRow('rewatch-episode-abc')).toBe('rewatch');
    expect(classifyRow('user-series-abc')).toBe('user-series');
    expect(classifyRow('tracking-stats')).toBe('unknown');
  });
});

describe('parseWatchEventRow', () => {
  it('parses a well-formed row', () => {
    const result = parseWatchEventRow(
      {
        series_name: 'Series A',
        season_number: '1',
        episode_number: '1',
        created_at: '2020-01-01 10:00:00',
        user_id: '111',
        s_id: 'show-a',
        episode_id: 'ep-a-1',
        bulk_type: '',
        runtime: '42',
      },
      'watch',
      1,
    );

    expect('error' in result).toBe(false);
    const event = result as WatchEvent;
    expect(event.seriesName).toBe('Series A');
    expect(event.seasonNumber).toBe(1);
    expect(event.episodeNumber).toBe(1);
    expect(event.watchedAt.toISOString()).toBe('2020-01-01T10:00:00.000Z');
    expect(event.isRewatch).toBe(false);
    expect(event.bulkType).toBeNull();
    expect(event.runtimeMinutes).toBe(42);
  });

  it('reports a missing season_number as an error, not a silent default', () => {
    const result = parseWatchEventRow(
      { series_name: 'Series C', episode_number: '1', created_at: '2020-01-08 09:00:00', user_id: '111' },
      'watch',
      6,
    );

    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/season_number/);
  });
});

describe('parseUserSeriesRow', () => {
  it('parses is_for_later/is_followed booleans and prefers followed_at over updated_at', () => {
    const result = parseUserSeriesRow(
      {
        series_name: 'Series B',
        user_id: '111',
        is_followed: 'true',
        is_for_later: 'true',
        is_archived: 'false',
        ep_watch_count: '0',
        followed_at: '1700000000000000',
        updated_at: '2020-01-07 09:00:00',
      },
      5,
    );

    expect('error' in result).toBe(false);
    const row = result as UserSeriesRow;
    expect(row.isForLater).toBe(true);
    expect(row.isFollowed).toBe(true);
    expect(row.epWatchCount).toBe(0);
    // followed_at is microseconds since epoch — 1700000000000000us = 1700000000000ms
    expect(row.followedAt?.getTime()).toBe(1700000000000);
  });

  it('falls back to updated_at when followed_at is blank', () => {
    const result = parseUserSeriesRow(
      { series_name: 'Series A', user_id: '111', updated_at: '2020-01-06 09:00:00', is_for_later: 'false' },
      4,
    );

    expect('error' in result).toBe(false);
    const row = result as UserSeriesRow;
    expect(row.followedAt?.toISOString()).toBe('2020-01-06T09:00:00.000Z');
  });
});

describe('parseTrackingV2Rows + groupWatchEvents on the fixture file', () => {
  const { rows } = readCsvFile(fixturePath);
  const { watchEvents, userSeriesRows, issues } = parseTrackingV2Rows(rows);

  it('splits watch/rewatch rows from user-series rows and flags unparseable rows', () => {
    // rows 1,2,3,7 are watch/rewatch events; row 6 is missing season_number
    // (a parse issue, not a silent drop); rows 4,5 are user-series rows.
    expect(watchEvents).toHaveLength(4);
    expect(userSeriesRows).toHaveLength(2);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/season_number/);
  });

  it('groups the first-watch and rewatch of the same episode into one aggregate', () => {
    const sameUserEvents = watchEvents.filter((e) => e.tvtimeUserId === '111');
    const aggregates = groupWatchEvents(sameUserEvents);

    const s1e1 = aggregates.find((a) => a.seriesName === 'Series A' && a.seasonNumber === 1 && a.episodeNumber === 1);
    expect(s1e1).toBeDefined();
    // earliest of the watch (Jan 1) and rewatch (Feb 1) wins as the canonical date
    expect(s1e1?.watchedAt.toISOString()).toBe('2020-01-01T10:00:00.000Z');
    expect(s1e1?.rewatchCount).toBe(1);
    expect(s1e1?.watchDateApproximate).toBe(false);
    expect(s1e1?.contributingRowNumbers.sort()).toEqual([1, 2]);
  });

  it('marks bulk fill-previous watches as an approximate date', () => {
    const sameUserEvents = watchEvents.filter((e) => e.tvtimeUserId === '111');
    const aggregates = groupWatchEvents(sameUserEvents);

    const s2e1 = aggregates.find((a) => a.seriesName === 'Series A' && a.seasonNumber === 2 && a.episodeNumber === 1);
    expect(s2e1?.watchDateApproximate).toBe(true);
    expect(s2e1?.rewatchCount).toBe(0);
  });

  it('keeps the mismatched-account row separately parseable so the caller can flag it', () => {
    const mismatched = watchEvents.filter((e) => e.tvtimeUserId !== '111');
    expect(mismatched).toHaveLength(1);
    expect(mismatched[0].seriesName).toBe('Series A');
    expect(mismatched[0].episodeNumber).toBe(3);
  });
});
