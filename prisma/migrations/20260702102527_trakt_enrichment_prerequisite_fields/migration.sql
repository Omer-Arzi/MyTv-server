-- AlterTable
ALTER TABLE "Episode" ADD COLUMN     "imageUrl" TEXT;

-- AlterTable
ALTER TABLE "ExternalIds" ADD COLUMN     "matchConfidence" DOUBLE PRECISION,
ADD COLUMN     "matchSource" TEXT,
ADD COLUMN     "matchedAt" TIMESTAMP(3),
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "providerId" TEXT,
ADD COLUMN     "rawMetadata" JSONB;

-- AlterTable
ALTER TABLE "Season" ADD COLUMN     "importBatchId" TEXT,
ADD COLUMN     "rawMetadata" JSONB;

-- AlterTable
ALTER TABLE "Series" ADD COLUMN     "backdropUrl" TEXT;
