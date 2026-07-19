import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';

// Registered globally (see app.module.ts's APP_GUARD provider) — every
// route requires a valid session bearer token except ones marked @Public()
// (POST /auth/login). A cookie-based session was tried first and abandoned
// (see docs/auth.md's "Why a bearer token, not a cookie" section) — Railway
// registers *.up.railway.app on the Public Suffix List specifically so
// different customers' apps can't share cookies, which makes the mobile
// PWA's and this API's Railway subdomains genuinely different *sites* to a
// browser, not just different subdomains of one site. That makes the
// session cookie a third-party cookie, which Safari/iOS — the exact
// platform this app's PWA targets — blocks by default. A bearer token in
// an Authorization header isn't subject to any of that.
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    // No APP_PASSWORD configured means this deployment deliberately has the
    // gate disabled — local dev against a Mac/Docker Postgres never sets
    // this, and DevUserMiddleware already treats every request as the one
    // real user regardless. Only a deployment that sets APP_PASSWORD (e.g.
    // the public Railway instance) actually enforces sessions.
    if (!process.env.APP_PASSWORD) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
    if (!token) throw new UnauthorizedException('Not authenticated');

    try {
      this.jwtService.verify(token);
      return true;
    } catch {
      throw new UnauthorizedException('Session expired or invalid');
    }
  }
}
