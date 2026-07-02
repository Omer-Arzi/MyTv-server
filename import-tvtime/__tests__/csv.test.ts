import path from 'path';
import { readCsvFile } from '../csv';

const fixturesDir = path.join(__dirname, '..', 'fixtures');

describe('readCsvFile', () => {
  it('parses a well-formed CSV into header + row objects', () => {
    const { header, rows } = readCsvFile(path.join(fixturesDir, 'device_data.sample.csv'));

    expect(header).toEqual(['created_at', 'updated_at', 'id', 'device_id', 'name', 'value']);
    expect(rows).toHaveLength(1);
    expect(rows[0].device_id).toBe('some-device-uuid');
    expect(rows[0].name).toBe('push_enabled');
  });

  it('parses the larger tracking-prod-records-v2 fixture with all rows as string values', () => {
    const { rows } = readCsvFile(path.join(fixturesDir, 'tracking-prod-records-v2.sample.csv'));

    expect(rows).toHaveLength(7);
    expect(rows[0].key).toBe('watch-episode-uuid1');
    expect(rows[0].series_name).toBe('Series A');
    expect(typeof rows[0].season_number).toBe('string');
  });
});
