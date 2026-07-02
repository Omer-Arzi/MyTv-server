-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportIssueSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR');

-- AlterTable
ALTER TABLE "Episode" ADD COLUMN     "importBatchId" TEXT,
ADD COLUMN     "rawMetadata" JSONB,
ALTER COLUMN "title" DROP NOT NULL;

-- AlterTable
ALTER TABLE "EpisodeNote" ADD COLUMN     "importBatchId" TEXT,
ADD COLUMN     "rawMetadata" JSONB;

-- AlterTable
ALTER TABLE "EpisodeWatch" ADD COLUMN     "importBatchId" TEXT,
ADD COLUMN     "rawMetadata" JSONB,
ADD COLUMN     "rewatchCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "watchDateApproximate" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Series" ADD COLUMN     "importBatchId" TEXT,
ADD COLUMN     "rawMetadata" JSONB;

-- AlterTable
ALTER TABLE "WatchlistItem" ADD COLUMN     "importBatchId" TEXT,
ADD COLUMN     "rawMetadata" JSONB;

-- CreateTable
CREATE TABLE "EpisodeRating" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "rawValue" INTEGER NOT NULL,
    "normalizedValue" DECIMAL(3,1),
    "rawMetadata" JSONB,
    "importBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EpisodeRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EpisodeEmotion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "rawValue" INTEGER NOT NULL,
    "normalizedEmotion" TEXT,
    "rawMetadata" JSONB,
    "importBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EpisodeEmotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeriesRating" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "value" DECIMAL(3,2) NOT NULL,
    "rawMetadata" JSONB,
    "importBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeriesRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "skippedFiles" JSONB,
    "notes" TEXT,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRawRow" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "sourceFile" TEXT NOT NULL,
    "sourceRowNumber" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "resolvedEntityType" TEXT,
    "resolvedEntityId" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportRawRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportIssue" (
    "id" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "severity" "ImportIssueSeverity" NOT NULL,
    "sourceFile" TEXT,
    "sourceRowNumber" INTEGER,
    "relatedEntityType" TEXT,
    "relatedEntityId" TEXT,
    "message" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EpisodeRating_episodeId_idx" ON "EpisodeRating"("episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeRating_userId_episodeId_key" ON "EpisodeRating"("userId", "episodeId");

-- CreateIndex
CREATE INDEX "EpisodeEmotion_episodeId_idx" ON "EpisodeEmotion"("episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeEmotion_userId_episodeId_rawValue_key" ON "EpisodeEmotion"("userId", "episodeId", "rawValue");

-- CreateIndex
CREATE INDEX "SeriesRating_seriesId_idx" ON "SeriesRating"("seriesId");

-- CreateIndex
CREATE UNIQUE INDEX "SeriesRating_userId_seriesId_key" ON "SeriesRating"("userId", "seriesId");

-- CreateIndex
CREATE INDEX "ImportRawRow_importBatchId_sourceFile_idx" ON "ImportRawRow"("importBatchId", "sourceFile");

-- CreateIndex
CREATE INDEX "ImportRawRow_resolvedEntityType_resolvedEntityId_idx" ON "ImportRawRow"("resolvedEntityType", "resolvedEntityId");

-- CreateIndex
CREATE INDEX "ImportIssue_importBatchId_resolved_idx" ON "ImportIssue"("importBatchId", "resolved");

-- CreateIndex
CREATE INDEX "ImportIssue_relatedEntityType_relatedEntityId_idx" ON "ImportIssue"("relatedEntityType", "relatedEntityId");

-- AddForeignKey
ALTER TABLE "EpisodeRating" ADD CONSTRAINT "EpisodeRating_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpisodeRating" ADD CONSTRAINT "EpisodeRating_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpisodeEmotion" ADD CONSTRAINT "EpisodeEmotion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpisodeEmotion" ADD CONSTRAINT "EpisodeEmotion_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeriesRating" ADD CONSTRAINT "SeriesRating_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeriesRating" ADD CONSTRAINT "SeriesRating_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "Series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRawRow" ADD CONSTRAINT "ImportRawRow_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportIssue" ADD CONSTRAINT "ImportIssue_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
