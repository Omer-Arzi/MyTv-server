// This app has exactly one real user (see DEV_USER_ID) — "auth" here means
// "does this request hold a session that proves it's me", not real
// multi-user login. See docs/auth.md for the full design rationale.
export const SESSION_COOKIE_NAME = 'mytv_session';
export const SESSION_TTL_DAYS = 30;
