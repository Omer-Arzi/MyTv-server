import { Module } from '@nestjs/common';
import { SyncModule } from '../sync/sync.module';
import { EpisodeSyncSchedulerService } from './episode-sync-scheduler.service';

@Module({
  imports: [SyncModule],
  providers: [EpisodeSyncSchedulerService],
  exports: [EpisodeSyncSchedulerService],
})
export class SyncSchedulerModule {}
