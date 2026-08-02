import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserSeriesStatus } from '@prisma/client';
import { StartLibraryRefreshRequestDto } from '../dto/start-library-refresh-request.dto';

async function validateStatuses(statuses: unknown) {
  const dto = plainToInstance(StartLibraryRefreshRequestDto, { statuses });
  return validate(dto);
}

describe('StartLibraryRefreshRequestDto validation', () => {
  it('accepts an omitted statuses field', async () => {
    const errors = await validateStatuses(undefined);
    expect(errors).toHaveLength(0);
  });

  it('accepts an empty array', async () => {
    const errors = await validateStatuses([]);
    expect(errors).toHaveLength(0);
  });

  it('accepts a valid array of statuses', async () => {
    const errors = await validateStatuses([UserSeriesStatus.COMPLETED, UserSeriesStatus.CAUGHT_UP]);
    expect(errors).toHaveLength(0);
  });

  it('rejects an array containing a value that is not a UserSeriesStatus', async () => {
    const errors = await validateStatuses(['NOT_A_REAL_STATUS']);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-array value', async () => {
    const errors = await validateStatuses(UserSeriesStatus.COMPLETED);
    expect(errors.length).toBeGreaterThan(0);
  });
});
