import path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { readCsvFile } from './csv';
import { listCsvFiles } from './fs-utils';
import { ExcludedFile, redactRow, SENSITIVE_EXCLUDED_FILES, SENSITIVE_EXCLUDED_FILENAMES } from './denylist';

type PrismaTx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

const CHUNK_SIZE = 1000;

export interface RedactedFieldCount {
  field: string;
  rowCount: number;
}

export interface RawImportFileResult {
  file: string;
  rowsRead: number;
  rowsImported: number;
  fieldsRedacted: RedactedFieldCount[];
}

export interface RawImportResult {
  importedFiles: RawImportFileResult[];
  excludedFiles: ExcludedFile[];
  totalRowsRead: number;
  totalRowsImported: number;
}

// Phase 1: walk every CSV in sourceDir, skip anything on the sensitive-file
// denylist entirely, redact sensitive columns from everything else, and
// bulk-write the result into ImportRawRow under this batch. Never re-reads
// or re-derives anything beyond this — Phase 2 (normalize-watched-episodes)
// reads back from ImportRawRow, not from the CSVs again, per
// docs/mytv-prisma-schema-plan.md §3.
export async function runRawImport(tx: PrismaTx, importBatchId: string, sourceDir: string): Promise<RawImportResult> {
  const allFiles = listCsvFiles(sourceDir);
  const excludedFiles: ExcludedFile[] = [];
  const importedFiles: RawImportFileResult[] = [];
  let totalRowsRead = 0;
  let totalRowsImported = 0;

  for (const filePath of allFiles) {
    const fileName = path.basename(filePath);

    if (SENSITIVE_EXCLUDED_FILENAMES.has(fileName)) {
      const entry = SENSITIVE_EXCLUDED_FILES.find((f) => f.file === fileName);
      if (entry) excludedFiles.push(entry);
      continue;
    }

    const { rows } = readCsvFile(filePath);
    totalRowsRead += rows.length;

    const redactedCounts = new Map<string, number>();
    const records: Prisma.ImportRawRowCreateManyInput[] = rows.map((row, index) => {
      const { redacted, removedFields } = redactRow(row);
      for (const field of removedFields) {
        redactedCounts.set(field, (redactedCounts.get(field) ?? 0) + 1);
      }
      return {
        importBatchId,
        sourceFile: fileName,
        sourceRowNumber: index + 1,
        payload: redacted as Prisma.InputJsonValue,
      };
    });

    for (let i = 0; i < records.length; i += CHUNK_SIZE) {
      const chunk = records.slice(i, i + CHUNK_SIZE);
      if (chunk.length > 0) {
        await tx.importRawRow.createMany({ data: chunk });
      }
    }

    totalRowsImported += records.length;
    importedFiles.push({
      file: fileName,
      rowsRead: rows.length,
      rowsImported: records.length,
      fieldsRedacted: [...redactedCounts.entries()].map(([field, rowCount]) => ({ field, rowCount })),
    });
  }

  return { importedFiles, excludedFiles, totalRowsRead, totalRowsImported };
}
