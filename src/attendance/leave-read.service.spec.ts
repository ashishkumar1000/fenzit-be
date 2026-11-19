import type { PoolClient } from 'pg';
import { HttpException, HttpStatus } from '@nestjs/common';
import { Role } from '../common/enums/role.enum';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { LeaveReadService } from './leave-read.service';
import { OnBehalfPreviewQueryDto } from './dto/leave.dto';
import type { LeaveListRow, PageSpan } from './leave.repository';

/**
 * The list wiring (listTransact) at the service layer. The repository spec
 * pins the batch SQL; THIS pins what the review caught nothing else does:
 * the row → PageSpan → facts-lookup chain that every list row's
 * `workingDays` flows through. A keying regression there (say, spans built
 * from `row.id`) would otherwise ship `workingDays: 0` on every row with a
 * green suite — the batch is real here, so the count is derived end to end.
 */

const repoActual = jest.requireActual('./leave.repository');

const mockListLeaveRequests = jest.fn();
const mockFindDaysForRequests = jest.fn();
const mockReadPageSpanFacts = jest.fn();
// 23-14 — the apply-preview path's dependencies (the write path's
// validation, re-run read-only).
const mockReadLeaveTypeConfig = jest.fn();
const mockReadEnrolmentFloor = jest.fn();
const mockReadSettingsGate = jest.fn();
const mockReadSpanFacts = jest.fn();
const mockFindOverlappingDays = jest.fn();
const mockFindCheckedInDates = jest.fn();
const mockTenantToday = jest.fn();
const mockFindActiveOverrideDates = jest.fn();
const mockAssertBalanceForApply = jest.fn();
const mockAssertPayrollDatesEditable = jest.fn();

jest.mock('./leave.repository', () => ({
  ...jest.requireActual('./leave.repository'),
  listLeaveRequests: (...args: unknown[]) => mockListLeaveRequests(...args),
  findDaysForRequests: (...args: unknown[]) => mockFindDaysForRequests(...args),
  readPageSpanFacts: (...args: unknown[]) => mockReadPageSpanFacts(...args),
  readLeaveTypeConfig: (...args: unknown[]) => mockReadLeaveTypeConfig(...args),
  readEnrolmentFloor: (...args: unknown[]) => mockReadEnrolmentFloor(...args),
  readSettingsGate: (...args: unknown[]) => mockReadSettingsGate(...args),
  readSpanFacts: (...args: unknown[]) => mockReadSpanFacts(...args),
  findOverlappingDays: (...args: unknown[]) => mockFindOverlappingDays(...args),
  findCheckedInDates: (...args: unknown[]) => mockFindCheckedInDates(...args),
}));

jest.mock('./corrections.repository', () => ({
  ...jest.requireActual('./corrections.repository'),
  findActiveOverrideDates: (...args: unknown[]) =>
    mockFindActiveOverrideDates(...args),
}));

jest.mock('./enrolments.repository', () => ({
  ...jest.requireActual('./enrolments.repository'),
  tenantToday: (...args: unknown[]) => mockTenantToday(...args),
}));

jest.mock('./leave-balance.service', () => ({
  ...jest.requireActual('./leave-balance.service'),
  assertBalanceForApply: (...args: unknown[]) =>
    mockAssertBalanceForApply(...args),
}));

