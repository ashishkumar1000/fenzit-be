import { Module } from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { AttendanceController } from './attendance.controller';
import { OfficesService } from './offices.service';
import { OfficesController } from './offices.controller';
import { WeeklyOffsService } from './weekly-offs.service';
import { WeeklyOffsController } from './weekly-offs.controller';
import { HolidaysService } from './holidays.service';
import { HolidaysController } from './holidays.controller';
import { EnrolmentsService } from './enrolments.service';
import { EnrolmentsController } from './enrolments.controller';
import { MeAttendanceService } from './me-attendance.service';
import { MeAttendanceController } from './me-attendance.controller';
import { SupabaseModule } from '../supabase/supabase.module';
import { PgModule } from '../common/pg/pg.module';

/**
 * Attendance module (Epic 15, Story 15-2) — foundation. Routes and helpers
 * grow per story (offices 15-3, weekly offs/holidays 15-5, enrolments
 * 15-7, check-in/out Epic 16, leave Epic 17). Data access goes through the
 * Supabase admin client (AD-3) and — since 15-7's no-RPC decision — the
 * direct pg pool for the transactional enrolment writes only; no imports
 * from jobs/, reports/, etc.
 */
@Module({
  imports: [SupabaseModule, PgModule],
  controllers: [
    AttendanceController,
    OfficesController,
    WeeklyOffsController,
    HolidaysController,
    EnrolmentsController,
    MeAttendanceController,
  ],
  providers: [
    AttendanceService,
    OfficesService,
    WeeklyOffsService,
    HolidaysService,
    EnrolmentsService,
    MeAttendanceService,
  ],
  exports: [
    AttendanceService,
    OfficesService,
    WeeklyOffsService,
    HolidaysService,
    EnrolmentsService,
    MeAttendanceService,
  ],
})
export class AttendanceModule {}
