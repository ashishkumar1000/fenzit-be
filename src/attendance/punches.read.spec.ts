import type { PoolClient } from 'pg';
import { HttpException, HttpStatus } from '@nestjs/common';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ErrorCode } from '../common/enums/error-code.enum';
import { PunchesService } from './punches.read';
import { DayStatusesService } from './day-status.read';
import type { DayGridRow } from '../common/day-status/grid-reader';

/**
 * The admin punch-history read (employee profile story). The grid and the
 * tenant-existence gate are module-mocked (the leave-read spec's boundary),
 * while the REAL engine + instant spelling run: these pins would survive any
 * refactoring that keeps the contract — newest-first order, punch-only rows,
 * the 404-no-leak gate, the 62-day cap BEFORE any per-date work, and the
 * AD-7 tenant-offset instant spelling.
 */

const mockEmployeeExists = jest.fn();
const mockReadDayStatusGrid = jest.fn();
const mockTenantToday = jest.fn();

jest.mock('./leave.repository', () => ({
  ...jest.requireActual('./leave.repository'),
  employeeExistsInTenant: (...args: unknown[]) => mockEmployeeExists(...args),
}));

jest.mock('../common/day-status/grid-reader', () => ({
  ...jest.requireActual('../common/day-status/grid-reader'),
  readDayStatusGrid: (...args: unknown[]) => mockReadDayStatusGrid(...args),
}));

