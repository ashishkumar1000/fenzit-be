import { Module } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { AttendanceController } from './attendance.controller';
import { OfficesService } from './offices.service';
import { OfficesController } from './offices.controller';
import { SupabaseModule } from '../supabase/supabase.module';

/**
 * Attendance module (Epic 15, Story 15-2) — foundation. Routes and helpers
 * grow per story (offices 15-3, weekly offs/holidays 15-5, enrolments 15-7,
 * check-in/out Epic 16, leave Epic 17). Data access goes through the
 * Supabase admin client only (AD-3: attendance RPCs and guarded plain
 * writes); no imports from jobs/, reports/, etc.
 */
@Module({
  imports: [SupabaseModule],
  controllers: [AttendanceController, OfficesController],
  providers: [AttendanceService, OfficesService],
  exports: [AttendanceService, OfficesService],
})
export class AttendanceModule {}