import { Module } from '@nestjs/common';
import { MeModule } from '../me/me.module';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';

@Module({
  imports: [MeModule],
  controllers: [HomeController],
  providers: [HomeService],
})
export class HomeModule {}
