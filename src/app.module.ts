import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { DevUserMiddleware } from './common/middleware/dev-user.middleware';
import { AuthModule } from './modules/auth/auth.module';
import { HomeModule } from './modules/home/home.module';
import { MeModule } from './modules/me/me.module';
import { WatchlistModule } from './modules/watchlist/watchlist.module';
import { EpisodesModule } from './modules/episodes/episodes.module';
import { SeriesModule } from './modules/series/series.module';
import { MigrationWorkbenchModule } from './modules/migration-workbench/migration-workbench.module';
import { SyncSchedulerModule } from './modules/sync-scheduler/sync-scheduler.module';
import { SearchModule } from './modules/search/search.module';
import { SyncModule } from './modules/sync/sync.module';
import { ClientLogsModule } from './modules/client-logs/client-logs.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    HomeModule,
    MeModule,
    WatchlistModule,
    EpisodesModule,
    SeriesModule,
    MigrationWorkbenchModule,
    SyncSchedulerModule,
    SearchModule,
    SyncModule,
    ClientLogsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(DevUserMiddleware).forRoutes('*');
  }
}
