-- CreateEnum
CREATE TYPE "SyncTrigger" AS ENUM ('SCHEDULED', 'MANUAL_SERIES', 'MANUAL_LIBRARY', 'SERIES_PAGE_STALE', 'LOCAL_RELEASE_ACTIVATION');

-- CreateEnum
CREATE TYPE "LibraryRefreshJobStatus" AS ENUM ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED');

-- AlterTable
ALTER TABLE "SeriesSyncStatus" ADD COLUMN     "lastChangeAt" TIMESTAMP(3),
ADD COLUMN     "lastEpisodesAdded" INTEGER,
ADD COLUMN     "lastLocalActivationAt" TIMESTAMP(3),
ADD COLUMN     "lastRefreshTrigger" "SyncTrigger",
ADD COLUMN     "lastRequiresManualReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastSeasonsAdded" INTEGER,
ADD COLUMN     "refreshInProgress" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "refreshStartedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "LibraryRefreshJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "LibraryRefreshJobStatus" NOT NULL DEFAULT 'RUNNING',
    "triggeredBy" "SyncTrigger" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "totalSeries" INTEGER NOT NULL,
    "checkedSeries" INTEGER NOT NULL DEFAULT 0,
    "seriesWithNewEpisodes" INTEGER NOT NULL DEFAULT 0,
    "seriesWithNewSeasons" INTEGER NOT NULL DEFAULT 0,
    "seriesFailed" INTEGER NOT NULL DEFAULT 0,
    "seriesManualReview" INTEGER NOT NULL DEFAULT 0,
    "seriesActivatedLocally" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "LibraryRefreshJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LibraryRefreshJob_userId_startedAt_idx" ON "LibraryRefreshJob"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "LibraryRefreshJob_userId_status_idx" ON "LibraryRefreshJob"("userId", "status");

-- CreateIndex
CREATE INDEX "SeriesSyncStatus_refreshInProgress_idx" ON "SeriesSyncStatus"("refreshInProgress");

-- AddForeignKey
ALTER TABLE "LibraryRefreshJob" ADD CONSTRAINT "LibraryRefreshJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
