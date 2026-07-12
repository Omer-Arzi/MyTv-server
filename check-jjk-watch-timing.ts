import { PrismaClient } from '@prisma/client';
const DEV_USER_ID = '00000000-0000-4000-8000-000000000001';
async function main() {
  const prisma = new PrismaClient();
  const seasons = await prisma.season.findMany({
    where: { seriesId: '84252f12-3915-4ea4-bd9c-ba132816df36' },
    include: { episodes: { include: { watches: { where: { userId: DEV_USER_ID } } } } },
    orderBy: { seasonNumber: 'asc' },
  });
  for (const season of seasons) {
    if (season.seasonNumber === 1) {
      console.log('--- Season 1, episodes 45-59 (the "Culling Game" range) ---');
      for (const ep of season.episodes.filter(e => e.episodeNumber >= 45).sort((a,b)=>a.episodeNumber-b.episodeNumber)) {
        console.log(`  E${ep.episodeNumber} "${ep.title}" watchedAt=${ep.watches[0]?.watchedAt?.toISOString() ?? 'NOT WATCHED'}`);
      }
    } else {
      console.log(`--- Season ${season.seasonNumber} (orphan stub) ---`);
      for (const ep of season.episodes.sort((a,b)=>a.episodeNumber-b.episodeNumber)) {
        console.log(`  E${ep.episodeNumber} id=${ep.id} watchedAt=${ep.watches[0]?.watchedAt?.toISOString() ?? 'NOT WATCHED'}`);
      }
    }
  }
  await prisma.$disconnect();
}
main();
