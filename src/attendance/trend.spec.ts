import type { PoolClient } from 'pg';
import { Role } from '../common/enums/role.enum';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { AttendanceTrendService } from './trend';
import type { DayGridRow } from '../common/day-status/grid-reader';
import type { DayStatusOutcome } from '../common/day-status/day-status.model';

/**
 * The attendance trend's own logic (2026-11-27 exec dashboard), unit-boundary
 * style: the far boundaries are mocked (the grid read, the engine), the
 * service's real work is what the spec proves — the window guards, the
 * honest-zero day map, the tracked gate, and the partition that must stay
 * identical to the pulse tiles' (checked in / on leave / short day / not
 * checked in, late qualifying checked-in rows only). The engine rules
 * themselves live in day-status.model.spec — mocking computeDayStatus here
 * keeps this spec about the mapping, not a second copy of the engine's
 * arithmetic.
 */

const mockReadDayStatusGrid = jest.fn();
const mockComputeDayStatus = jest.fn();

jest.mock('../common/day-status/grid-reader', () => ({
  ...jest.requireActual('../common/day-status/grid-reader'),
  readDayStatusGrid: (...args: unknown[]) => mockReadDayStatusGrid(...args),
}));

jest.mock('../common/day-status/day-status.model', () => ({
  ...jest.requireActual('../common/day-status/day-status.model'),
  computeDayStatus: (...args: unknown[]) => mockComputeDayStatus(...args),
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const EMP_A = '22222222-2222-4222-8222-222222222222';
const EMP_B = '33333333-3333-4333-8333-333333333333';

const owner: RequestUser = {
  userId: '55555555-5555-4555-8555-555555555555',
  tenantId: TENANT,
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'jwt',
};

/** The tx fake: the tracked-employee query answers the given roster. */
function txOver(employeeIds: string[]) {
  const query = jest.fn(async () => ({
    rows: employeeIds.map((employee_id) => ({ employee_id })),
  }));
  return { query } as unknown as PoolClient;
}

function serviceOver(employeeIds: string[], rows: DayGridRow[]) {
  const tx = txOver(employeeIds);
  const pg = {
    withTransaction: async <T>(fn: (client: PoolClient) => Promise<T>) =>
      fn(tx),
  } as unknown as PgPoolFactory;
  mockReadDayStatusGrid.mockResolvedValue(rows);
  return new AttendanceTrendService(pg);
}

/** A grid row whose only fields the service reads before the engine are
 *  the date and the tracked gate; the rest is the engine's business. */
function rowOver(
  employeeId: string,
  workDate: string,
  tracked: boolean,
): DayGridRow {
  return {
    employeeId,
    workDate,
    today: '2026-11-12',
    ctx: { tracked } as DayGridRow['ctx'],
    record: null,
    override: null,
    hasUnackMockedAttempt: false,
    latestCorrection: null,
  };
}

/** The engine outcome the mocked engine answers with — only the fields the
 *  partition reads (status, isLate, workedMinutes). */
function outcome(status: string, extra: Partial<DayStatusOutcome> = {}) {
  return {
    status,
    lateMinutes: null,
    isLate: false,
    earlyCheckoutMinutes: null,
    earlyCheckout: false,
    workedMinutes: null,
    daysWorked: 0,
    leaveCredit: 0,
    workedOnHolidayCredit: 0,
    checkinSource: 'gps',
    checkoutSource: 'gps',
    markers: [],
    ...extra,
  } as DayStatusOutcome;
}

beforeEach(() => {
  mockReadDayStatusGrid.mockReset();
  mockComputeDayStatus.mockReset();
});

describe('the trend window guards', () => {
  it('a non-date, an inverted window and an over-long span are refused 422', async () => {
    const service = serviceOver([], []);
    await expect(
      service.trend(owner, '2026-02-30', '2026-03-01'),
    ).rejects.toBeDefined();
    await expect(
      service.trend(owner, '2026-03-02', '2026-03-01'),
    ).rejects.toBeDefined();
    await expect(
      service.trend(owner, '2026-01-01', '2026-03-15'),
    ).rejects.toBeDefined();
    expect(mockReadDayStatusGrid).not.toHaveBeenCalled();
  });

  it('exactly 62 days is admitted (the cap is inclusive)', async () => {
    const service = serviceOver([], []);
    const response = await service.trend(owner, '2026-01-01', '2026-03-03');
    expect(response.days).toHaveLength(62);
  });
});

describe('the honest day map', () => {
  it('every date in range renders, zeros included, oldest first', async () => {
    const service = serviceOver([], []);
    const response = await service.trend(owner, '2026-11-10', '2026-11-12');
    expect(response.range).toEqual({ from: '2026-11-10', to: '2026-11-12' });
    expect(response.days.map((d) => d.date)).toEqual([
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
    ]);
    for (const day of response.days) {
      expect(day).toEqual({
        date: day.date,
        tracked: 0,
        checkedIn: 0,
        notCheckedIn: 0,
        shortDay: 0,
        late: 0,
        onLeave: 0,
      });
    }
  });

  it('a date outside the grid never invents a row; the grid stays within range', async () => {
    // The grid answering a stray future date is a type-guard case: the day
    // map must silently ignore it, not crash.
    const rows = [rowOver(EMP_A, '2026-11-20', true)];
    mockComputeDayStatus.mockReturnValue(outcome('present'));
    const service = serviceOver([EMP_A], rows);
    const response = await service.trend(owner, '2026-11-10', '2026-11-12');
    expect(response.days).toHaveLength(3);
    expect(mockReadDayStatusGrid).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      [EMP_A],
      '2026-11-10',
      '2026-11-12',
    );
  });
});

describe('the tracked gate and the bucket partition', () => {
  it('a not-tracked row never reaches the buckets', async () => {
    const rows = [
      rowOver(EMP_A, '2026-11-11', false),
      rowOver(EMP_B, '2026-11-11', true),
    ];
    mockComputeDayStatus.mockReturnValue(outcome('present'));
    const service = serviceOver([EMP_A, EMP_B], rows);
    const [day] = (await service.trend(owner, '2026-11-11', '2026-11-11')).days;
    expect(day.tracked).toBe(1);
    expect(day.checkedIn).toBe(1);
    expect(mockComputeDayStatus).toHaveBeenCalledTimes(1);
  });

  it('presence counts checked in, leave counts on leave, plain absent counts not checked in', async () => {
    const rows = [
      rowOver(EMP_A, '2026-11-11', true),
      rowOver(EMP_B, '2026-11-11', true),
      rowOver('44444444-4444-4444-8444-444444444444', '2026-11-11', true),
    ];
    mockComputeDayStatus
      .mockReturnValueOnce(outcome('in_progress', { isLate: true }))
      .mockReturnValueOnce(outcome('leave'))
      .mockReturnValueOnce(outcome('absent'));
    const service = serviceOver(
      [EMP_A, EMP_B, '44444444-4444-4444-8444-444444444444'],
      rows,
    );
    const [day] = (await service.trend(owner, '2026-11-11', '2026-11-11')).days;
    expect(day).toMatchObject({
      tracked: 3,
      checkedIn: 1,
      late: 1,
      onLeave: 1,
      notCheckedIn: 1,
      shortDay: 0,
    });
  });

  it("the engine's rule-7 short day splits out of absent only without an override", async () => {
    const rows = [
      rowOver(EMP_A, '2026-11-11', true),
      rowOver(EMP_B, '2026-11-11', true),
    ];
    mockComputeDayStatus
      .mockReturnValueOnce(outcome('absent', { workedMinutes: 90 }))
      .mockReturnValueOnce(
        outcome('absent', { workedMinutes: 90 }),
      );
    // The second row carries an override — the service must read the
    // override gate off the GRID row, not off the outcome alone.
    rows[1].override = { status: 'present' } as DayGridRow['override'];
    const service = serviceOver([EMP_A, EMP_B], rows);
    const [day] = (await service.trend(owner, '2026-11-11', '2026-11-11')).days;
    expect(day.shortDay).toBe(1);
    expect(day.notCheckedIn).toBe(1);
  });

  it('late never qualifies a leave or absent row', async () => {
    const rows = [rowOver(EMP_A, '2026-11-11', true)];
    mockComputeDayStatus.mockReturnValue(
      outcome('leave', { isLate: true }),
    );
    const service = serviceOver([EMP_A], rows);
    const [day] = (await service.trend(owner, '2026-11-11', '2026-11-11')).days;
    expect(day.onLeave).toBe(1);
    expect(day.late).toBe(0);
    expect(day.checkedIn).toBe(0);
  });
});
