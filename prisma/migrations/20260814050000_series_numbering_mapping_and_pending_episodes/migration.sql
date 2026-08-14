-- CreateTable
CREATE TABLE "SeriesNumberingMapping" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "providerSeasonNumber" INTEGER NOT NULL,
    "providerEpisodeStart" INTEGER NOT NULL,
    "providerEpisodeEnd" INTEGER,
    "localSeasonNumber" INTEGER NOT NULL,
    "localEpisodeOffset" INTEGER NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedBy" TEXT,

    CONSTRAINT "SeriesNumberingMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingProviderEpisode" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "tmdbEpisodeId" INTEGER NOT NULL,
    "providerSeasonNumber" INTEGER NOT NULL,
    "providerEpisodeNumber" INTEGER NOT NULL,
    "title" TEXT,
    "overview" TEXT,
    "airDate" TIMESTAMP(3),
    "imageUrl" TEXT,
    "runtimeMinutes" INTEGER,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingProviderEpisode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SeriesNumberingMapping_seriesId_providerSeasonNumber_provid_key" ON "SeriesNumberingMapping"("seriesId", "providerSeasonNumber", "providerEpisodeStart");

-- CreateIndex
CREATE UNIQUE INDEX "PendingProviderEpisode_tmdbEpisodeId_key" ON "PendingProviderEpisode"("tmdbEpisodeId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingProviderEpisode_seriesId_providerSeasonNumber_provid_key" ON "PendingProviderEpisode"("seriesId", "providerSeasonNumber", "providerEpisodeNumber");

-- AddForeignKey
ALTER TABLE "SeriesNumberingMapping" ADD CONSTRAINT "SeriesNumberingMapping_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "Series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingProviderEpisode" ADD CONSTRAINT "PendingProviderEpisode_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "Series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

