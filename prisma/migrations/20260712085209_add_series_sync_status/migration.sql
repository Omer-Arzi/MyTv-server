-- CreateTable
CREATE TABLE "SeriesSyncStatus" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "lastEpisodeRefreshAt" TIMESTAMP(3),
    "lastEpisodeRefreshStatus" TEXT,
    "lastEpisodeRefreshError" TEXT,
    "lastSuccessfulRefreshAt" TIMESTAMP(3),
    "lastProviderCheckAt" TIMESTAMP(3),
    "numberOfFailures" INTEGER NOT NULL DEFAULT 0,
    "lastSyncDurationMs" INTEGER,
    "nextEligibleRefreshAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeriesSyncStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SeriesSyncStatus_seriesId_key" ON "SeriesSyncStatus"("seriesId");

-- CreateIndex
CREATE INDEX "SeriesSyncStatus_nextEligibleRefreshAt_idx" ON "SeriesSyncStatus"("nextEligibleRefreshAt");

-- AddForeignKey
ALTER TABLE "SeriesSyncStatus" ADD CONSTRAINT "SeriesSyncStatus_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "Series"("id") ON DELETE CASCADE ON UPDATE CASCADE;
