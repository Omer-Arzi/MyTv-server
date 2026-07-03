import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserSeriesStatus } from '@prisma/client';
import { UpdateSeriesStatusDto } from '../dto/update-series-status.dto';

async function validateStatus(userStatus: unknown) {
  const dto = plainToInstance(UpdateSeriesStatusDto, { userStatus });
  return validate(dto);
}

describe('UpdateSeriesStatusDto validation', () => {
  it.each([UserSeriesStatus.WATCHING, UserSeriesStatus.PAUSED, UserSeriesStatus.DROPPED, UserSeriesStatus.WATCHLIST])(
    'accepts %s',
    async (userStatus) => {
      const errors = await validateStatus(userStatus);
      expect(errors).toHaveLength(0);
    },
  );

  it.each([UserSeriesStatus.COMPLETED, UserSeriesStatus.CAUGHT_UP, UserSeriesStatus.UNKNOWN])(
    'rejects %s — must never be settable directly, it is always auto-derived',
    async (userStatus) => {
      const errors = await validateStatus(userStatus);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints).toBeDefined();
    },
  );

  it('rejects a value that is not a UserSeriesStatus at all', async () => {
    const errors = await validateStatus('NOT_A_REAL_STATUS');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a missing userStatus', async () => {
    const errors = await validateStatus(undefined);
    expect(errors.length).toBeGreaterThan(0);
  });
});
