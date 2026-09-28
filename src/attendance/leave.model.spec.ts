import { ErrorCode } from '../common/enums/error-code.enum';
import {
  deriveLeaveStatus,
  leaveDuplicateKey,
  leaveNotFound,
  leaveRejectionToException,
  leaveTransitionViolation,
  toRequestView,
  type LeaveRequestRow,
} from './leave.model';
import { DERIVED_STATUS_ORDER } from './leave.constants';

/**
 * QA-mindset pins for the derived status (D5 — THE single implementation)
 * and the error catalogue mapping (D6). Mixed day-state sets are the
 * interesting cases: the order must match DERIVED_STATUS_ORDER exactly.
 */

const REQUEST: LeaveRequestRow = {
  id: 'req-1',
  tenant_id: 't1',
  employee_id: 'e1',
  request_id: '11111111-1111-4111-8111-111111111111',
  start_date: '2026-09-28',
  end_date: '2026-09-30',
  part: 'full_day',
  reason: 'Family function',
  created_by: 'e1',
  created_at: '2026-09-27T10:00:00Z',
};

describe('deriveLeaveStatus — first match in DERIVED_STATUS_ORDER wins (D5)', () => {
  it.each([
    [['pending'], 'pending'],
    [['approved', 'approved'], 'approved'],
    [['revoked'], 'revoked'],
    [['cancelled'], 'cancelled'],
    [['rejected'], 'rejected'],
    // Mixed: pending outranks everything (needs owner action most).
    [['cancelled', 'pending'], 'pending'],
    [['approved', 'pending', 'cancelled'], 'pending'],
    // An in-progress request (auto-cancelled today, rest approved).
    [['approved', 'cancelled'], 'approved'],
    // Terminal mixes rank revoked > cancelled > rejected.
    [['revoked', 'cancelled'], 'revoked'],
    [['cancelled', 'rejected'], 'cancelled'],
  ])('%s → %s', (states, expected) => {
    expect(deriveLeaveStatus(states as never)).toBe(expected);
  });

  it('the order array itself is the single source (the repository SQL is generated from it)', () => {
    expect([...DERIVED_STATUS_ORDER]).toEqual([
      'pending',
      'approved',
      'revoked',
      'cancelled',
      'rejected',
    ]);
  });
});

describe('toRequestView', () => {
  it('maps snake_case to camelCase, sorts the dates ascending, and counts', () => {
    const view = toRequestView(
      REQUEST,
      [
        { leave_date: '2026-09-30', state: 'pending' },
        { leave_date: '2026-09-28', state: 'pending' },
        { leave_date: '2026-09-29', state: 'pending' },
      ],
      3,
    );
    expect(view).toMatchObject({
      id: 'req-1',
      employeeId: 'e1',
      startDate: '2026-09-28',
      endDate: '2026-09-30',
      part: 'full_day',
      reason: 'Family function',
      status: 'pending',
      workingDays: 3,
      totalDays: 3,
    });
    expect(view.dates.map((d) => d.date)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
    ]);
  });

  it('derives the status from the day rows it is given', () => {
    const view = toRequestView(
      REQUEST,
      [
        { leave_date: '2026-09-28', state: 'approved' },
        { leave_date: '2026-09-29', state: 'cancelled' },
      ],
      1,
    );
    expect(view.status).toBe('approved');
  });
});

describe('leave error mapping (D6 catalogue)', () => {
  it('maps 409-class codes to CONFLICT', () => {
    for (const errorCode of [
      ErrorCode.LEAVE_OVERLAP,
      ErrorCode.LEAVE_NOT_PENDING,
      ErrorCode.LEAVE_NOT_REVOKABLE,
      ErrorCode.LEAVE_NOT_CANCELLABLE,
      ErrorCode.LEAVE_INVALID_TRANSITION,
    ]) {
      const exception = leaveRejectionToException({ errorCode, message: 'x' });
      expect(exception.getStatus()).toBe(409);
      expect(exception.getResponse()).toMatchObject({ error_code: errorCode });
    }
  });

  it('maps rule violations to 422', () => {
    for (const errorCode of [
      ErrorCode.LEAVE_INVALID_RANGE,
      ErrorCode.LEAVE_TOO_OLD,
      ErrorCode.LEAVE_BEFORE_START_DATE,
      ErrorCode.LEAVE_CHECKED_IN_CONFLICT,
      ErrorCode.LEAVE_ALREADY_OFF,
    ]) {
      const exception = leaveRejectionToException({ errorCode, message: 'x' });
      expect(exception.getStatus()).toBe(422);
      expect(exception.getResponse()).toMatchObject({ error_code: errorCode });
    }
  });

  it('404s a foreign/missing request without an existence leak', () => {
    expect(leaveNotFound().getStatus()).toBe(404);
    expect(leaveNotFound().getResponse()).toMatchObject({
      error_code: ErrorCode.LEAVE_REQUEST_NOT_FOUND,
    });
  });

  it('maps a raced idempotency key to DUPLICATE_RESOURCE (409)', () => {
    expect(leaveDuplicateKey().getStatus()).toBe(409);
    expect(leaveDuplicateKey().getResponse()).toMatchObject({
      error_code: ErrorCode.DUPLICATE_RESOURCE,
    });
  });

  it('maps a guard-trigger trip to a 409 (defensive path)', () => {
    expect(leaveTransitionViolation().getStatus()).toBe(409);
    expect(leaveTransitionViolation().getResponse()).toMatchObject({
      error_code: ErrorCode.LEAVE_INVALID_TRANSITION,
    });
  });
});
