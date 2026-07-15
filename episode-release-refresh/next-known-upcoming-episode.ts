// Small, reusable I/O helper — the one place that answers "what's the
// earliest known-but-not-yet-released local episode airDate for this
// series" (smart-scheduling-policy.ts's nextKnownUpcomingAirDate input).
// Deliberately a LIVE query, called AFTER a refresh attempt (whether it
// inserted anything or not) so a just-discovered upcoming episode
// immediately informs the next scheduling decision, rather than reasoning
// from a pre-refresh snapshot.

import { PrismaClient } from '@prisma/client';

export async function loadNextKnownUpcomingAirDate(prisma: PrismaClient, seriesId: string, now: Date = new Date()): Promise<Date | null> {
  const episode = await prisma.episode.findFirst({
    where: { season: { seriesId }, airDate: { gt: now } },
    orderBy: { airDate: 'asc' },
    select: { airDate: true },
  });
  return episode?.airDate ?? null;
}
