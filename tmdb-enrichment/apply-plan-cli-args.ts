// Pure CLI argument parsing for run-apply-plan.ts, split into its own
// module (no I/O, no `main()` side effect) so it's importable from a test
// file without executing the script itself.
//
// Deliberately strict: an unrecognized flag or a value-flag given without a
// value fails loudly rather than being silently dropped. The bug this
// replaces (--plan <path> being silently ignored, falling back to
// findLatestApplyPlan() and applying whichever plan happened to be newest)
// is exactly the kind of mistake "ignore anything we don't recognize"
// produces — for a script that can write to the database, a typo'd flag
// should stop the run, not quietly change what it does.

import path from 'path';
import { DEV_USER_ID } from '../src/common/constants';

export interface CliOptions {
  userId: string;
  planPath: string | null;
  apply: boolean;
  seriesIds?: string[];
  force: boolean;
}

export class ArgParseError extends Error {}

type FlagType = 'boolean' | 'value';

const FLAG_TYPES: Record<string, FlagType> = {
  '--apply': 'boolean',
  '--force': 'boolean',
  '--plan': 'value',
  '--user': 'value',
  '--series': 'value',
};

// Accepts both --flag=value and --flag value for every value-taking flag
// (not just --plan) — same parser, so there's only one place this logic
// can drift.
export function parseApplyPlanArgs(argv: string[]): CliOptions {
  const options: CliOptions = { userId: DEV_USER_ID, planPath: null, apply: false, force: false };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (!arg.startsWith('--')) {
      throw new ArgParseError(`unexpected argument "${arg}" — expected a --flag`);
    }

    const eqIndex = arg.indexOf('=');
    const flag = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
    const inlineValue = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);

    const type = FLAG_TYPES[flag];
    if (!type) {
      throw new ArgParseError(`unknown flag "${flag}"`);
    }

    if (type === 'boolean') {
      if (inlineValue !== undefined) {
        throw new ArgParseError(`"${flag}" does not take a value (got "${flag}=${inlineValue}")`);
      }
      if (flag === '--apply') options.apply = true;
      if (flag === '--force') options.force = true;
      i += 1;
      continue;
    }

    // type === 'value': accept "--flag=value" or "--flag value". The
    // lookahead refuses to swallow the NEXT flag as this one's value
    // (e.g. `--plan --apply` must fail, not silently set planPath="--apply").
    let value = inlineValue;
    let consumed = 1;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        consumed = 2;
      }
    }
    if (value === undefined || value === '') {
      throw new ArgParseError(`"${flag}" requires a value, e.g. ${flag}=<value> or ${flag} <value>`);
    }

    if (flag === '--plan') options.planPath = path.resolve(value);
    else if (flag === '--user') options.userId = value;
    else if (flag === '--series') options.seriesIds = value.split(',').filter(Boolean);

    i += consumed;
  }

  return options;
}
