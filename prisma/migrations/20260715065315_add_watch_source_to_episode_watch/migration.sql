-- CreateEnum
CREATE TYPE "WatchSource" AS ENUM ('SINGLE', 'BATCH');

-- AlterTable
ALTER TABLE "EpisodeWatch" ADD COLUMN     "watchSource" "WatchSource" NOT NULL DEFAULT 'SINGLE';
