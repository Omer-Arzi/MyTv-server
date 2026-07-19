import { Body, Controller, Get, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

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
      'On success, returns a bearer token the client must send as `Authorization: Bearer <token>` on every other ' +
      'request (see docs/auth.md for why this is a bearer token and not a cookie). If APP_PASSWORD is not configured ' +
      '(local dev), the gate is disabled entirely and this always succeeds.',
  })
  @ApiOkResponse({ description: 'Bearer token issued.' })
  @ApiUnauthorizedResponse({ description: 'Wrong password.' })
  login(@Body() body: LoginDto): { token: string } {
    if (!this.authService.validatePassword(body.password)) {
      throw new UnauthorizedException('Wrong password');
    }
    return { token: this.authService.issueSessionToken() };
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
