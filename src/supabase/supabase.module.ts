import { Module } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';

@Module({
  providers: [SupabaseClientFactory],
  exports: [SupabaseClientFactory],
})
export class SupabaseModule {}
