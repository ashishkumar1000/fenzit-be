import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { ContactRequestsController } from './contact-requests.controller';
import { ContactRequestsService } from './contact-requests.service';

@Module({
  imports: [SupabaseModule],
  controllers: [ContactRequestsController],
  providers: [ContactRequestsService],
})
export class ContactRequestsModule {}
