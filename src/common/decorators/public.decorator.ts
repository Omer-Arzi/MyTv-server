import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

// Marks a route as reachable without a valid session cookie — used only by
// POST/DELETE /auth/login|logout. Every other route goes through
// SessionAuthGuard (see modules/auth/session-auth.guard.ts).
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
