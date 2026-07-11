-- CreateTable
CREATE TABLE "ProviderIdentityDecision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "provider" TEXT,
    "providerId" TEXT,
    "migrationIntent" BOOLEAN NOT NULL DEFAULT false,
    "statusOverride" TEXT,
    "notes" TEXT,
    "source" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderIdentityDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "seriesTitle" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "classification" TEXT NOT NULL,
    "sourceCategory" TEXT NOT NULL,
    "providerBefore" JSONB,
    "providerAfter" JSONB NOT NULL,
    "releaseStatusBefore" TEXT,
    "releaseStatusAfter" TEXT,
    "userStatusBefore" TEXT NOT NULL,
    "userStatusAfter" TEXT NOT NULL,
    "nextEpisodeIdBefore" TEXT,
    "nextEpisodeIdAfter" TEXT,
    "episodesInsertedIds" JSONB NOT NULL,
    "episodesUpdatedIds" JSONB NOT NULL,
    "preservedOrphanEpisodeIds" JSONB NOT NULL,
    "watchedMappingCount" INTEGER NOT NULL,
    "verificationPassed" BOOLEAN NOT NULL,
    "verificationDetail" JSONB NOT NULL,
    "rolledBackAt" TIMESTAMP(3),
    "rollbackReason" TEXT,

    CONSTRAINT "MigrationHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderIdentityDecision_userId_decision_idx" ON "ProviderIdentityDecision"("userId", "decision");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderIdentityDecision_userId_seriesId_key" ON "ProviderIdentityDecision"("userId", "seriesId");

-- CreateIndex
CREATE INDEX "MigrationHistory_userId_seriesId_idx" ON "MigrationHistory"("userId", "seriesId");

-- CreateIndex
CREATE INDEX "MigrationHistory_userId_appliedAt_idx" ON "MigrationHistory"("userId", "appliedAt");

-- AddForeignKey
ALTER TABLE "ProviderIdentityDecision" ADD CONSTRAINT "ProviderIdentityDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderIdentityDecision" ADD CONSTRAINT "ProviderIdentityDecision_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "Series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationHistory" ADD CONSTRAINT "MigrationHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationHistory" ADD CONSTRAINT "MigrationHistory_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "Series"("id") ON DELETE CASCADE ON UPDATE CASCADE;
