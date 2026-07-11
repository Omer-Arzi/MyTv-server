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
      notes: row.notes ?? undefined,
    },
  };
}

export interface SaveProviderIdentityDecisionInput {
  userId: string;
  seriesId: string;
  provider: SupportedProvider;
  providerId: string;
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
