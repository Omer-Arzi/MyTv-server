import { classifySeriesForAttention } from '../classify-series-for-attention';
import { EPISODE_NUMBERING_RISK_LIST_TITLES, KNOWN_SEASON_SHIFT_ORPHAN_TITLES, PROVIDER_STRUCTURE_MISMATCH_TITLES } from '../stale-series-trust';

describe('classifySeriesForAttention', () => {
  it('flags a series with no confirmed provider match as NO_CONFIRMED_PROVIDER_MATCH / REVIEW_IDENTITY', () => {
    const result = classifySeriesForAttention({ title: 'Some Ordinary Show', hasConfirmedProviderMatch: false });
    expect(result).toEqual({
      category: 'NO_CONFIRMED_PROVIDER_MATCH',
      severity: 'info',
      reasonCode: 'no-confirmed-provider-match',
      summary: expect.stringContaining('No confirmed provider match'),
      classification: 'REVIEW_IDENTITY',
    });
  });

  it.each([...EPISODE_NUMBERING_RISK_LIST_TITLES, ...KNOWN_SEASON_SHIFT_ORPHAN_TITLES, ...PROVIDER_STRUCTURE_MISMATCH_TITLES])(
    'flags a confirmed but risk-listed title "%s" as KNOWN_RISK_LIST / REVIEW_ALIGNMENT',
    (title) => {
      const result = classifySeriesForAttention({ title, hasConfirmedProviderMatch: true });
      expect(result).toEqual({
        category: 'KNOWN_RISK_LIST',
        severity: 'warning',
        reasonCode: 'known-episode-numbering-risk',
        summary: expect.stringContaining('risk list'),
        classification: 'REVIEW_ALIGNMENT',
      });
    },
  );

  it('returns null for a confirmed, non-risk-listed series — nothing to flag', () => {
    const result = classifySeriesForAttention({ title: 'A Perfectly Fine Show', hasConfirmedProviderMatch: true });
    expect(result).toBeNull();
  });

  it('prioritizes NO_CONFIRMED_PROVIDER_MATCH over the risk list — identity is checked first, never both at once', () => {
    const result = classifySeriesForAttention({ title: EPISODE_NUMBERING_RISK_LIST_TITLES[0], hasConfirmedProviderMatch: false });
    expect(result?.category).toBe('NO_CONFIRMED_PROVIDER_MATCH');
  });
});