jest.mock('./payroll-date-gate', () => ({
  ...jest.requireActual('./payroll-date-gate'),
  assertPayrollDatesEditable: (...args: unknown[]) =>
    mockAssertPayrollDatesEditable(...args),
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const EMP = '22222222-2222-4222-8222-222222222222';
const OWNER = '55555555-5555-4555-8555-555555555555';
const ROW_ID = '33333333-3333-4333-8333-333333333333';

function listRow(overrides: Partial<LeaveListRow> = {}): LeaveListRow {
  return {
    id: ROW_ID,
    tenant_id: TENANT,
    employee_id: EMP,
    request_id: '44444444-4444-4444-8444-444444444444',
    start_date: '2026-10-02',
    end_date: '2026-10-03',
    part: 'full_day',
    reason: 'Trip',
    created_by: EMP,
    created_at: '2026-10-01T10:00:00.000Z',
    employee_name: 'Ravi Kumar',
    employee_code: 'EMP-007',
    derived_status: 'approved',
    ...overrides,
  };
}

function ownerUser(): RequestUser {
  return {
    userId: OWNER,
    tenantId: TENANT,
    role: Role.COMPANY_ADMIN,
    platformAdmin: false,
    rawJwt: 'jwt',
  };
}

function techUser(): RequestUser {
  return {
    userId: EMP,
    tenantId: TENANT,
    role: Role.EMPLOYEE,
    platformAdmin: false,
    rawJwt: 'jwt',
  };
}

/** Rows returned per query call, in call order (overrides, defaults, holidays). */
function txWithRows(responses: unknown[][]) {
  let call = 0;
  return {
    query: jest.fn(() =>
      Promise.resolve({ rows: responses[call++] ?? [], rowCount: 0 }),
    ),
  } as unknown as PoolClient & { query: jest.Mock };
}

function serviceOver(tx: PoolClient): LeaveReadService {
  const pool = {
    withTransaction: async <T>(work: (client: PoolClient) => Promise<T>) =>
      work(tx),
  };
  return new LeaveReadService(
    pool as unknown as PgPoolFactory,
    {
      presignReadUrl: (key: string) =>
        Promise.resolve(`https://signed.example/${key}`),
    } as never,
  );
}

describe('LeaveReadService listTransact wiring', () => {
  beforeEach(() => {
    mockListLeaveRequests.mockReset();
    mockFindDaysForRequests.mockReset();
    mockReadPageSpanFacts.mockReset();
    // By default the spy DELEGATES to the real batch — the wiring tests
    // below run the whole chain, not a stubbed facts map.
    mockReadPageSpanFacts.mockImplementation(
      (...args: Parameters<typeof repoActual.readPageSpanFacts>) =>
        repoActual.readPageSpanFacts(...args),
    );
  });

  it('gives each listed request its employee photo link, and null when they have no photo', async () => {
    const tx = txWithRows([[], [{ valid: '[2026-01-01,)', days: [6] }], []]);
    mockListLeaveRequests.mockResolvedValue([
      listRow({ avatar_key: 'avatars/emp/p.jpg' }),
    ]);
    mockFindDaysForRequests.mockResolvedValue(new Map([[ROW_ID, []]]));

    const withPhoto = await serviceOver(tx).listForOwner(ownerUser(), {
      limit: 20,
    });
    expect(withPhoto.data[0].employeeAvatarUrl).toBe(
      'https://signed.example/avatars/emp/p.jpg',
    );

    mockListLeaveRequests.mockResolvedValue([listRow({ avatar_key: null })]);
    const noPhoto = await serviceOver(tx).listForOwner(ownerUser(), {
      limit: 20,
    });
    expect(noPhoto.data[0].employeeAvatarUrl).toBeNull();
  });

  it('derives workingDays through the REAL batch: the Saturday weekly off is excluded, and the spans are keyed by row.employee_id', async () => {
    const tx = txWithRows([
      [], // overrides
      [{ valid: '[2026-01-01,)', days: [6] }], // tenant default: Saturday off
      [], // holidays
    ]);
    mockListLeaveRequests.mockResolvedValue([listRow()]);
    mockFindDaysForRequests.mockResolvedValue(
      new Map([
        [
          ROW_ID,
          [
            { leave_date: '2026-10-02', state: 'approved' },
            { leave_date: '2026-10-03', state: 'approved' },
          ],
        ],
      ]),
    );

    const result = await serviceOver(tx).listForOwner(ownerUser(), {
      limit: 20,
    });

    // Fri 02 Oct counts; Sat 03 Oct is the default weekly off.
    expect(result.data).toHaveLength(1);
    expect(result.data[0].workingDays).toBe(1);
    expect(result.data[0].totalDays).toBe(2);
    expect(result.data[0].status).toBe('approved');
    expect(result.data[0].employeeName).toBe('Ravi Kumar');
    expect(result.data[0].employeeCode).toBe('EMP-007');
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();

    // THE keying pin: spans must carry the employee_id (never the row id),
    // with the request's own date span — a regression here throws below
    // instead of silently answering facts-less rows.
    const [, tenantId, spans] = mockReadPageSpanFacts.mock.calls[0] as [
      unknown,
      string,
      PageSpan[],
    ];
    expect(tenantId).toBe(TENANT);
    expect(spans).toEqual([
      { employeeId: EMP, dates: ['2026-10-02', '2026-10-03'] },
    ]);
  });

  it('a facts-map miss throws LOUDLY — never a silent page of workingDays: 0', async () => {
    const tx = txWithRows([[], [], []]);
    mockListLeaveRequests.mockResolvedValue([listRow()]);
    mockFindDaysForRequests.mockResolvedValue(new Map());
    mockReadPageSpanFacts.mockResolvedValueOnce(new Map()); // wiring bug stand-in

    await expect(
      serviceOver(tx).listForOwner(ownerUser(), { limit: 20 }),
    ).rejects.toThrow('span facts missing');
  });

  it('listMine scopes the page to the CALLER — their userId, never a client-chosen employeeId', async () => {
    const tx = txWithRows([[], [], []]);
    mockListLeaveRequests.mockResolvedValue([]);
    mockFindDaysForRequests.mockResolvedValue(new Map());

    await serviceOver(tx).listMine(techUser(), {
      employeeId: OWNER, // hostile query param must be ignored
      limit: 20,
    });

    expect(mockListLeaveRequests).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: TENANT, employeeId: EMP }),
    );
  });

  it('listForOwner passes the status filter through and defaults the page size to 20', async () => {
    const tx = txWithRows([[], [], []]);
    mockListLeaveRequests.mockResolvedValue([]);
    mockFindDaysForRequests.mockResolvedValue(new Map());

    await serviceOver(tx).listForOwner(ownerUser(), { status: 'pending' });

    expect(mockListLeaveRequests).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: TENANT,
        status: 'pending',
        limit: 20,
      }),
    );
  });
});

