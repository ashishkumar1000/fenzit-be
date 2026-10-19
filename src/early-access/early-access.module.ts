import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { EarlyAccessController } from './early-access.controller';
import { EarlyAccessService } from './early-access.service';

@Module({
  imports: [SupabaseModule],
  controllers: [EarlyAccessController],
  providers: [EarlyAccessService],
})
export class EarlyAccessModule {}
