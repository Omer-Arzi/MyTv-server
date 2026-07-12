import { Module } from '@nestjs/common';
import { EpisodeSyncSchedulerService } from './episode-sync-scheduler.service';

@Module({
  providers: [EpisodeSyncSchedulerService],
  exports: [EpisodeSyncSchedulerService],
})
export class SyncSchedulerModule {}
