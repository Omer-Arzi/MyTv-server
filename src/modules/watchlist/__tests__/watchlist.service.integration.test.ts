// Integration test for WatchlistService.list()'s active, TRUSTWORTHY
// tracking-list query (Watching/Caught Up require a confirmed provider
// match; Watchlist never does) against a real Postgres database — same
// throwaway-fixture/cascade-delete convention as this session's other
// integration tests.

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { UserSeriesStatus } from '@prisma/client';
import { WatchlistService } from '../watchlist.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { EPISODE_NUMBERING_RISK_LIST_TITLES } from '../../../common/stale-series-trust';

const describeIfDbConfigured = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDbConfigured('WatchlistService.list — active, trustworthy tracking list (integration, real Postgres)', () => {
  const prisma = new PrismaService();
  const service = new WatchlistService(prisma);
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

  async function createFixtureUser() {
    const user = await prisma.user.create({
      data: { email: `watchlist-active-library-test-${randomUUID()}@example.com`, displayName: 'Watchlist Active Library Test User' },
    });
    createdUserIds.push(user.id);
    return user;
  }

  async function createFixtureSeriesWithStatus(
    title: string,
    userId: string,
    userStatus: UserSeriesStatus,
    options: { confirmedMatch?: boolean } = {},
  ) {
    const series = await prisma.series.create({ data: { title } });
    createdSeriesIds.push(series.id);
    await prisma.userSeriesProgress.create({ data: { userId, seriesId: series.id, userStatus } });
    if (options.confirmedMatch) {
      await prisma.externalIds.create({ data: { seriesId: series.id, tmdbId: randomUUID(), provider: 'tmdb', providerId: randomUUID() } });
    }
    return series;
  }

  it('returns only WATCHING and CAUGHT_UP series that have a confirmed provider match, plus all WATCHLIST series', async () => {
    const user = await createFixtureUser();
    await createFixtureSeriesWithStatus('Zebra Watching', user.id, UserSeriesStatus.WATCHING, { confirmedMatch: true });
    await createFixtureSeriesWithStatus('Yak Caught Up', user.id, UserSeriesStatus.CAUGHT_UP, { confirmedMatch: true });
    await createFixtureSeriesWithStatus('Xylophone Watchlist', user.id, UserSeriesStatus.WATCHLIST);
    await createFixtureSeriesWithStatus('Unconfirmed Watching', user.id, UserSeriesStatus.WATCHING);
    await createFixtureSeriesWithStatus('Unconfirmed Caught Up', user.id, UserSeriesStatus.CAUGHT_UP);
    await createFixtureSeriesWithStatus('Hidden Paused', user.id, UserSeriesStatus.PAUSED, { confirmedMatch: true });
    await createFixtureSeriesWithStatus('Hidden Dropped', user.id, UserSeriesStatus.DROPPED, { confirmedMatch: true });
    await createFixtureSeriesWithStatus('Hidden Completed', user.id, UserSeriesStatus.COMPLETED, { confirmedMatch: true });
    await createFixtureSeriesWithStatus('Hidden Unknown', user.id, UserSeriesStatus.UNKNOWN, { confirmedMatch: true });

    const result = await service.list(user.id);

    const titles = result.map((r) => r.series.title).sort();
    expect(titles).toEqual(['Xylophone Watchlist', 'Yak Caught Up', 'Zebra Watching']);
    const allowedStatuses: UserSeriesStatus[] = [UserSeriesStatus.WATCHING, UserSeriesStatus.CAUGHT_UP, UserSeriesStatus.WATCHLIST];
    expect(result.every((r) => allowedStatuses.includes(r.userStatus))).toBe(true);
  });

  it('excludes an unconfirmed WATCHING series even though its stored status is WATCHING', async () => {
    const user = await createFixtureUser();
    await createFixtureSeriesWithStatus('No Confirmed Match Yet', user.id, UserSeriesStatus.WATCHING);

    const result = await service.list(user.id);

    expect(result).toEqual([]);
  });

  it('sets attentionReasonCode when a confirmed series is on the known risk list, but still includes it', async () => {
    const user = await createFixtureUser();
    await createFixtureSeriesWithStatus(EPISODE_NUMBERING_RISK_LIST_TITLES[0], user.id, UserSeriesStatus.WATCHING, { confirmedMatch: true });

    const result = await service.list(user.id);

    expect(result).toHaveLength(1);
    expect(result[0].attentionReasonCode).toBe('known-episode-numbering-risk');
  });

  it('leaves attentionReasonCode null for an ordinary confirmed, non-risk-listed series', async () => {
    const user = await createFixtureUser();
    await createFixtureSeriesWithStatus('A Perfectly Fine Confirmed Show', user.id, UserSeriesStatus.WATCHING, { confirmedMatch: true });

    const result = await service.list(user.id);

    expect(result).toHaveLength(1);
    expect(result[0].attentionReasonCode).toBeNull();
  });

  it('sorts alphabetically by title regardless of status, not by any recency signal', async () => {
    const user = await createFixtureUser();
    // Intentionally out-of-alphabetical creation order and mixed statuses.
    await createFixtureSeriesWithStatus('Mango', user.id, UserSeriesStatus.CAUGHT_UP, { confirmedMatch: true });
    await createFixtureSeriesWithStatus('Apple', user.id, UserSeriesStatus.WATCHING, { confirmedMatch: true });
    await createFixtureSeriesWithStatus('Banana', user.id, UserSeriesStatus.WATCHLIST);

    const result = await service.list(user.id);

    expect(result.map((r) => r.series.title)).toEqual(['Apple', 'Banana', 'Mango']);
  });

  it('returns an empty array when the user has no eligible active-library series at all', async () => {
    const user = await createFixtureUser();
    await createFixtureSeriesWithStatus('Only Dropped Here', user.id, UserSeriesStatus.DROPPED, { confirmedMatch: true });

    const result = await service.list(user.id);

    expect(result).toEqual([]);
  });

  it('ordering is stable across repeated calls with unchanged data (no hidden randomness)', async () => {
    const user = await createFixtureUser();
    await createFixtureSeriesWithStatus('Charlie', user.id, UserSeriesStatus.WATCHING, { confirmedMatch: true });
    await createFixtureSeriesWithStatus('Alpha', user.id, UserSeriesStatus.WATCHING, { confirmedMatch: true });
    await createFixtureSeriesWithStatus('Bravo', user.id, UserSeriesStatus.WATCHING, { confirmedMatch: true });

    const first = await service.list(user.id);
    const second = await service.list(user.id);

    expect(first.map((r) => r.series.title)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(second.map((r) => r.series.title)).toEqual(first.map((r) => r.series.title));
  });
});
