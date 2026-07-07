import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { StaleSeriesQueryDto } from '../dto/stale-series-query.dto';

describe('StaleSeriesQueryDto', () => {
  it('defaults afterDays to 90 when omitted', () => {
    const dto = plainToInstance(StaleSeriesQueryDto, {});
    expect(dto.afterDays).toBe(90);
  });

  it('still accepts an explicit afterDays override', async () => {
    const dto = plainToInstance(StaleSeriesQueryDto, { afterDays: '30' });
    expect(dto.afterDays).toBe(30);
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects an afterDays outside the 1-3650 range', async () => {
    const dto = plainToInstance(StaleSeriesQueryDto, { afterDays: '0' });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });
});
