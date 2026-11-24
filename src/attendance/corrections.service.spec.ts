import type { PoolClient } from 'pg';
import {
  ConflictException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Role } from '../common/enums/role.enum';
import { ErrorCode } from '../common/enums/error-code.enum';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { CorrectionsService } from './corrections.service';
import type { DayGridRow } from '../common/day-status/grid-reader';

/**
 * The parked-access write gate (owner decision 2026-11-24) over the three
 * correction write paths. The membership helpers stay REAL (they live in
 * leave.repository) — the tx fake routes on their exact SQL, so a test
 * proves the guard reads the right member's status row and refuses with the
 * honest 409 BEFORE any write lands. Only the far boundaries are mocked
 * (payroll gate, day grid, the repository writes), the leave-read spec's
 * module-boundary style.
 */

const mockAssertPayrollDateEditable = jest.fn();
const mockReadDayStatusGrid = jest.fn();
const mockUpsertOverride = jest.fn();
const mockInsertCorrection = jest.fn();
const mockSoftDeleteOverride = jest.fn();
const mockAckAttempts = jest.fn();

jest.mock('./payroll-date-gate', () => ({
  ...jest.requireActual('./payroll-date-gate'),
  assertPayrollDateEditable: (...args: unknown[]) =>
    mockAssertPayrollDateEditable(...args),
}));

jest.mock('../common/day-status/grid-reader', () => ({
  ...jest.requireActual('../common/day-status/grid-reader'),
  readDayStatusGrid: (...args: unknown[]) => mockReadDayStatusGrid(...args),
}));