jest.mock('./enrolments.repository', () => ({
  ...jest.requireActual('./enrolments.repository'),
  tenantToday: (...args: unknown[]) => mockTenantToday(...args),
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const EMP = '22222222-2222-4222-8222-222222222222';
const OFFICE = 'b0000000-0000-4000-8000-0000000000e2';

const owner: RequestUser = {
  userId: '55555555-5555-4555-8555-555555555555',
  tenantId: TENANT,
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'jwt',
};

function serviceOver(): PunchesService {
  const pool = {
    withTransaction: async <T>(work: (client: PoolClient) => Promise<T>) =>
      work({} as PoolClient),
  };
  return new PunchesService(pool as unknown as PgPoolFactory);
}

function dayStatusesServiceOver(): DayStatusesService {
  const pool = {
    withTransaction: async <T>(work: (client: PoolClient) => Promise<T>) =>
      work({} as PoolClient),
  };
  return new DayStatusesService(
    pool as unknown as PgPoolFactory,
    {} as never,
  );
}

/** A tracked working-day context (the engine's "plain present day" shape). */
function ctxFor(workDate: string) {
  return {
    tenantId: TENANT,
    employeeId: EMP,
    workDate,
    timezone: 'Asia/Kolkata',
    trackedBase: true,
    tracked: true,
    enableDayGraceBlocks: false,
    officeId: OFFICE,
    officeName: 'Andheri West',
    officeLat: 19.1,
    officeLng: 72.8,
    radiusM: 100,
    officeRulesId: 'rule-1',
    startMinute: 9 * 60 + 30,
    endMinute: 18 * 60 + 30,
    midpointMinute: null,
    lateCutoffMinutes: 0,
    fullDayMinutes: 8 * 60,
    halfDayMinutes: 4 * 60,
    isWeeklyOff: false,
    holidayId: null,
    holidayName: null,
    isWorkingDay: true,
    leaveState: null,
    leavePart: null,
    leaveRequestId: null,
  };
}

/** A grid day with a real GPS pair (09:30–17:00 IST = a graded half day). */
function punchDay(
  workDate: string,
  over: Partial<DayGridRow> = {},
): DayGridRow {
  return {
    employeeId: EMP,
    workDate,
    today: '2026-11-24',
    ctx: ctxFor(workDate),
    record: {
      employee_id: EMP,
      work_date: workDate,
      checkin_at: `${workDate}T04:30:00.000Z`, // 10:00 IST
      checkout_at: `${workDate}T11:30:00.000Z`, // 17:00 IST
      checkin_distance_m: 12,
      checkout_distance_m: 30,
    },
    override: null,
    hasUnackMockedAttempt: false,
    latestCorrection: null,
    ...over,
  };
}

describe('PunchesService.listForOwner', () => {
  beforeEach(() => {
    mockEmployeeExists.mockReset().mockResolvedValue(true);
    mockReadDayStatusGrid.mockReset();
    mockTenantToday.mockReset();
  });

  it('serves only days that carry a punch, NEWEST first, with instants spelled in the tenant offset', async () => {
    // The grid ascends by date (the reader's enumerate order); a day with no
    // record and no override never surfaces.
    mockReadDayStatusGrid.mockResolvedValue([
      punchDay('2026-11-19'),
      punchDay('2026-11-20'),
      punchDay('2026-11-21', { record: null }), // absent day — never surfaces
    ]);

    const result = await serviceOver().listForOwner(
      owner,
      EMP,
      '2026-11-15',
      '2026-11-24',
    );

    expect(mockEmployeeExists).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      EMP,
    );
    expect(result.punches.map((p) => p.workDate)).toEqual([
      '2026-11-20',
      '2026-11-19',
    ]);
    const newest = result.punches[0];
    // AD-7: the wall-clock instant carries the tenant offset, not a UTC Z —
    // 04:30Z is 10:00 in Asia/Kolkata and must READ as 10:00.
    expect(newest.checkinAt).toBe('2026-11-20T10:00:00+05:30');
    expect(newest.checkoutAt).toBe('2026-11-20T17:00:00+05:30');
    // A GPS-paired day keeps its distances and is not a correction.
    expect(newest.checkinDistanceM).toBe(12);
    expect(newest.checkoutDistanceM).toBe(30);
    expect(newest.corrected).toBe(false);
    expect(newest.officeId).toBe(OFFICE);
    expect(newest.officeName).toBe('Andheri West');
    expect(result.today).toBe('2026-11-24');
  });

  it('a corrected instant replaces the raw one and carries no distance (D2)', async () => {
    mockReadDayStatusGrid.mockResolvedValue([
      punchDay('2026-11-20', {
        override: {
          employee_id: EMP,
          work_date: '2026-11-20',
          status: null,
          manual_checkin_at: '2026-11-20T05:00:00.000Z',
          manual_checkout_at: null,
        },
      }),
    ]);

    const result = await serviceOver().listForOwner(
      owner,
      EMP,
      '2026-11-15',
      '2026-11-24',
    );

    const punch = result.punches[0];
    expect(punch.checkinAt).toBe('2026-11-20T10:30:00+05:30'); // the manual instant
    expect(punch.checkoutAt).toBe('2026-11-20T17:00:00+05:30'); // the raw pair's checkout
    expect(punch.corrected).toBe(true);
    expect(punch.checkinDistanceM).toBeNull(); // a manual source never gains one
    expect(punch.checkoutDistanceM).toBe(30); // the record-served field keeps its GPS distance
  });

  it('404s ATTENDANCE_EMPLOYEE_NOT_FOUND for a foreign id — no existence leak', async () => {
    mockEmployeeExists.mockResolvedValue(false);

    const err = await serviceOver()
      .listForOwner(owner, EMP, '2026-11-15', '2026-11-24')
      .catch((e: unknown) => e as HttpException);

    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect((err.getResponse() as { error_code: string }).error_code).toBe(
      ErrorCode.ATTENDANCE_EMPLOYEE_NOT_FOUND,
    );
    expect(mockReadDayStatusGrid).not.toHaveBeenCalled();
  });

  it('422s ATTENDANCE_INVALID_RANGE when from > to, before any read', async () => {
    const err = await serviceOver()
      .listForOwner(owner, EMP, '2026-11-24', '2026-11-15')
      .catch((e: unknown) => e as HttpException);

    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect((err.getResponse() as { error_code: string }).error_code).toBe(
      ErrorCode.ATTENDANCE_INVALID_RANGE,
    );
    expect(String((err.getResponse() as { message: string }).message)).toContain(
      'cannot be before the start date',
    );
    expect(mockEmployeeExists).not.toHaveBeenCalled();
    expect(mockReadDayStatusGrid).not.toHaveBeenCalled();
  });

  it('422s when the span exceeds the 62-day cap, before any read', async () => {
    const err = await serviceOver()
      .listForOwner(owner, EMP, '2026-01-01', '2026-03-05') // 64 days
      .catch((e: unknown) => e as HttpException);

    expect(err.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect((err.getResponse() as { error_code: string }).error_code).toBe(
      ErrorCode.ATTENDANCE_INVALID_RANGE,
    );
    expect(String((err.getResponse() as { message: string }).message)).toContain(
      'at most 62 days',
    );
    expect(mockEmployeeExists).not.toHaveBeenCalled();
    expect(mockReadDayStatusGrid).not.toHaveBeenCalled();
  });
});

// --- the deactivation guard's guard -----------------------------------------
// A deactivated member keeps every record: the day-statuses READ (whose
// existence gate the punch read shares) must still succeed for them — the
// parked 409s live on the WRITE paths only.

describe('DayStatusesService.listForOwner — reads never refuse a deactivated member', () => {
  beforeEach(() => {
    mockEmployeeExists.mockReset().mockResolvedValue(true);
    mockReadDayStatusGrid.mockReset();
    mockTenantToday.mockReset();
  });

  it('answers the grid for a member whose membership is parked (deactivated) — history stays viewable', async () => {
    mockReadDayStatusGrid.mockResolvedValue([punchDay('2026-11-20')]);

    const result = await dayStatusesServiceOver().listForOwner(
      owner,
      EMP,
      '2026-11-15',
      '2026-11-24',
    );

    expect(result.employeeId).toBe(EMP);
    expect(result.days).toHaveLength(1);
    expect(result.days[0].status).toBe('half_day');
  });
});
