import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';

export type ClientLogLevel = 'info' | 'warn' | 'error';

// Deliberately loose (no strict schema for `context`) — this exists purely
// for ad hoc real-device debugging (see mobile/src/utils/remoteLogger.ts),
// not as a general analytics/telemetry contract. Never persisted; the
// server just writes it to stdout for `railway logs` to pick up.
export class ClientLogDto {
  @IsIn(['info', 'warn', 'error'])
  level!: ClientLogLevel;

  @IsString()
  event!: string;

  @IsOptional()
  @IsString()
  message?: string;

  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  clientTimestamp?: string;
}
