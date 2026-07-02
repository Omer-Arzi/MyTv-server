import { Injectable, NotFoundException } from '@nestjs/common';
import { toSeriesSummary } from '../../common/mappers';
import { PrismaService } from '../../prisma/prisma.service';
import { WatchlistItemDto } from './dto/watchlist-item.dto';

@Injectable()
export class WatchlistService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<WatchlistItemDto[]> {
    const items = await this.prisma.watchlistItem.findMany({
      where: { userId },
      orderBy: { addedAt: 'desc' },
      include: { series: true },
    });

    return items.map((item) => ({
      id: item.id,
      addedAt: item.addedAt,
      series: toSeriesSummary(item.series),
    }));
  }

  async add(userId: string, seriesId: string): Promise<WatchlistItemDto> {
    const series = await this.prisma.series.findUnique({ where: { id: seriesId } });
    if (!series) {
      throw new NotFoundException(`Series ${seriesId} not found`);
    }

    const item = await this.prisma.watchlistItem.upsert({
      where: { userId_seriesId: { userId, seriesId } },
      create: { userId, seriesId },
      update: {},
      include: { series: true },
    });

    return {
      id: item.id,
      addedAt: item.addedAt,
      series: toSeriesSummary(item.series),
    };
  }

  async remove(userId: string, seriesId: string): Promise<void> {
    const item = await this.prisma.watchlistItem.findUnique({
      where: { userId_seriesId: { userId, seriesId } },
    });
    if (!item) {
      throw new NotFoundException(`Series ${seriesId} is not in the watchlist`);
    }

    await this.prisma.watchlistItem.delete({ where: { id: item.id } });
  }
}
