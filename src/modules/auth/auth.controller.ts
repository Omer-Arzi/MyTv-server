import { Body, Controller, Get, HttpCode, Post, Res, UnauthorizedException } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { SESSION_COOKIE_NAME, SESSION_TTL_DAYS } from './auth.constants';
import { LoginDto } from './dto/login.dto';

// APP_PASSWORD unset (local dev) implies http://localhost — secure+SameSite
// none cookies are silently dropped by browsers over plain HTTP. APP_PASSWORD
// set implies the real deployment (Railway, HTTPS, mobile PWA on a different
// subdomain), which needs SameSite=None specifically to allow the
// cross-subdomain cookie at all — and SameSite=None requires Secure.
function sessionCookieOptions() {
  const isDeployed = Boolean(process.env.APP_PASSWORD);
  return {
    httpOnly: true,
    secure: isDeployed,
    sameSite: isDeployed ? ('none' as const) : ('lax' as const),
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Log in with the shared app password',
    description:
      'This app has exactly one real user — there is no username, only APP_PASSWORD (an env var on the server). ' +
      'On success, sets an httpOnly session cookie every other route requires. If APP_PASSWORD is not configured ' +
      '(local dev), the gate is disabled entirely and this always succeeds.',
  })
  @ApiOkResponse({ description: 'Session cookie set.' })
  @ApiUnauthorizedResponse({ description: 'Wrong password.' })
  login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response): { ok: true } {
    if (!this.authService.validatePassword(body.password)) {
      throw new UnauthorizedException('Wrong password');
    }
    const token = this.authService.issueSessionToken();
    res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
    return { ok: true };
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Clear the session cookie' })
  @ApiOkResponse({ description: 'Session cookie cleared.' })
  logout(@Res({ passthrough: true }) res: Response): { ok: true } {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  }

  @Get('status')
  @ApiOperation({
    summary: 'Check whether the current session is valid',
    description: 'Reachable at all only if SessionAuthGuard already let the request through — a 401 here means "show the login screen".',
  })
  @ApiOkResponse({ description: 'Session is valid.' })
  status(): { authenticated: true } {
    return { authenticated: true };
  }
}
