import { Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { WorkflowService } from './workflow.service';
import { AttachmentsService } from './attachments.service';
import { AttachmentReportsService } from './attachment-reports.service';
import { JobsController } from './jobs.controller';
import { SupabaseModule } from '../supabase/supabase.module';
import { CustomersModule } from '../customers/customers.module';
import { StorageModule } from '../storage/storage.module';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Module({
  imports: [SupabaseModule, CustomersModule, StorageModule],
  controllers: [JobsController],
  providers: [
    JobsService,
    WorkflowService,
    AttachmentsService,
    AttachmentReportsService,
    IdempotencyInterceptor,
  ],
  exports: [JobsService],
})
export class JobsModule {}
