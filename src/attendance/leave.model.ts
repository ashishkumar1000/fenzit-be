import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../common/enums/error-code.enum';
import {
  DERIVED_STATUS_ORDER,
  type DerivedLeaveStatus,
  type LeaveDayState,
  type LeavePart,
} from './leave.constants';

/**
 * Response shapes, the derived request status (D5 — THE single
 * implementation; the repository's SQL filter is generated from the same
 * DERIVED_STATUS_ORDER) and the leave error catalogue → HTTP mapping
 * (spec D6). AD-11 assigns derivation to "the read function"; the AD-3
 * amendment relocates it here, to one place every consumer shares.
 */

export interface LeaveRequestRow {
  id: string;
  tenant_id: string;
  employee_id: string;
  request_id: string;
  start_date: string;
  end_date: string;
  part: LeavePart;
  reason: string;
  created_by: string;
  created_at: Date | string;
}

export interface LeaveDayRow {
  leave_date: string;
  state: LeaveDayState;
}

export interface LeaveDateView {
  date: string;
  state: LeaveDayState;
}

/** D5: first matching bucket in DERIVED_STATUS_ORDER wins. */
export function deriveLeaveStatus(states: LeaveDayState[]): DerivedLeaveStatus {
  for (const candidate of DERIVED_STATUS_ORDER) {
    if (states.includes(candidate)) return candidate;
  }
  // Unreachable with day rows present (every state is in the order).
  return 'rejected';
}

export interface LeaveRequestView {
  id: string;
  employeeId: string;
  employeeName?: string;
  startDate: string;
  endDate: string;
  part: LeavePart;
  reason: string;
  createdBy: string;
  createdAt: string;
  status: DerivedLeaveStatus;
  /** D5: working dates in range — off days excluded, recomputed on read. */
  workingDays: number;
  totalDays: number;
  dates: LeaveDateView[];
  /** Write responses only (spec §4): the action's split array. */
  revokedDates?: string[];
  cancelledDates?: string[];
}

/** Builds the wire view; `workingDays` is precomputed by the caller. */
export function toRequestView(
  request: LeaveRequestRow,
  days: LeaveDayRow[],
  workingDays: number,
): LeaveRequestView {
  return {
    id: request.id,
    employeeId: request.employee_id,
    startDate: request.start_date,
    endDate: request.end_date,
    part: request.part,
    reason: request.reason,
    createdBy: request.created_by,
    createdAt: new Date(request.created_at).toISOString(),
    status: deriveLeaveStatus(days.map((d) => d.state)),
    workingDays,
    totalDays: days.length,
    dates: days
      .map((d) => ({ date: d.leave_date, state: d.state }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** The action-preview shape (D13) — 17-7's "stays vs changes" renders from it. */
export interface LeaveActionPreview {
  action: 'revoke' | 'cancel';
  actionDates: string[];
  keepDates: {
    date: string;
    state: LeaveDayState;
    reason: 'past' | 'cutoff_passed';
  }[];
  request: LeaveRequestView;
}

/** The apply-preview shape (D4) — the FE renders rejections inline. */
export interface LeaveApplyPreview {
  ok: boolean;
  errorCode?: string;
  message?: string;
  workingDays?: number;
  totalDays?: number;
  part?: LeavePart;
  dates?: {
    date: string;
    isWorkingDay: boolean;
    kind: 'working' | 'weekly_off' | 'holiday';
  }[];
}

export interface LeaveRejection {
  errorCode: ErrorCode;
  message: string;
}

/** Rejection (422/409/403) vs not-found vs conflict, per the D6 catalogue. */
export function leaveRejectionToException(
  rejection: LeaveRejection,
): HttpException {
  const status =
    rejection.errorCode === ErrorCode.LEAVE_OVERLAP ||
    rejection.errorCode === ErrorCode.LEAVE_NOT_PENDING ||
    rejection.errorCode === ErrorCode.LEAVE_NOT_REVOKABLE ||
    rejection.errorCode === ErrorCode.LEAVE_NOT_CANCELLABLE ||
    rejection.errorCode === ErrorCode.LEAVE_INVALID_TRANSITION
      ? HttpStatus.CONFLICT
      : rejection.errorCode === ErrorCode.ATTENDANCE_NOT_TRACKED
        ? HttpStatus.FORBIDDEN
        : HttpStatus.UNPROCESSABLE_ENTITY;
  return new HttpException(
    {
      error_code: rejection.errorCode,
      message: rejection.message,
    },
    status,
  );
}

export function leaveNotFound(): HttpException {
  return new HttpException(
    {
      error_code: ErrorCode.LEAVE_REQUEST_NOT_FOUND,
      message: 'Leave request not found',
    },
    HttpStatus.NOT_FOUND,
  );
}

/** D10: an on-behalf target who is not a technician of this tenant. */
export function leaveEmployeeNotFound(): HttpException {
  return new HttpException(
    {
      error_code: ErrorCode.ATTENDANCE_EMPLOYEE_NOT_FOUND,
      message: 'Employee not found in your company',
    },
    HttpStatus.NOT_FOUND,
  );
}

export function leaveDuplicateKey(): HttpException {
  return new HttpException(
    {
      error_code: ErrorCode.DUPLICATE_RESOURCE,
      message: 'This confirmation key was already used',
    },
    HttpStatus.CONFLICT,
  );
}

/** PT422 from the guard trigger (defensive — unreachable through TS). */
export function leaveTransitionViolation(): HttpException {
  return new HttpException(
    {
      error_code: ErrorCode.LEAVE_INVALID_TRANSITION,
      message: 'Leave state transition is not allowed',
    },
    HttpStatus.CONFLICT,
  );
}
