import { ReleaseStatus } from '@prisma/client';
import { toEpisodeSummary, toSeriesSummary } from '../mappers';

describe('toSeriesSummary', () => {
  it('includes backdropUrl alongside posterUrl', () => {
    const dto = toSeriesSummary({
      id: 's1',
      title: 'Frieren: Beyond Journey\'s End',
      overview: 'A story.',
      posterUrl: 'https://image.tmdb.org/t/p/original/poster.jpg',
      backdropUrl: 'https://image.tmdb.org/t/p/original/backdrop.jpg',
      releaseStatus: ReleaseStatus.RETURNING,
      rawMetadata: null,
      importBatchId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(dto.posterUrl).toBe('https://image.tmdb.org/t/p/original/poster.jpg');
    expect(dto.backdropUrl).toBe('https://image.tmdb.org/t/p/original/backdrop.jpg');
  });

  it('passes through null posterUrl/backdropUrl/overview as null, not undefined or a placeholder', () => {
    const dto = toSeriesSummary({
      id: 's2',
      title: 'Unenriched Series',
      overview: null,
      posterUrl: null,
      backdropUrl: null,
      releaseStatus: ReleaseStatus.UNKNOWN,
      rawMetadata: null,
      importBatchId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(dto.overview).toBeNull();
    expect(dto.posterUrl).toBeNull();
    expect(dto.backdropUrl).toBeNull();
  });
});

describe('toEpisodeSummary', () => {
  const season = { id: 'season-1', seriesId: 's1', seasonNumber: 1, title: null, rawMetadata: null, importBatchId: null };

  it('includes imageUrl alongside the other episode fields', () => {
    const dto = toEpisodeSummary({
      id: 'ep-1',
      seasonId: 'season-1',
      episodeNumber: 5,
      title: 'Into the Dark',
      overview: 'The crew loses contact.',
      airDate: new Date('2024-03-10'),
      runtimeMinutes: 42,
      imageUrl: 'https://image.tmdb.org/t/p/original/still.jpg',
      rawMetadata: null,
      importBatchId: null,
      season,
    });

    expect(dto.imageUrl).toBe('https://image.tmdb.org/t/p/original/still.jpg');
    expect(dto.seasonNumber).toBe(1);
  });

  it('passes through a null imageUrl as null (episode has no still image yet)', () => {
    const dto = toEpisodeSummary({
      id: 'ep-2',
      seasonId: 'season-1',
      episodeNumber: 6,
      title: null,
      overview: null,
      airDate: null,
      runtimeMinutes: null,
      imageUrl: null,
      rawMetadata: null,
      importBatchId: null,
      season,
    });

    expect(dto.imageUrl).toBeNull();
    expect(dto.title).toBeNull();
  });
});