jest.mock('./corrections.repository', () => ({
  ...jest.requireActual('./corrections.repository'),
  upsertOverride: (...args: unknown[]) => mockUpsertOverride(...args),
  insertCorrection: (...args: unknown[]) => mockInsertCorrection(...args),
  softDeleteOverride: (...args: unknown[]) => mockSoftDeleteOverride(...args),
  ackAttempts: (...args: unknown[]) => mockAckAttempts(...args),
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const EMP = '22222222-2222-4222-8222-222222222222';
const OWNER = '55555555-5555-4555-8555-555555555555';
const WORK_DATE = '2026-11-20';

const owner: RequestUser = {
  userId: OWNER,
  tenantId: TENANT,
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'jwt',
};

/**
 * The SQL-router tx fake (the members setActive style): routes on the exact
 * SQL substrings the real helpers send, never on call order.
 */
function txOver(opts: { memberStatus?: string } = {}) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes('attendance_lock_employee')) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    // employeeExistsInTenant: select count(*)::text as n from public.memberships
    if (sql.includes('count(*)::text as n from public.memberships')) {
      return Promise.resolve({ rows: [{ n: '1' }], rowCount: 1 });
    }
    // assertEmployeeNotDeactivated: select status from public.memberships
    if (sql.includes('select status from public.memberships')) {
      return Promise.resolve({
        rows: [{ status: opts.memberStatus ?? 'active' }],
        rowCount: 1,
      });
    }
    if (sql.includes('from public.tenants')) {
      return Promise.resolve({ rows: [{ timezone: 'Asia/Kolkata' }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return {
    tx: { query } as unknown as PoolClient & { query: jest.Mock },
    queries,
  };
}

function serviceOver(tx: PoolClient): CorrectionsService {
  const pool = {
    withTransaction: async <T>(work: (client: PoolClient) => Promise<T>) =>
      work(tx),
  };
  // The supabase factory backs the `me` list scope only — untouched here.
  return new CorrectionsService(pool as unknown as PgPoolFactory, {} as never);
}

/** One tracked working day with no punches (the put path's dayRow answer). */
function gridRow(): DayGridRow {
  return {
    employeeId: EMP,
    workDate: WORK_DATE,
    today: '2026-11-24',
    ctx: {
      tenantId: TENANT,
      employeeId: EMP,
      workDate: WORK_DATE,
      timezone: 'Asia/Kolkata',
      trackedBase: true,
      tracked: true,
      enableDayGraceBlocks: false,
      officeId: null,
      officeName: null,
      officeLat: null,
      officeLng: null,
      radiusM: null,
      officeRulesId: null,
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
    },
    record: null,
    override: null,
    hasUnackMockedAttempt: false,
    latestCorrection: null,
  };
}

function expectMembershipState(err: HttpException) {
  expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
  expect((err.getResponse() as { error_code: string }).error_code).toBe(
    ErrorCode.MEMBERSHIP_STATE,
  );
  expect((err.getResponse() as { message: string }).message).toBe(
    'This member is deactivated — reinstate them before changing their attendance',
  );
}

describe('CorrectionsService — the parked-access write gate', () => {
  beforeEach(() => {
    mockAssertPayrollDateEditable.mockReset().mockResolvedValue(undefined);
    mockReadDayStatusGrid.mockReset();
    mockUpsertOverride.mockReset();
    mockInsertCorrection.mockReset();
    mockSoftDeleteOverride.mockReset();
    mockAckAttempts.mockReset();
  });

  it('put refuses a deactivated member with 409 MEMBERSHIP_STATE and writes nothing', async () => {
    mockReadDayStatusGrid.mockResolvedValue([gridRow()]);
    const { tx, queries } = txOver({ memberStatus: 'deactivated' });

    const err = await serviceOver(tx)
      .put(owner, EMP, WORK_DATE, { status: 'weekly_off' }, 'Fix the day')
      .catch((e: HttpException) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expectMembershipState(err);
    // The guard read THIS member's status row (tenant + user params).
    const guardRead = queries.find((q) =>
      q.sql.includes('select status from public.memberships'),
    );
    expect(guardRead?.params).toEqual([TENANT, EMP]);
    // No override, no audit row — the transaction wrote nothing.
    expect(mockUpsertOverride).not.toHaveBeenCalled();
    expect(mockInsertCorrection).not.toHaveBeenCalled();
  });

  it('remove refuses a deactivated member with 409 MEMBERSHIP_STATE — not even a removal lands', async () => {
    const { tx } = txOver({ memberStatus: 'deactivated' });

    const err = await serviceOver(tx)
      .remove(owner, EMP, WORK_DATE)
      .catch((e: HttpException) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expectMembershipState(err);
    expect(mockSoftDeleteOverride).not.toHaveBeenCalled();
    expect(mockInsertCorrection).not.toHaveBeenCalled();
  });

  it('acknowledge refuses a deactivated member with 409 MEMBERSHIP_STATE — an ack is a write too', async () => {
    const { tx } = txOver({ memberStatus: 'deactivated' });

    const err = await serviceOver(tx)
      .acknowledge(owner, EMP, WORK_DATE)
      .catch((e: HttpException) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expectMembershipState(err);
    expect(mockAckAttempts).not.toHaveBeenCalled();
  });

  it('an active member still writes: the same put passes the gate and lands the override + audit row', async () => {
    // The control — the 409s above are the member's state firing the guard,
    // not a routing accident in the fake.
    mockReadDayStatusGrid.mockResolvedValue([gridRow()]);
    mockInsertCorrection.mockResolvedValue({
      created_at: '2026-11-24T10:00:00.000Z',
    });
    const { tx, queries } = txOver({ memberStatus: 'active' });

    const result = await serviceOver(tx).put(
      owner,
      EMP,
      WORK_DATE,
      { status: 'weekly_off' },
      'Fix the day',
    );

    expect(result.override).toEqual({
      status: 'weekly_off',
      checkinAt: null,
      checkoutAt: null,
    });
    expect(result.correctedAt).toBe('2026-11-24T15:30:00+05:30');
    expect(result.actorId).toBe(OWNER);
    expect(mockUpsertOverride).toHaveBeenCalledTimes(1);
    expect(mockInsertCorrection).toHaveBeenCalledTimes(1);
    // The guard ran and read an active row — no refusal.
    const guardRead = queries.find((q) =>
      q.sql.includes('select status from public.memberships'),
    );
    expect(guardRead?.params).toEqual([TENANT, EMP]);
  });
});
