import { ApiProperty } from '@nestjs/swagger';
import { UserSeriesStatus } from '@prisma/client';
import { IsIn } from 'class-validator';

// The only userStatus values a client is ever allowed to set directly.
// CAUGHT_UP/COMPLETED are always auto-derived from watch activity + the
// episode catalog (docs/status-model-plan.md §4) — allowing a client to set
// them manually would let the API claim "you've watched everything" when
// it hasn't verified that. UNKNOWN is a system fallback, not a real user
// choice, so it's excluded too.
export const MANUAL_USER_STATUSES = [
  UserSeriesStatus.WATCHING,
  UserSeriesStatus.PAUSED,
  UserSeriesStatus.DROPPED,
  UserSeriesStatus.WATCHLIST,
] as const;

export type ManualUserStatus = (typeof MANUAL_USER_STATUSES)[number];

export class UpdateSeriesStatusDto {
  @ApiProperty({
    enum: MANUAL_USER_STATUSES,
    example: UserSeriesStatus.PAUSED,
    description:
      'The new personal status. Only WATCHING, PAUSED, DROPPED, and WATCHLIST may be set directly — COMPLETED and ' +
      'CAUGHT_UP are always auto-derived and are rejected here (400) if requested.',
  })
  @IsIn(MANUAL_USER_STATUSES)
  userStatus: ManualUserStatus;
}
