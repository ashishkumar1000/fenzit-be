/**
 * Pure response model for the day-statuses reads (Epic 18, 18-1): the
 * `DayStatusRow` a range read renders and its list envelope. The engine
 * (day-status.model.ts) computes every number this file only shapes —
 * nothing here re-derives a grade, a late count or a credit (AD-22: one
 * implementation).
 *
 * The 12 keys of UX-DR1 ride on the engine's STATUS_KEYS (its own source
 * of truth); the FE Badge vocabulary (18-3) is generated from that array's
 * documentation, never re-enumerated here.
 */
import { toTenantOffsetIso } from './check-in-out.model';
import type { LatestCorrectionView } from './correction.model';

import {
  STATUS_KEYS_READONLY,
  MARKER_KEYS_READONLY,
  type DayStatusKey,
  type DayMarkerKey,
  type AttendanceSource,
} from '../common/day-status/keys';

export { STATUS_KEYS_READONLY, MARKER_KEYS_READONLY };
export type { DayStatusKey, DayMarkerKey, AttendanceSource };

/** One employee-day of the FR-10 grid (a `me` or owner range read row). */
export interface DayStatusRow {
  workDate: string;
  status: DayStatusKey;
  lateMinutes: number | null;
  isLate: boolean;
  earlyCheckoutMinutes: number | null;
  earlyCheckout: boolean;
  workedMinutes: number | null;
  /** FR-11 credits — decimal, summing over any range (Epic 19 reads them). */
  daysWorked: number;
  leaveCredit: number;
  workedOnHolidayCredit: number;
  isWeeklyOff: boolean;
  holidayName: string | null;
  isWorkingDay: boolean;
  officeId: string | null;
  officeName: string | null;
  /** Check-in/out as AD-7 tenant-offset ISO, from the effective instants
   *  (a times-only override's instants replace the record's). */
  checkinAt: string | null;
  checkoutAt: string | null;
  checkinSource: AttendanceSource;
  checkoutSource: AttendanceSource;
  /** The GPS-measured distance from the office pin (metres) — the stored
   *  record columns, surfaced ONLY for gps-sourced instants: a times-only
   *  correction substitutes manual instants while the stored distance
   *  still describes the original GPS fix (spec-18-3 D2). Null for a
   *  manual source or a day with no record. */
  checkinDistanceM: number | null;
  checkoutDistanceM: number | null;
  markers: DayMarkerKey[];
  /** The covering leave_requests.id (uuid) when the day carries an active
   *  pending/approved leave day — the same condition that produces the
   *  `leave`/`half_day_leave` statuses or the `leave_pending` marker. Null
   *  otherwise (and OFF when the engine sees no active leave row: a
   *  rejected/cancelled/revoked day exposes no request id). The FE uses it
   *  to resolve the request it wants to cancel or re-file without a
   *  separate lookup. */
  leaveRequestId: string | null;
  /** One-liner for the sheet: the newest entry in the day's audit chain. */
  latestCorrection?: LatestCorrectionView;
}

/** Owner: the single-employee range (the multi-employee grid is Epic 19). */
export interface DayStatusesResponse {
  employeeId: string;
  from: string;
  to: string;
  /** The tenant-local date the read ran under — the FE's today ring and
   *  hosts never derive a device date (Foundation rule; spec-18-3 D2). */
  today: string;
  days: DayStatusRow[];
}

/** Technician: the own range (identity from the JWT only). */
export interface MeDayStatusesResponse {
  from: string;
  to: string;
  /** The tenant-local date the read ran under (spec-18-3 D2). */
  today: string;
  days: DayStatusRow[];
}


/**
 * Wire mapper for one engine outcome: the ctx labels plus the instants as
 * AD-7 tenant-offset ISO. `checkin`/`checkout` are the day's effective
 * instants (the read layer passes them once). `isLate`/`earlyCheckout` are
 * the same booleans the FR-4 today-record derives from the same imported
 * math — the parity probe pins them.
 */
export function toDayStatusRow(input: {
  workDate: string;
  isWeeklyOff: boolean;
  holidayName: string | null;
  isWorkingDay: boolean;
  officeId: string | null;
  officeName: string | null;
  timezone: string;
  outcome: import('../common/day-status/day-status.model').DayStatusOutcome;
  checkin: Date | null;
  checkout: Date | null;
  checkinDistanceM: number | null;
  checkoutDistanceM: number | null;
  leaveRequestId: string | null;
  latestCorrection: LatestCorrectionView | null;
}): DayStatusRow {
  const { outcome, latestCorrection } = input;
  return {
    workDate: input.workDate,
    status: outcome.status,
    lateMinutes: outcome.lateMinutes,
    isLate: outcome.isLate,
    earlyCheckoutMinutes: outcome.earlyCheckoutMinutes,
    earlyCheckout: outcome.earlyCheckout,
    workedMinutes: outcome.workedMinutes,
    daysWorked: outcome.daysWorked,
    leaveCredit: outcome.leaveCredit,
    workedOnHolidayCredit: outcome.workedOnHolidayCredit,
    isWeeklyOff: input.isWeeklyOff,
    holidayName: input.holidayName,
    isWorkingDay: input.isWorkingDay,
    officeId: input.officeId,
    officeName: input.officeName,
    checkinAt:
      input.checkin != null
        ? toTenantOffsetIso(input.checkin, input.timezone)
        : null,
    checkoutAt:
      input.checkout != null
        ? toTenantOffsetIso(input.checkout, input.timezone)
        : null,
    checkinSource: outcome.checkinSource,
    checkoutSource: outcome.checkoutSource,
    checkinDistanceM: input.checkinDistanceM,
    checkoutDistanceM: input.checkoutDistanceM,
    markers: [...outcome.markers],
    leaveRequestId: input.leaveRequestId,
    ...(latestCorrection ? { latestCorrection } : {}),
  };
}
