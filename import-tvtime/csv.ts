import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';

export interface CsvFile {
  header: string[];
  rows: Record<string, string>[];
}

// TV Time's export has quoted fields containing raw commas/newlines (e.g.
// comment text, Go-map-serialized blobs in lists-prod-lists.csv) — a naive
// split(',') would silently corrupt those rows, so this goes through a real
// CSV parser rather than hand-rolled parsing.
export function readCsvFile(path: string): CsvFile {
  const content = readFileSync(path, 'utf8');
  const rows: Record<string, string>[] = parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
  const header = rows.length > 0 ? Object.keys(rows[0]) : parseHeaderOnly(content);
  return { header, rows };
}

function parseHeaderOnly(content: string): string[] {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
  const [header] = parse(firstLine, { columns: false, skip_empty_lines: true }) as string[][];
  return header ?? [];
}
