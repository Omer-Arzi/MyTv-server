import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { SESSION_COOKIE_NAME } from './auth.constants';

// Registered globally (see app.module.ts's APP_GUARD provider) — every
// route requires a valid session cookie except ones marked @Public()
// (POST /auth/login, POST /auth/logout).
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
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    if (!token) throw new UnauthorizedException('Not authenticated');

    try {
      this.jwtService.verify(token);
      return true;
    } catch {
      throw new UnauthorizedException('Session expired or invalid');
    }
  }
}
