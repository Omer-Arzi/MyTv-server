import { Module } from '@nestjs/common';
import { MigrationWorkbenchController } from './migration-workbench.controller';
import { MigrationWorkbenchService } from './migration-workbench.service';

@Module({
  controllers: [MigrationWorkbenchController],
  providers: [MigrationWorkbenchService],
})
export class MigrationWorkbenchModule {}
