import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { AppConfigController } from './app-config.controller';
import { AppConfigService } from './app-config.service';

@Module({
  imports: [SupabaseModule],
  controllers: [AppConfigController],
  providers: [AppConfigService],
})
export class AppConfigModule {}
