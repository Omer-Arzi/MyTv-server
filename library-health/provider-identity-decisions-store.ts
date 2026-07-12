// The one place both the CLI pipeline and the in-app Migration Workbench
// read/write provider identity decisions — the ProviderIdentityDecision
// table (prisma/schema.prisma) is the live source of truth as of the
// stable-version migration policy work; library-health/
// provider-confirmation-decisions.json is a historical, one-time-backfilled
// artifact only (see run-backfill-provider-decisions.ts), never read live
// by either caller anymore. Kept as its own small I/O module — not a
// *-logic.ts pure file — so both callers import the exact same Prisma
// queries instead of each writing their own.

import { PrismaClient } from '@prisma/client';
import { ProviderConfirmationDecision, ProviderConfirmationDecisionType, SupportedProvider } from './provider-confirmation-decisions-logic';

export async function loadDecisionsFromDb(prisma: PrismaClient, userId: string): Promise<ProviderConfirmationDecision[]> {
  const rows = await prisma.providerIdentityDecision.findMany({ where: { userId }, include: { series: { select: { title: true } } } });
  return rows.map((row) => ({
    title: row.series.title,
    decision: row.decision as ProviderConfirmationDecisionType,
    provider: (row.provider ?? undefined) as SupportedProvider | undefined,
    providerId: row.providerId ?? undefined,
    migrationIntent: row.migrationIntent,
    statusOverride: (row.statusOverride ?? undefined) as ProviderConfirmationDecision['statusOverride'],
    seasonShrinkReviewed: row.seasonShrinkReviewed,
    source: row.source,
    notes: row.notes ?? undefined,
  }));
}

export interface FindDecisionForSeriesResult {
  decision: ProviderConfirmationDecision | null;
  // True when a row exists in the DB at all (regardless of its
  // decision value) — lets a caller distinguish "no decision recorded"
  // from "recorded, but not a confirm."
  hasRecord: boolean;
}

// Single-series lookup used by the live proposal/confirm/candidate-search
// endpoints — avoids loading and mapping the whole decisions table for a
// one-series request.
export async function findDecisionForSeries(prisma: PrismaClient, userId: string, seriesId: string): Promise<FindDecisionForSeriesResult> {
  const row = await prisma.providerIdentityDecision.findUnique({ where: { userId_seriesId: { userId, seriesId } }, include: { series: { select: { title: true } } } });
  if (!row) return { decision: null, hasRecord: false };
  return {
    hasRecord: true,
    decision: {
      title: row.series.title,
      decision: row.decision as ProviderConfirmationDecisionType,
      provider: (row.provider ?? undefined) as SupportedProvider | undefined,
      providerId: row.providerId ?? undefined,
      migrationIntent: row.migrationIntent,
      statusOverride: (row.statusOverride ?? undefined) as ProviderConfirmationDecision['statusOverride'],
      seasonShrinkReviewed: row.seasonShrinkReviewed,
      source: row.source,
      notes: row.notes ?? undefined,
    },
  };
}

export interface SaveProviderIdentityDecisionInput {
  userId: string;
  seriesId: string;
  provider: SupportedProvider;
  providerId: string;
  // Normalized 0..1 — the same canonical scale as ProviderCandidateDto.confidenceScore
  // and ConfirmIdentityDto.confidence. Callers must pass the value through
  // unmodified from the candidate the user selected, never re-derive or
  // rescale it here.
  confidence: number;
  notes?: string;
}

// Persists an explicit in-app identity confirmation — the app-side
// counterpart to hand-editing provider-confirmation-decisions.json.
// Always writes decision: 'confirm' (the only decision an app user can
// make through this flow; 'skip'/'defer' stay CLI-only, matching this
// pipeline's existing human-review posture). source: 'app-confirmation'
// distinguishes it from a JSON-backfilled row on read.
export async function saveProviderIdentityDecision(prisma: PrismaClient, input: SaveProviderIdentityDecisionInput) {
  return prisma.providerIdentityDecision.upsert({
    where: { userId_seriesId: { userId: input.userId, seriesId: input.seriesId } },
    create: {
      userId: input.userId,
      seriesId: input.seriesId,
      decision: 'confirm',
      provider: input.provider,
      providerId: input.providerId,
      confidence: input.confidence,
      notes: input.notes,
      source: 'app-confirmation',
    },
    update: {
      decision: 'confirm',
      provider: input.provider,
      providerId: input.providerId,
      confidence: input.confidence,
      notes: input.notes,
      source: 'app-confirmation',
    },
  });
}

export class NoDecisionToReviewError extends Error {
  constructor(seriesId: string) {
    super(`No confirmed provider identity decision exists for series ${seriesId} — cannot review a season-shrink pattern without one.`);
    this.name = 'NoDecisionToReviewError';
  }
}

// The one, explicit, separate-from-identity-confirmation action that sets
// seasonShrinkReviewed — see migration-confirmation-logic.ts's
// classifyMigrationConfirmation for what this specifically unlocks (ONLY
// the realSeasonShrinkDetected hard floor; every other safety floor is
// untouched). Never bundled into confirmIdentity/saveProviderIdentityDecision
// above — per this task's explicit requirement, confirming identity must
// never automatically imply season-shrink review too. Requires a decision
// to already exist and be 'confirm' — reviewing a season-shrink pattern
// without a confirmed identity first makes no sense (there's no candidate
// catalog to compare shapes against). Deliberately does NOT set
// statusOverride — the resulting status is left to migration mode's own
// default (carry the current status forward), matching this app's
// "no manual status picker" posture (see MigrationProposalScreen).
export async function reviewSeasonShrinkForDecision(prisma: PrismaClient, userId: string, seriesId: string) {
  const existing = await prisma.providerIdentityDecision.findUnique({ where: { userId_seriesId: { userId, seriesId } } });
  if (!existing || existing.decision !== 'confirm') {
    throw new NoDecisionToReviewError(seriesId);
  }
  return prisma.providerIdentityDecision.update({
    where: { userId_seriesId: { userId, seriesId } },
    data: { migrationIntent: true, seasonShrinkReviewed: true },
  });
}
