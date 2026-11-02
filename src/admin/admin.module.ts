import { Module } from '@nestjs/common';
import { PgModule } from '../common/pg/pg.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminReportsController } from './admin-reports.controller';
import { AdminReportsService } from './admin-reports.service';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [PgModule, SupabaseModule, StorageModule],
  controllers: [AdminController, AdminReportsController],
  providers: [AdminService, AdminReportsService],
})
export class AdminModule {}
