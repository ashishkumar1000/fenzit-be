import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { JobReportsService } from './job-reports.service';
import { ApprovalQueueService } from './approval-queue.service';
import {
  ApprovalQueueController,
  JobReportsController,
} from './job-reports.controller';

@Module({
  imports: [SupabaseModule],
  controllers: [JobReportsController, ApprovalQueueController],
  providers: [JobReportsService, ApprovalQueueService],
})
export class JobReportsModule {}
