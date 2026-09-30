import type { MonthlyEmployeeSummary } from './monthly-summary.model';

/**
 * 19-3's wire shapes (spec D6). All summary numbers are derived from the
 * day-status engine's grid rows in monthly-summary.model.ts — one
 * implementation shared by the owner route and the `me` route.
 */

/** One employee's row of the owner's monthly response. */
export interface EmployeeMonthlyRow {
  employeeId: string;
  employeeName: string;
  /** The roster's CURRENT office — the assignment covering today. */
  officeId: string | null;
  officeName: string | null;
  summary: MonthlyEmployeeSummary;
}

export interface MonthlyResponse {
  from: string;
  to: string;
  /** Tenant-local today (`YYYY-MM-DD`) — the same tenantToday the range
   * check resolves; 19-5's FE clamps its request window against this echo
   * (the wire truth, never the device clock). */
  today: string;
  employees: EmployeeMonthlyRow[];
}

/** A tenant holiday, tenant-local spelling (`YYYY-MM-DD`). */
export interface HolidayRow {
  holidayDate: string;
  holidayName: string;
}

/**
 * FR-26: the self view is server-side scoped — the caller alone, the same
 * summary shape the owner sees (FR-11's totals parity is structural: one
 * aggregation function), plus their effective weekly-off weekdays (ISO
 * 1=Mon..7=Sun) and the tenant's next 10 upcoming holidays.
 */
export interface MeMonthlyResponse {
  from: string;
  to: string;
  /** Tenant-local today (`YYYY-MM-DD`) — the same tenantToday the range
   * check resolves (19-6's self view consumes the same echo). */
  today: string;
  summary: MonthlyEmployeeSummary;
  weeklyOffs: number[];
  upcomingHolidays: HolidayRow[];
}
