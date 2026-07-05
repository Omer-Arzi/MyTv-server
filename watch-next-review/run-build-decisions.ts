// Generates/updates watch-next-decisions.json from the most recent
// watch-next-manual-review.json. Pure prefill — see build-decisions.ts for
// exactly which category maps to which default decision. Never touches the
// database; this only reads/writes JSON files.

import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { buildDecisions, ReviewItemForDecision } from './build-decisions';

const DEFAULT_OUT_DIR = path.join(__dirname, 'output');
const DEFAULT_REVIEW_PATH = path.join(DEFAULT_OUT_DIR, 'watch-next-manual-review.json');
const DEFAULT_DECISIONS_PATH = path.join(DEFAULT_OUT_DIR, 'watch-next-decisions.json');

interface CliOptions {
  reviewPath: string;
  decisionsPath: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { reviewPath: DEFAULT_REVIEW_PATH, decisionsPath: DEFAULT_DECISIONS_PATH };
  for (const arg of argv) {
    if (arg.startsWith('--review=')) options.reviewPath = path.resolve(arg.slice('--review='.length));
    else if (arg.startsWith('--out=')) options.decisionsPath = path.resolve(arg.slice('--out='.length));
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(options.reviewPath)) {
    console.error(`Review file not found: ${options.reviewPath} — run run-watch-next-review.ts first.`);
    process.exit(1);
  }

  const review = JSON.parse(readFileSync(options.reviewPath, 'utf-8'));
  const items: ReviewItemForDecision[] = review.items ?? [];

  const decisions = buildDecisions(items);
  const counts: Record<string, number> = {};
  for (const d of decisions) counts[d.decision] = (counts[d.decision] ?? 0) + 1;

  const output = {
    generatedAt: new Date().toISOString(),
    sourceReviewPath: options.reviewPath,
    writesToAppTables: false,
    summary: { totalItems: decisions.length, byDecision: counts },
    decisions,
  };

  writeFileSync(options.decisionsPath, JSON.stringify(output, null, 2));

  console.log(`Prefilled ${decisions.length} decisions from ${options.reviewPath}`);
  console.log(JSON.stringify(counts, null, 2));
  console.log(`\nWrote ${options.decisionsPath}`);
}

main();
