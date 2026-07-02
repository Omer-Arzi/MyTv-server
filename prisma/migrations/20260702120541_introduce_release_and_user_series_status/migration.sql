-- CreateEnum
CREATE TYPE "ReleaseStatus" AS ENUM ('UNKNOWN', 'RETURNING', 'ENDED', 'CANCELLED', 'IN_PRODUCTION');

-- CreateEnum
CREATE TYPE "UserSeriesStatus" AS ENUM ('UNKNOWN', 'WATCHLIST', 'WATCHING', 'PAUSED', 'DROPPED', 'CAUGHT_UP', 'COMPLETED');

-- DropIndex
DROP INDEX "UserSeriesProgress_userId_status_lastWatchedAt_idx";

-- AlterTable
ALTER TABLE "Series" DROP COLUMN "status",
ADD COLUMN     "releaseStatus" "ReleaseStatus" NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE "UserSeriesProgress" DROP COLUMN "status",
ADD COLUMN     "userStatus" "UserSeriesStatus" NOT NULL DEFAULT 'UNKNOWN';

-- DropEnum
DROP TYPE "ProgressStatus";

-- DropEnum
DROP TYPE "SeriesStatus";

-- CreateIndex
CREATE INDEX "UserSeriesProgress_userId_userStatus_lastWatchedAt_idx" ON "UserSeriesProgress"("userId", "userStatus", "lastWatchedAt");
