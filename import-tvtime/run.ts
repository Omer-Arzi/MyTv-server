import path from 'path';
import { ImportStatus, Prisma, PrismaClient } from '@prisma/client';
import { runRawImport } from './raw-import';
import { normalizeWatchedEpisodes } from './normalize-watched-episodes';
import { buildImportReport, buildNeedsReview, buildSkippedSensitiveFields, writeReports } from './report';
import { SENSITIVE_EXCLUDED_FILES } from './denylist';
import { DEV_USER_ID } from '../src/common/constants';

const DEFAULT_SOURCE_DIR = path.join(__dirname, '..', 'tvtime-export');
const DEFAULT_OUT_DIR = path.join(__dirname, 'output');
const IMPORT_SOURCE_NAME = 'tvtime-export';

interface CliOptions {
  dryRun: boolean;
  sourceDir: string;
  userId: string;
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    sourceDir: DEFAULT_SOURCE_DIR,
    userId: DEV_USER_ID,
    outDir: DEFAULT_OUT_DIR,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--dir=')) options.sourceDir = path.resolve(arg.slice('--dir='.length));
    else if (arg.startsWith('--user=')) options.userId = arg.slice('--user='.length);
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
  }

  return options;
}

// Thrown deliberately at the end of the transaction in dry-run mode so
// Prisma rolls back every write, while still letting us read out the report
// data that was computed inside the transaction before it unwinds.
class DryRunRollback extends Error {
  constructor(public readonly reportData: unknown) {
    super('dry-run: rolling back transaction');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  const startedAt = new Date();

  console.log(`TV Time importer — source: ${options.sourceDir}`);
  console.log(`  target user: ${options.userId}`);
  console.log(`  dry run: ${options.dryRun}`);

  let reportBundle:
    | { importReport: unknown; needsReview: unknown; skippedSensitiveFields: unknown; importBatchId: string }
    | undefined;

  try {
    await prisma.$transaction(
      async (tx) => {
        const batch = await tx.importBatch.create({
          data: { source: IMPORT_SOURCE_NAME, status: ImportStatus.RUNNING, startedAt },
        });

        const rawImport = await runRawImport(tx, batch.id, options.sourceDir);
        const normalize = await normalizeWatchedEpisodes(tx, batch.id, options.userId);
        const finishedAt = new Date();

        await tx.importIssue.createMany({
          data: normalize.issues.map((issue) => ({
            importBatchId: batch.id,
            severity: issue.severity,
            sourceFile: issue.sourceFile,
            sourceRowNumber: issue.sourceRowNumber,
            relatedEntityType: issue.relatedEntityType,
            relatedEntityId: issue.relatedEntityId,
            message: issue.message,
          })),
        });

        await tx.importBatch.update({
          where: { id: batch.id },
          data: {
            status: options.dryRun ? ImportStatus.FAILED : ImportStatus.COMPLETED,
            finishedAt,
            notes: options.dryRun ? 'dry run — rolled back, no data persisted' : null,
            skippedFiles: SENSITIVE_EXCLUDED_FILES as unknown as Prisma.InputJsonValue,
          },
        });

        const importReport = buildImportReport({
          importBatchId: batch.id,
          source: IMPORT_SOURCE_NAME,
          sourceDir: options.sourceDir,
          userId: options.userId,
          dryRun: options.dryRun,
          startedAt,
          finishedAt,
          rawImport,
          normalize,
        });
        const needsReview = buildNeedsReview(normalize.issues);
        const skippedSensitiveFields = buildSkippedSensitiveFields(rawImport);

        const bundle = { importReport, needsReview, skippedSensitiveFields, importBatchId: batch.id };

        if (options.dryRun) {
          throw new DryRunRollback(bundle);
        }

        reportBundle = bundle;
      },
      // This is a one-off, manually-run bulk import over tens of thousands
      // of source rows across thousands of distinct episodes — generous on
      // purpose, unlike a request-path transaction.
      { timeout: 600_000, maxWait: 30_000 },
    );
  } catch (err) {
    if (err instanceof DryRunRollback) {
      reportBundle = err.reportData as typeof reportBundle;
    } else {
      await prisma.$disconnect();
      throw err;
    }
  }

  if (!reportBundle) {
    throw new Error('importer produced no report — this is a bug');
  }

  const batchDir = writeReports(options.outDir, reportBundle.importBatchId, reportBundle);

  console.log(`\nDone. Reports written to ${batchDir}`);
  console.log(JSON.stringify((reportBundle.importReport as { normalize: unknown }).normalize, null, 2));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
