import { isSensitiveField, redactRow, SENSITIVE_EXCLUDED_FILENAMES } from '../denylist';

describe('denylist', () => {
  it('excludes every file the audit flagged as containing real credentials/PII', () => {
    for (const file of [
      'auth-prod-login.csv',
      'access_token.csv',
      'refresh_token.csv',
      'device_token.csv',
      'user.csv',
      'user_facebook_data.csv',
      'user_social_data.csv',
      'user_facebook_like.csv',
      'ip_address.csv',
      'webhook_data.csv',
      '_appsflyer_ids.csv',
      'ad_identifier.csv',
      'gdpr_requests.csv',
    ]) {
      expect(SENSITIVE_EXCLUDED_FILENAMES.has(file)).toBe(true);
    }
  });

  it('does not exclude files relevant to V1 features', () => {
    for (const file of [
      'tracking-prod-records-v2.csv',
      'tracking-prod-records.csv',
      'ratings-3-prod-episode_votes.csv',
      'emotions-3-prod-episode_votes.csv',
      'episode_comment.csv',
      'user_show_special_status.csv',
    ]) {
      expect(SENSITIVE_EXCLUDED_FILENAMES.has(file)).toBe(false);
    }
  });

  it('flags known sensitive column names case-insensitively', () => {
    expect(isSensitiveField('device_id')).toBe(true);
    expect(isSensitiveField('DEVICE_ID')).toBe(true);
    expect(isSensitiveField('email')).toBe(true);
    expect(isSensitiveField('fb_action_id')).toBe(true);
  });

  it('does not flag lookalike but harmless columns', () => {
    // posted_on_twitter is a boolean UI flag, not a credential — a naive
    // /twitter/i pattern would have wrongly caught this.
    expect(isSensitiveField('posted_on_twitter')).toBe(false);
    expect(isSensitiveField('episode_id')).toBe(false);
    expect(isSensitiveField('series_name')).toBe(false);
  });

  it('redactRow strips only sensitive columns and reports what it removed', () => {
    const { redacted, removedFields } = redactRow({
      device_id: 'some-device-uuid',
      name: 'push_enabled',
      value: 'true',
    });

    expect(redacted).toEqual({ name: 'push_enabled', value: 'true' });
    expect(removedFields).toEqual(['device_id']);
  });

  it('redactRow is a no-op when nothing sensitive is present', () => {
    const row = { series_name: 'Series A', episode_number: '1' };
    const { redacted, removedFields } = redactRow(row);

    expect(redacted).toEqual(row);
    expect(removedFields).toEqual([]);
  });
});
