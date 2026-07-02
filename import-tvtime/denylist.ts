// Sensitive-data policy for the TV Time importer. Grounded directly in the
// findings of docs/tvtime-data-audit.md §4 — every entry here traces back to
// a real column/file inspected in that audit, not a speculative guess.

export interface ExcludedFile {
  file: string;
  reason: string;
}

// Files excluded WHOLESALE: none of their rows are ever written to
// ImportRawRow, regardless of column-level redaction. These are the files
// the audit found to contain real, populated credentials/PII.
export const SENSITIVE_EXCLUDED_FILES: ExcludedFile[] = [
  { file: 'auth-prod-login.csv', reason: 'password reset tokens, email, hash_key' },
  { file: 'access_token.csv', reason: 'live session access tokens' },
  { file: 'refresh_token.csv', reason: 'live session refresh tokens' },
  { file: 'device_token.csv', reason: 'push notification / FCM device tokens' },
  { file: 'user.csv', reason: 'email, password hash, live-looking OAuth access tokens (Facebook/Twitter/Tumblr)' },
  { file: 'user_facebook_data.csv', reason: 'third-party PII: birthday, gender, location, name' },
  { file: 'user_social_data.csv', reason: 'third-party PII: birthday, gender, picture_url, screen_name' },
  { file: 'user_facebook_like.csv', reason: 'behavioral PII tied to a linked Facebook account' },
  { file: 'ip_address.csv', reason: 'IP address + derived geolocation history' },
  { file: 'webhook_data.csv', reason: 'opaque external webhook payloads, not inspectable safely' },
  { file: '_appsflyer_ids.csv', reason: 'advertising/attribution device identifier' },
  { file: 'ad_identifier.csv', reason: 'advertising/attribution device identifier' },
  { file: 'gdpr_requests.csv', reason: "meta-record of the user's own GDPR requests, no product value" },
];

export const SENSITIVE_EXCLUDED_FILENAMES = new Set(SENSITIVE_EXCLUDED_FILES.map((f) => f.file));

// Column-level denylist, applied to every file that ISN'T wholesale-excluded
// above, as defense in depth. Exact (case-insensitive) column-name matches
// rather than broad regexes — every name here is a column the audit actually
// observed; deliberately not a fuzzy pattern like /token/, which would also
// catch unrelated boolean flags such as `posted_on_twitter`.
const SENSITIVE_FIELD_NAMES = new Set(
  [
    'email',
    'mail',
    'password',
    'password_hash',
    'password_new',
    'encrypted_secret',
    'encrypted_token',
    'reset_token',
    'hash_key',
    'hash',
    'access_token',
    'refresh_token',
    'device_token',
    'fcm_registration_token',
    'device_id',
    'ip_address',
    'facebook_id',
    'twitter_id',
    'tumblr_id',
    'fb_access_token',
    'fb_action_id',
    'twitter_oauth_token',
    'twitter_oauth_token_secret',
    'tumblr_oauth_token',
    'tumblr_oauth_token_secret',
    'appsflyer_device_id',
    'ad_id',
    'birthday',
    'gender',
    'picture_url',
    'screen_name',
    'location',
  ].map((f) => f.toLowerCase()),
);

export function isSensitiveField(columnName: string): boolean {
  return SENSITIVE_FIELD_NAMES.has(columnName.toLowerCase());
}

// Strips denylisted columns from a raw CSV row. Returns the redacted row and
// the list of column names that were actually present and removed (so the
// caller can report exactly what happened, not just what the policy allows).
export function redactRow(row: Record<string, string>): { redacted: Record<string, string>; removedFields: string[] } {
  const redacted: Record<string, string> = {};
  const removedFields: string[] = [];

  for (const [key, value] of Object.entries(row)) {
    if (isSensitiveField(key)) {
      removedFields.push(key);
    } else {
      redacted[key] = value;
    }
  }

  return { redacted, removedFields };
}
