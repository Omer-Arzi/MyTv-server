import path from 'path';
import { ArgParseError, parseApplyPlanArgs } from '../apply-plan-cli-args';

describe('parseApplyPlanArgs — --plan', () => {
  it('accepts --plan=<path>', () => {
    const options = parseApplyPlanArgs(['--plan=tmdb-enrichment/output/batch-1/tmdb-apply-plan.json']);
    expect(options.planPath).toBe(path.resolve('tmdb-enrichment/output/batch-1/tmdb-apply-plan.json'));
  });

  it('accepts --plan <path> (space-separated)', () => {
    const options = parseApplyPlanArgs(['--plan', 'tmdb-enrichment/output/batch-1/tmdb-apply-plan.json']);
    expect(options.planPath).toBe(path.resolve('tmdb-enrichment/output/batch-1/tmdb-apply-plan.json'));
  });

  it('fails with a clear error when --plan is given with no value (end of args)', () => {
    expect(() => parseApplyPlanArgs(['--plan'])).toThrow(ArgParseError);
    expect(() => parseApplyPlanArgs(['--plan'])).toThrow(/requires a value/);
  });

  it('fails with a clear error when --plan is immediately followed by another flag', () => {
    expect(() => parseApplyPlanArgs(['--plan', '--apply'])).toThrow(/requires a value/);
  });

  it('fails with a clear error when --plan= has an empty value', () => {
    expect(() => parseApplyPlanArgs(['--plan='])).toThrow(/requires a value/);
  });

  it('never silently falls back to no planPath when --plan was actually provided', () => {
    // Regression test for the exact bug being fixed: --plan <path> used to
    // be silently ignored, leaving planPath null and falling back to
    // findLatestApplyPlan() — which could pick the wrong batch if more than
    // one exists.
    const options = parseApplyPlanArgs(['--plan', '/some/explicit/path.json']);
    expect(options.planPath).not.toBeNull();
    expect(options.planPath).toBe(path.resolve('/some/explicit/path.json'));
  });
});

describe('parseApplyPlanArgs — --apply and --force', () => {
  it('defaults apply and force to false', () => {
    const options = parseApplyPlanArgs([]);
    expect(options.apply).toBe(false);
    expect(options.force).toBe(false);
  });

  it('sets apply=true for --apply', () => {
    expect(parseApplyPlanArgs(['--apply']).apply).toBe(true);
  });

  it('sets force=true for --force', () => {
    expect(parseApplyPlanArgs(['--force']).force).toBe(true);
  });

  it('rejects a value attached to a boolean flag', () => {
    expect(() => parseApplyPlanArgs(['--apply=true'])).toThrow(/does not take a value/);
  });
});

describe('parseApplyPlanArgs — --series', () => {
  it('accepts --series=<id1,id2>', () => {
    const options = parseApplyPlanArgs(['--series=id-1,id-2']);
    expect(options.seriesIds).toEqual(['id-1', 'id-2']);
  });

  it('accepts --series <id1,id2> (space-separated)', () => {
    const options = parseApplyPlanArgs(['--series', 'id-1,id-2']);
    expect(options.seriesIds).toEqual(['id-1', 'id-2']);
  });

  it('is undefined when not provided, so the apply step applies every safe candidate', () => {
    expect(parseApplyPlanArgs([]).seriesIds).toBeUndefined();
  });
});

describe('parseApplyPlanArgs — --user', () => {
  it('accepts --user=<id> and --user <id>', () => {
    expect(parseApplyPlanArgs(['--user=user-9']).userId).toBe('user-9');
    expect(parseApplyPlanArgs(['--user', 'user-9']).userId).toBe('user-9');
  });
});

describe('parseApplyPlanArgs — unknown/invalid input', () => {
  it('fails with a clear error on an unknown flag instead of silently ignoring it', () => {
    expect(() => parseApplyPlanArgs(['--bogus'])).toThrow(ArgParseError);
    expect(() => parseApplyPlanArgs(['--bogus'])).toThrow(/unknown flag "--bogus"/);
  });

  it('fails on an unknown flag given with a value too', () => {
    expect(() => parseApplyPlanArgs(['--bogus=123'])).toThrow(/unknown flag "--bogus"/);
  });

  it('fails on a stray positional argument that is not a flag', () => {
    expect(() => parseApplyPlanArgs(['not-a-flag'])).toThrow(/unexpected argument/);
  });
});

describe('parseApplyPlanArgs — combinations', () => {
  it('parses a realistic full command line with mixed --flag=value and --flag value styles', () => {
    const options = parseApplyPlanArgs(['--plan', '/plan.json', '--user=user-5', '--series', 'a,b,c', '--force']);
    expect(options.planPath).toBe(path.resolve('/plan.json'));
    expect(options.userId).toBe('user-5');
    expect(options.seriesIds).toEqual(['a', 'b', 'c']);
    expect(options.force).toBe(true);
    expect(options.apply).toBe(false);
  });
});
