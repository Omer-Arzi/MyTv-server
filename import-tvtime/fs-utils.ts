import { readdirSync } from 'fs';
import path from 'path';

export function listCsvFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.csv'))
    .sort()
    .map((name) => path.join(dir, name));
}
