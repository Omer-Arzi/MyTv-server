import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SeriesRefreshOrchestratorService } from './series-refresh-orchestrator.service';
import { LibraryRefreshJobService } from './library-refresh-job.service';

@Module({
  controllers: [SyncController],
  providers: [SeriesRefreshOrchestratorService, LibraryRefreshJobService],
  exports: [SeriesRefreshOrchestratorService, LibraryRefreshJobService],
})
export class SyncModule {}
