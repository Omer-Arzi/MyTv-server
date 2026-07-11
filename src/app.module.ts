import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { DevUserMiddleware } from './common/middleware/dev-user.middleware';
import { HomeModule } from './modules/home/home.module';
import { MeModule } from './modules/me/me.module';
import { WatchlistModule } from './modules/watchlist/watchlist.module';
import { EpisodesModule } from './modules/episodes/episodes.module';
import { SeriesModule } from './modules/series/series.module';
import { MigrationWorkbenchModule } from './modules/migration-workbench/migration-workbench.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    HomeModule,
    MeModule,
    WatchlistModule,
    EpisodesModule,
    SeriesModule,
    MigrationWorkbenchModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(DevUserMiddleware).forRoutes('*');
  }
}