// --- 23-14: the apply preview runs the WRITE path's full validation. -------
// The preview is the form's early-catch: it must answer the SAME verdict
// the POST would (type → shape → payroll lock → facts → balance), so a
// known-refused request never reaches submit on either leave form.

const FLOOR_OK = { exists: true, floor: '2026-01-01', coversToday: true };
const SETTINGS_OK = { setupCompleted: true, enabled: true };
const SPAN_WORKING = new Map([
  ['2026-11-23', { isWorkingDay: true, kind: 'working' }],
  ['2026-11-24', { isWorkingDay: true, kind: 'working' }],
]);
const SICK_TYPE = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  code: 'SICK',
  name: 'Sick Leave',
  enabled: true,
  accrualMode: 'monthly',
  accrualDays: 1,
  allowOverBalance: false,
};

function previewOk(tx: PoolClient, typeConfig: unknown = SICK_TYPE) {
  mockTenantToday.mockResolvedValue('2026-11-20');
  mockReadLeaveTypeConfig.mockResolvedValue(typeConfig);
  mockReadEnrolmentFloor.mockResolvedValue(FLOOR_OK);
  mockReadSettingsGate.mockResolvedValue(SETTINGS_OK);
  mockReadSpanFacts.mockResolvedValue(SPAN_WORKING);
  mockFindOverlappingDays.mockResolvedValue([]);
  mockFindCheckedInDates.mockResolvedValue([]);
  mockFindActiveOverrideDates.mockResolvedValue([]);
  mockAssertPayrollDatesEditable.mockResolvedValue(undefined);
  mockAssertBalanceForApply.mockResolvedValue(undefined);
  void tx;
}

