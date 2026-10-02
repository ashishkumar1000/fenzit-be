import { HttpException, HttpStatus } from '@nestjs/common';
import {
  outcomeErrorCode,
  outcomeMessage,
  outcomeStatus,
  outcomeToException,
  recordToResponse,
  toTenantOffsetIso,
} from './check-in-out.model';
import { ErrorCode } from '../common/enums/error-code.enum';

/**
 * The AD-4 wire contract (16-1/16-2): offset instants (D11), the outcome →
 * status/error-code catalogue, the PRD-derived copy, and the replay
 * rebuild. If a code in here drifts from the catalogue the app and the
 * server disagree about what happened — these pins are the tripwire.
 */

const IST = 'Asia/Kolkata';

describe('toTenantOffsetIso (D11 — instants carry the tenant offset)', () => {
  it('formats an instant in the tenant offset', () => {
    expect(toTenantOffsetIso(new Date('2026-09-28T04:00:00Z'), IST)).toBe(
      '2026-09-28T09:30:00+05:30',
    );
  });

  it('uses Z for a zero offset', () => {
    expect(toTenantOffsetIso(new Date('2026-09-28T04:00:00Z'), 'UTC')).toBe(
      '2026-09-28T04:00:00Z',
    );
  });

  it('handles negative half-hour offsets', () => {
    expect(
      toTenantOffsetIso(new Date('2026-09-28T04:00:00Z'), 'America/St_Johns'),
    ).toBe('2026-09-28T01:30:00-02:30');
  });
});

describe('AD-4 outcome catalogue', () => {
  it.each([
    ['too_far', 422, ErrorCode.ATTENDANCE_TOO_FAR],
    ['low_accuracy', 422, ErrorCode.ATTENDANCE_LOW_ACCURACY],
    ['mocked', 422, ErrorCode.ATTENDANCE_MOCK_LOCATION],
    ['stale_fix', 422, ErrorCode.ATTENDANCE_STALE_FIX],
    ['rate_limited', 429, ErrorCode.ATTENDANCE_RATE_LIMITED],
    ['not_tracked', 403, ErrorCode.ATTENDANCE_NOT_TRACKED],
    ['already_checked_in', 409, ErrorCode.ATTENDANCE_ALREADY_CHECKED_IN],
    ['already_checked_out', 409, ErrorCode.ATTENDANCE_ALREADY_CHECKED_OUT],
    ['not_checked_in', 409, ErrorCode.ATTENDANCE_NOT_CHECKED_IN],
    [
      'leave_confirmation_required',
      409,
      ErrorCode.ATTENDANCE_LEAVE_CONFIRMATION_REQUIRED,
    ],
  ])('%s → %i %s', (outcome, status, code) => {
    expect(outcomeStatus(outcome)).toBe(status);
    expect(outcomeErrorCode(outcome)).toBe(code);
  });
});

describe('outcomeToException bodies', () => {
  it('too_far carries distanceM and radiusM with the PRD copy', () => {
    const ex = outcomeToException('too_far', 'check_in', {
      officeName: 'Andheri office',
      distanceM: 600.4,
      radiusM: 100,
    });
    expect(ex.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    const body = ex.getResponse() as Record<string, unknown>;
    expect(body['error_code']).toBe(ErrorCode.ATTENDANCE_TOO_FAR);
    expect(body['distanceM']).toBe(600);
    expect(body['radiusM']).toBe(100);
    expect(body['message']).toBe(
      'You are 600 m from Andheri office. Move within 100 m.',
    );
  });

  it('mocked copy is kind-aware', () => {
    expect(
      outcomeMessage('mocked', 'check_in', { officeName: null }),
    ).toBe('Turn off fake location apps to check in');
    expect(
      outcomeMessage('mocked', 'check_out', { officeName: null }),
    ).toBe('Turn off fake location apps to check out');
  });

  it('rate_limited carries retryAfterSeconds (the filter lifts it to Retry-After)', () => {
    const ex = outcomeToException('rate_limited', 'check_in', {
      officeName: null,
      retryAfterSeconds: 60.2,
    });
    const body = ex.getResponse() as Record<string, unknown>;
    expect(ex.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(body['retryAfterSeconds']).toBe(61);
  });

  it('PRD copy for low_accuracy', () => {
    expect(outcomeMessage('low_accuracy', 'check_in', { officeName: null })).toBe(
      'Location not accurate enough, try again in the open',
    );
  });
});

describe('recordToResponse (AD-6 replay rebuild)', () => {
  const record = {
    id: 'r1',
    work_date: '2026-09-28',
    office_id: 'o1',
    office_rules_id: 'rule-1',
    radius_m: 100,
    checkin_at: '2026-09-28T04:00:00Z', // 09:30 IST
    checkout_at: '2026-09-28T10:00:00Z', // 15:30 IST
  };
  const flags = {
    isWeeklyOff: false,
    isHoliday: false,
    holidayName: null,
    isWorkingDay: true,
  };
  const metrics = {
    lateMinutes: 15,
    isLate: true,
    earlyCheckout: true,
    earlyCheckoutMinutes: 150,
  };

  it('check-in response keeps the stored instants and late metrics', () => {
    expect(recordToResponse(record, 'check_in', IST, flags, metrics)).toEqual({
      workDate: '2026-09-28',
      checkinAt: '2026-09-28T09:30:00+05:30',
      lateMinutes: 15,
      isLate: true,
      dayContext: flags,
    });
  });

  it('check-out response computes worked minutes from the instants', () => {
    const response = recordToResponse(
      record,
      'check_out',
      IST,
      flags,
      metrics,
    ) as { workedMinutes: number; checkoutAt: string };
    // 09:30 → 15:30 = 360 minutes.
    expect(response.workedMinutes).toBe(360);
    expect(response.checkoutAt).toBe('2026-09-28T15:30:00+05:30');
    expect(response.earlyCheckout).toBe(true);
  });

  it('workedMinutes truncates sub-minute remainders (D12)', () => {
    const short = {
      ...record,
      checkin_at: '2026-09-28T04:00:30Z',
      checkout_at: '2026-09-28T04:04:20Z', // 3 m 50 s together
    };
    const response = recordToResponse(
      short,
      'check_out',
      IST,
      flags,
      metrics,
    ) as { workedMinutes: number };
    // Rounded to the NEAREST minute (user-directed, 2026-10-02 — the old
    // truncation displayed a 3:34→3:35 punch as "0 h 00 m"): round(230/60)=4.
    expect(response.workedMinutes).toBe(4);
  });
});
