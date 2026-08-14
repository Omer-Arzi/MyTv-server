// Integration test for Phase 5 of the episode-identity architecture work
// (docs/episode-numbering-and-season-shift-risk.md): proves
// MigrationWorkbenchService.createNumberingMapping's real DB behavior —
// creating a mapping, promoting covered pending episodes into real Episode
// rows via the shared season-episode-writer path, and leaving uncovered
// pending episodes untouched — against real Postgres, same throwaway-fixture
// convention as this project's other integration tests.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Series, User } from '@prisma/client';
import { MigrationWorkbenchService } from '../migration-workbench.service';
import { PrismaService } from '../../../prisma/prisma.service';

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('MigrationWorkbenchService.createNumberingMapping / listPendingEpisodes (integration, real Postgres)', () => {
  const prisma = new PrismaService();
  const service = new MigrationWorkbenchService(prisma);
  const createdUserIds: string[] = [];
  const createdSeriesIds: string[] = [];

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    for (const seriesId of createdSeriesIds.splice(0)) {
      await prisma.series.deleteMany({ where: { id: seriesId } });
    }
    for (const userId of createdUserIds.splice(0)) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });

  async function createFixtureUser(): Promise<User> {
    const user = await prisma.user.create({ data: { email: `numbering-mapping-test-${randomUUID()}@example.com`, displayName: 'Numbering Mapping Test User' } });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeries(): Promise<Series> {
    const series = await prisma.series.create({ data: { title: `Numbering Mapping Test Series ${randomUUID()}` } });
    createdSeriesIds.push(series.id);
    return series;
  }

  it('creates the mapping, promotes covered pending episodes into real Episode rows, and deletes the promoted pending rows', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();

    await prisma.pendingProviderEpisode.create({
      data: { seriesId: series.id, tmdbEpisodeId: 7130159, providerSeasonNumber: 1, providerEpisodeNumber: 79, title: 'Episode 79', airDate: new Date('2026-08-19') },
    });
    // Not covered by the mapping below — must stay pending.
    await prisma.pendingProviderEpisode.create({ data: { seriesId: series.id, tmdbEpisodeId: 999, providerSeasonNumber: 2, providerEpisodeNumber: 1, title: 'Unrelated' } });

    const result = await service.createNumberingMapping(user.id, series.id, {
      providerSeasonNumber: 1,
      providerEpisodeStart: 79,
      providerEpisodeEnd: null,
      localSeasonNumber: 5,
      localEpisodeOffset: 78,
    });

    expect(result.episodesPromoted).toBe(1);
    expect(result.episodeIds).toHaveLength(1);

    const mapping = await prisma.seriesNumberingMapping.findUniqueOrThrow({ where: { id: result.mappingId } });
    expect(mapping).toMatchObject({ seriesId: series.id, providerSeasonNumber: 1, providerEpisodeStart: 79, providerEpisodeEnd: null, localSeasonNumber: 5, localEpisodeOffset: 78, confirmedBy: user.id });

    const newSeason = await prisma.season.findFirstOrThrow({ where: { seriesId: series.id, seasonNumber: 5 }, include: { episodes: true } });
    expect(newSeason.episodes).toHaveLength(1);
    expect(newSeason.episodes[0]).toMatchObject({ episodeNumber: 1, title: 'Episode 79', tmdbEpisodeId: 7130159 });

    const remainingPending = await prisma.pendingProviderEpisode.findMany({ where: { seriesId: series.id } });
    expect(remainingPending).toHaveLength(1);
    expect(remainingPending[0].tmdbEpisodeId).toBe(999);
  });

  it('creates the mapping with zero promotions when no pending episode is covered', async () => {
    const user = await createFixtureUser();
    const series = await createFixtureSeries();

    const result = await service.createNumberingMapping(user.id, series.id, { providerSeasonNumber: 1, providerEpisodeStart: 79, providerEpisodeEnd: null, localSeasonNumber: 5, localEpisodeOffset: 78 });

    expect(result.episodesPromoted).toBe(0);
    expect(result.episodeIds).toEqual([]);

    const mapping = await prisma.seriesNumberingMapping.findUniqueOrThrow({ where: { id: result.mappingId } });
    expect(mapping.localSeasonNumber).toBe(5);
  });

  it('lists pending episodes across series, including the series title', async () => {
    const series = await createFixtureSeries();
    await prisma.pendingProviderEpisode.create({ data: { seriesId: series.id, tmdbEpisodeId: 12345, providerSeasonNumber: 1, providerEpisodeNumber: 79, title: 'Episode 79' } });

    const result = await service.listPendingEpisodes();

    const entry = result.find((r) => r.seriesId === series.id);
    expect(entry).toMatchObject({ seriesTitle: series.title, tmdbEpisodeId: 12345, providerSeasonNumber: 1, providerEpisodeNumber: 79, title: 'Episode 79' });
  });

  it('throws NotFoundException for a series that does not exist', async () => {
    const user = await createFixtureUser();

    await expect(service.createNumberingMapping(user.id, randomUUID(), { providerSeasonNumber: 1, providerEpisodeStart: 1, providerEpisodeEnd: null, localSeasonNumber: 1, localEpisodeOffset: 0 })).rejects.toThrow(
      'not found',
    );
  });
});
