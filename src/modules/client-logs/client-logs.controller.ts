import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClientLogDto } from './dto/client-log.dto';

// Exists purely to debug real-device-only bugs on the web build (crashes,
// weird state) that can't be reproduced locally — see
// mobile/src/utils/remoteLogger.ts for what the client actually sends and
// when. Deliberately not persisted anywhere: this just writes to stdout
// with a grep-able "[client]" prefix, which Railway already captures and
// makes available via `railway logs`. Still behind the normal
// SessionAuthGuard (not @Public()) — no reason to open this up beyond the
// app's one real user, and the bearer token survives a page reload
// (AsyncStorage-backed), so an authenticated client can always reach this
// even right after recovering from a crash.
@ApiTags('client-logs')
@Controller('client-logs')
export class ClientLogsController {
  private readonly logger = new Logger('client');

  @Post()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Report a client-side breadcrumb/error for real-device debugging',
    description: 'Fire-and-forget from the web client. Never persisted — written to stdout only, for `railway logs`.',
  })
  log(@Body() body: ClientLogDto): void {
    const { level, event, message, context, clientTimestamp } = body;
    const line = `${clientTimestamp ?? new Date().toISOString()} :: ${event}${message ? ` :: ${message}` : ''}${
      context ? ` :: ${JSON.stringify(context)}` : ''
    }`;
    if (level === 'error') this.logger.error(line);
    else if (level === 'warn') this.logger.warn(line);
    else this.logger.log(line);
  }
}
