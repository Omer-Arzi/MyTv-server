import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DEV_USER_ID } from '../../common/constants';
import { SESSION_TTL_DAYS } from './auth.constants';

@Injectable()
export class AuthService {
  constructor(private readonly jwtService: JwtService) {}

  // No APP_PASSWORD configured means this deployment deliberately has the
  // gate disabled (local dev — see SessionAuthGuard) — login always
  // trivially succeeds rather than rejecting every attempt, so a stray
  // request to /auth/login locally doesn't fail confusingly.
  validatePassword(password: string): boolean {
    const expected = process.env.APP_PASSWORD;
    if (!expected) return true;
    return password === expected;
  }

  issueSessionToken(): string {
    // Single-user app — the token only ever needs to prove "this request
    // knows the shared password", not distinguish between users.
    return this.jwtService.sign({ sub: DEV_USER_ID }, { expiresIn: `${SESSION_TTL_DAYS}d` });
  }
}
