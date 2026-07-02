-- CreateEnum
CREATE TYPE "SeriesStatus" AS ENUM ('ONGOING', 'ENDED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ProgressStatus" AS ENUM ('WATCHING', 'COMPLETED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Series" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "overview" TEXT,
    "posterUrl" TEXT,
    "status" "SeriesStatus" NOT NULL DEFAULT 'ONGOING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "title" TEXT,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Episode" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "episodeNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "overview" TEXT,
    "airDate" TIMESTAMP(3),
    "runtimeMinutes" INTEGER,

    CONSTRAINT "Episode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSeriesProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "status" "ProgressStatus" NOT NULL DEFAULT 'WATCHING',
    "lastWatchedAt" TIMESTAMP(3),
    "nextEpisodeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSeriesProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EpisodeWatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "watchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EpisodeWatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EpisodeNote" (
    "id" TEXT NOT NULL,
    "episodeWatchId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EpisodeNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchlistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalIds" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "traktId" TEXT,
    "tmdbId" TEXT,
    "imdbId" TEXT,

    CONSTRAINT "ExternalIds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Season_seriesId_seasonNumber_key" ON "Season"("seriesId", "seasonNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Episode_seasonId_episodeNumber_key" ON "Episode"("seasonId", "episodeNumber");

-- CreateIndex
CREATE INDEX "UserSeriesProgress_userId_status_lastWatchedAt_idx" ON "UserSeriesProgress"("userId", "status", "lastWatchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserSeriesProgress_userId_seriesId_key" ON "UserSeriesProgress"("userId", "seriesId");

-- CreateIndex
CREATE INDEX "EpisodeWatch_userId_watchedAt_idx" ON "EpisodeWatch"("userId", "watchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeWatch_userId_episodeId_key" ON "EpisodeWatch"("userId", "episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeNote_episodeWatchId_key" ON "EpisodeNote"("episodeWatchId");

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistItem_userId_seriesId_key" ON "WatchlistItem"("userId", "seriesId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIds_seriesId_key" ON "ExternalIds"("seriesId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIds_traktId_key" ON "ExternalIds"("traktId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIds_tmdbId_key" ON "ExternalIds"("tmdbId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIds_imdbId_key" ON "ExternalIds"("imdbId");

-- AddForeignKey
ALTER TABLE "Season" ADD CONSTRAINT "Season_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "Series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Episode" ADD CONSTRAINT "Episode_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSeriesProgress" ADD CONSTRAINT "UserSeriesProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSeriesProgress" ADD CONSTRAINT "UserSeriesProgress_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "Series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSeriesProgress" ADD CONSTRAINT "UserSeriesProgress_nextEpisodeId_fkey" FOREIGN KEY ("nextEpisodeId") REFERENCES "Episode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpisodeWatch" ADD CONSTRAINT "EpisodeWatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpisodeWatch" ADD CONSTRAINT "EpisodeWatch_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpisodeNote" ADD CONSTRAINT "EpisodeNote_episodeWatchId_fkey" FOREIGN KEY ("episodeWatchId") REFERENCES "EpisodeWatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "Series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIds" ADD CONSTRAINT "ExternalIds_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "Series"("id") ON DELETE CASCADE ON UPDATE CASCADE;
