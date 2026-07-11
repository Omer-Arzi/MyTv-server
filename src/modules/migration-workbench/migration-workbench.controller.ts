import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types';
import { MigrationWorkbenchService } from './migration-workbench.service';
import { MigrationWorkbenchItemDto } from './dto/migration-workbench-item.dto';
import { MigrationProposalDto } from './dto/migration-proposal.dto';
import { MigrationConfirmResultDto } from './dto/migration-confirm-result.dto';
import { MigrationHistoryItemDto } from './dto/migration-history-item.dto';
import { MigrationHistoryDetailDto } from './dto/migration-history-detail.dto';
import { MigrationRollbackPreviewDto, MigrationRollbackResultDto } from './dto/migration-rollback.dto';
import { ProviderCandidateSearchResultDto } from './dto/provider-candidate.dto';
import { ConfirmIdentityDto } from './dto/confirm-identity.dto';

@ApiTags('migration-workbench')
@Controller('migration-workbench')
export class MigrationWorkbenchController {
  constructor(private readonly migrationWorkbenchService: MigrationWorkbenchService) {}

  @Get()
  @ApiOperation({
    summary: 'List every series still requiring migration work, grouped into 4 categories',
    description:
      'Reads the library-health CLI pipeline\'s own periodically-regenerated reports (batch manifest + provider-confirmation report) — never a live provider call, so this is fast but only as fresh as the last CLI run. ' +
      'READY_AUTOMATIC and READY_FOR_CONFIRMATION items carry a pre-computed proposal; NEEDS_EPISODE_REVIEW and NO_RELIABLE_PROVIDER do not — those need a human decision before any proposal can be computed at all. ' +
      'For an up-to-the-second proposal on one specific series, use GET /migration-workbench/:seriesId/proposal instead.',
  })
  @ApiOkResponse({ type: MigrationWorkbenchItemDto, isArray: true })
  list(@CurrentUser() user: RequestUser): Promise<MigrationWorkbenchItemDto[]> {
    return this.migrationWorkbenchService.list(user.id);
  }

  @Get(':seriesId/proposal')
  @ApiOperation({
    summary: 'Compute a fresh, live migration proposal for one series',
    description:
      'Always performs a real TMDb/TVmaze fetch for this one series — never cached, never batched. Only computes a real proposal for a series with a confirmed provider decision on file; ' +
      'otherwise returns eligible: false without attempting any live call. Read-only: never writes to the database.',
  })
  @ApiOkResponse({ type: MigrationProposalDto })
  getProposal(@CurrentUser() user: RequestUser, @Param('seriesId') seriesId: string): Promise<MigrationProposalDto> {
    return this.migrationWorkbenchService.getProposal(user.id, seriesId);
  }

  @Get(':seriesId/candidates')
  @ApiOperation({
    summary: 'Search for provider candidates for an unresolved (No Reliable Provider) series',
    description:
      'A live TMDb search + score, reusing the exact same search/scoring/classification logic the CLI\'s missing-provider-candidates report uses — never a second algorithm. ' +
      'Never auto-selects or saves anything; the response may recommend a candidate, but the user must explicitly choose one via POST :seriesId/confirm-identity.',
  })
  @ApiOkResponse({ type: ProviderCandidateSearchResultDto })
  searchCandidates(@Param('seriesId') seriesId: string): Promise<ProviderCandidateSearchResultDto> {
    return this.migrationWorkbenchService.searchCandidates(seriesId);
  }

  @Post(':seriesId/confirm-identity')
  @ApiOperation({
    summary: 'Save an explicit provider identity decision for a series',
    description:
      'Persists the decision durably (ProviderIdentityDecision — the same table the CLI pipeline reads) so it survives and is visible to both the app and the CLI, no manual JSON-file editing required. ' +
      'Does NOT apply any migration — the series simply becomes eligible for a real proposal (GET :seriesId/proposal) afterward, same as any other confirmed series.',
  })
  confirmIdentity(@CurrentUser() user: RequestUser, @Param('seriesId') seriesId: string, @Body() body: ConfirmIdentityDto) {
    return this.migrationWorkbenchService.confirmIdentity(user.id, seriesId, body);
  }

  @Post(':seriesId/confirm')
  @ApiOperation({
    summary: 'Apply the migration for one series',
    description:
      'A real, hard-to-reverse write: fetches the provider catalog fresh, corrects the local episode/season catalog, maps watch history, and recomputes the derived status automatically ' +
      '(never a manually-set value) — exactly the same transaction the library-health CLI\'s --apply-safe-confirmed --apply-auto-safe-migrations flags perform, scoped to this one series.',
  })
  @ApiOkResponse({ type: MigrationConfirmResultDto })
  confirmMigration(@CurrentUser() user: RequestUser, @Param('seriesId') seriesId: string): Promise<MigrationConfirmResultDto> {
    return this.migrationWorkbenchService.confirmMigration(user.id, seriesId);
  }

  @Get('history')
  @ApiOperation({
    summary: 'List every migration this user has ever applied, most recent first',
    description: 'A durable audit trail — one row per successful Confirm Migration call, including whether it has since been rolled back.',
  })
  @ApiOkResponse({ type: MigrationHistoryItemDto, isArray: true })
  listHistory(@CurrentUser() user: RequestUser): Promise<MigrationHistoryItemDto[]> {
    return this.migrationWorkbenchService.listHistory(user.id);
  }

  @Get('history/:migrationId')
  @ApiOperation({ summary: 'Full before/after detail for one migration' })
  @ApiOkResponse({ type: MigrationHistoryDetailDto })
  getHistoryDetail(@CurrentUser() user: RequestUser, @Param('migrationId') migrationId: string): Promise<MigrationHistoryDetailDto> {
    return this.migrationWorkbenchService.getHistoryDetail(user.id, migrationId);
  }

  @Post('history/:migrationId/rollback-preview')
  @ApiOperation({
    summary: 'Preview what rolling back one migration would do — read-only',
    description:
      'Always live-re-checks eligibility (watched episodes, progress drift since this migration ran) rather than trusting a stored flag. Never writes anything. ' +
      'Call this before rollback, always — the app should never call rollback without first showing this preview to the user.',
  })
  @ApiOkResponse({ type: MigrationRollbackPreviewDto })
  previewRollback(@CurrentUser() user: RequestUser, @Param('migrationId') migrationId: string): Promise<MigrationRollbackPreviewDto> {
    return this.migrationWorkbenchService.previewRollback(user.id, migrationId);
  }

  @Post('history/:migrationId/rollback')
  @ApiOperation({
    summary: 'Roll back one completed migration',
    description:
      'A real write: restores the prior provider match and series progress, and removes only the episodes THIS migration inserted (never if any have since been watched). ' +
      'Never deletes EpisodeWatch history. Re-validates eligibility live, inside the transaction — a preview result is never trusted blindly. Idempotent: refuses cleanly if already rolled back.',
  })
  @ApiOkResponse({ type: MigrationRollbackResultDto })
  rollback(@CurrentUser() user: RequestUser, @Param('migrationId') migrationId: string): Promise<MigrationRollbackResultDto> {
    return this.migrationWorkbenchService.rollback(user.id, migrationId);
  }
}
