import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionAuthGuard } from './session-auth.guard';

@Module({
  imports: [
    // SESSION_SECRET is required only where APP_PASSWORD is also set (see
    // SessionAuthGuard) — a deployment that enables the gate must set both.
    JwtModule.register({ secret: process.env.SESSION_SECRET }),
  ],
  controllers: [AuthController],
  // Registered here, not in AppModule — SessionAuthGuard depends on
  // JwtService, which only lives in this module's own injector scope (Nest
  // still applies an APP_GUARD globally regardless of which module
  // declares it).
  providers: [AuthService, SessionAuthGuard, { provide: APP_GUARD, useClass: SessionAuthGuard }],
})
export class AuthModule {}
