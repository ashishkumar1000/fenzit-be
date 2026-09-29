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
import { CheckInOutService } from './check-in-out.service';
import { LeaveService } from './leave.service';
import { LeaveReadService } from './leave-read.service';
import { MeLeaveController } from './me-leave.controller';
import { LeaveController } from './leave.controller';
import { DayStatusesService } from './day-status.read';
import { DayStatusesController } from './day-statuses.controller';
import { CorrectionsService } from './corrections.service';
import { CorrectionsController } from './corrections.controller';
import { DashboardService } from './dashboard';
import { DashboardController } from './dashboard.controller';
import { DashboardFlagReads } from './dashboard-flags';
import { MonthlyService } from './monthly';
import { MonthlyController } from './monthly.controller';
import { ReminderJobMetricsBinder } from './reminder-metrics';
import { SupabaseModule } from '../supabase/supabase.module';
import { PgModule } from '../common/pg/pg.module';

/**
 * Attendance module (Epic 15, Story 15-2) — foundation. Routes and helpers
 * grow per story (offices 15-3, weekly offs/holidays 15-5, enrolments
 * 15-7, check-in/out Epic 16, leave Epic 17, read views Epic 18, the 19-2/
 * 19-3 dashboard + monthly reads over the 18-x engine, and 19-1's
 * reminder-metrics binder). Data access goes through the Supabase admin
 * client (AD-3) and — since 15-7's no-RPC decision — the direct pg pool
 * for the transactional read/write seams; no imports from jobs/, reports/,
 * etc.
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
    MeLeaveController,
    LeaveController,
    DayStatusesController,
    CorrectionsController,
    DashboardController,
    MonthlyController,
  ],
  providers: [
    AttendanceService,
    OfficesService,
    WeeklyOffsService,
    HolidaysService,
    EnrolmentsService,
    MeAttendanceService,
    CheckInOutService,
    LeaveService,
    LeaveReadService,
    DayStatusesService,
    CorrectionsService,
    DashboardService,
    DashboardFlagReads,
    MonthlyService,
    ReminderJobMetricsBinder,
  ],
  exports: [
    AttendanceService,
    OfficesService,
    WeeklyOffsService,
    HolidaysService,
    EnrolmentsService,
    MeAttendanceService,
    CheckInOutService,
    LeaveService,
    LeaveReadService,
  ],
})
export class AttendanceModule {}