describe('LeaveReadService apply preview — the write path\u2019s validation (23-14)', () => {
  beforeEach(() => {
    for (const mock of [
      mockTenantToday,
      mockReadLeaveTypeConfig,
      mockReadEnrolmentFloor,
      mockReadSettingsGate,
      mockReadSpanFacts,
      mockFindOverlappingDays,
      mockFindCheckedInDates,
      mockFindActiveOverrideDates,
      mockAssertBalanceForApply,
      mockAssertPayrollDatesEditable,
    ]) {
      mock.mockReset();
    }
  });

  it('a named type passes the whole ladder and the balance check runs with the type, dates and part', async () => {
    previewOk({} as PoolClient, SICK_TYPE);
    const service = serviceOver({} as PoolClient);
    const result = await service.previewApply(techUser(), {
      startDate: '2026-11-23',
      endDate: '2026-11-24',
      part: 'full_day',
      reason: '',
      leaveTypeId: SICK_TYPE.id,
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: true, workingDays: 2, totalDays: 2 }),
    );
    expect(mockAssertBalanceForApply).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      EMP,
      SICK_TYPE,
      ['2026-11-23', '2026-11-24'],
      'full_day',
      SPAN_WORKING,
      '2026-11-20',
    );
  });

  it('an untyped preview never touches the type or balance gates', async () => {
    previewOk({} as PoolClient, null);
    const service = serviceOver({} as PoolClient);
    const result = await service.previewApply(techUser(), {
      startDate: '2026-11-23',
      endDate: '2026-11-24',
      part: 'full_day',
      reason: '',
    });
    expect(result.ok).toBe(true);
    expect(mockReadLeaveTypeConfig).not.toHaveBeenCalled();
    expect(mockAssertBalanceForApply).not.toHaveBeenCalled();
  });

  it('an insufficient balance rides the preview as the VERBATIM 422 message (ok:false, 200)', async () => {
    previewOk({} as PoolClient, SICK_TYPE);
    mockAssertBalanceForApply.mockRejectedValue(
      new HttpException(
        {
          error_code: 'LEAVE_INSUFFICIENT_BALANCE',
          message:
            'Not enough Sick Leave balance — you have 7 left and this request needs 8',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      ),
    );
    const service = serviceOver({} as PoolClient);
    const result = await service.previewApply(techUser(), {
      startDate: '2026-11-23',
      endDate: '2026-11-24',
      part: 'full_day',
      reason: '',
      leaveTypeId: SICK_TYPE.id,
    });
    expect(result).toEqual({
      ok: false,
      errorCode: 'LEAVE_INSUFFICIENT_BALANCE',
      message:
        'Not enough Sick Leave balance — you have 7 left and this request needs 8',
    });
  });

  it('a locked payroll month answers inline with the gate\u2019s own message', async () => {
    previewOk({} as PoolClient, SICK_TYPE);
    mockAssertPayrollDatesEditable.mockRejectedValue(
      new HttpException(
        {
          error_code: 'PAYROLL_MONTH_LOCKED',
          message:
            'October 2026 is locked for payroll — 2026-10-24 falls on or before its day-25 cut-off, so it can no longer be changed',
        },
        HttpStatus.CONFLICT,
      ),
    );
    const service = serviceOver({} as PoolClient);
    const result = await service.previewApply(techUser(), {
      startDate: '2026-10-24',
      part: 'full_day',
      reason: '',
      leaveTypeId: SICK_TYPE.id,
    });
    expect(result.ok).toBe(false);
    expect(result).toEqual(
      expect.objectContaining({
        errorCode: 'PAYROLL_MONTH_LOCKED',
        message: expect.stringContaining('locked for payroll'),
      }),
    );
    expect(mockReadSpanFacts).not.toHaveBeenCalled(); // the lock outranks the facts
  });

  it('a disabled type refuses inline and the balance check never runs', async () => {
    previewOk({} as PoolClient, { ...SICK_TYPE, enabled: false });
    const service = serviceOver({} as PoolClient);
    const result = await service.previewApply(techUser(), {
      startDate: '2026-11-23',
      part: 'full_day',
      reason: '',
      leaveTypeId: SICK_TYPE.id,
    });
    expect(result).toEqual({
      ok: false,
      errorCode: 'LEAVE_TYPE_DISABLED',
      message: 'This leave type is no longer available to apply for',
    });
    expect(mockAssertBalanceForApply).not.toHaveBeenCalled();
  });

  it('a foreign (cross-tenant) type answers the 404\u2019s message inline (D13: previews never 404)', async () => {
    previewOk({} as PoolClient, null);
    mockReadLeaveTypeConfig.mockResolvedValue(null);
    const service = serviceOver({} as PoolClient);
    const result = await service.previewApply(techUser(), {
      startDate: '2026-11-23',
      part: 'full_day',
      reason: '',
      leaveTypeId: SICK_TYPE.id,
    });
    expect(result).toEqual({
      ok: false,
      errorCode: 'RESOURCE_NOT_FOUND',
      message: 'The leave type is not in this company',
    });
  });

  it('the on-behalf preview validates the TARGET employee — never the owner', async () => {
    previewOk({} as PoolClient, SICK_TYPE);
    const service = serviceOver({} as PoolClient);
    const dto = new OnBehalfPreviewQueryDto();
    dto.employeeId = EMP;
    dto.startDate = '2026-11-23';
    dto.endDate = '2026-11-24';
    dto.part = 'full_day';
    dto.leaveTypeId = SICK_TYPE.id;
    const result = await service.previewApplyOnBehalf(ownerUser(), dto);
    expect(result).toEqual(
      expect.objectContaining({ ok: true, workingDays: 2 }),
    );
    expect(mockReadEnrolmentFloor).toHaveBeenCalledWith(
      expect.anything(),
      EMP, // the target — NOT owner.userId
      '2026-11-20',
    );
    expect(mockAssertBalanceForApply).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      EMP,
      SICK_TYPE,
      ['2026-11-23', '2026-11-24'],
      'full_day',
      SPAN_WORKING,
      '2026-11-20',
    );
  });
});
