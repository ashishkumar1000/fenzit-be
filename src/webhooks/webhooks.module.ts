import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { StorageModule } from '../storage/storage.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [SupabaseModule, StorageModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
