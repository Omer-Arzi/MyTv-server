// Hardcoded dev user, used in place of real auth until it's implemented.
// The seed script creates a User row with this exact id/email so the
// DevUserMiddleware never has to hit the database to resolve "who is this".
export const DEV_USER_ID = '00000000-0000-4000-8000-000000000001';
export const DEV_USER_EMAIL = 'dev@example.com';
export const DEV_USER_DISPLAY_NAME = 'Dev User';
