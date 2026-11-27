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
const mockFindOfficeNames = jest.fn();
const mockCountActiveEmployees = jest.fn();
const mockCountLeaveRequestsByStatus = jest.fn();
const mockFindRequestWithDays = jest.fn();
const mockFindOfficeAssignment = jest.fn();
const mockFindAvailableColleagues = jest.fn();
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
  findOfficeNames: (...args: unknown[]) => mockFindOfficeNames(...args),
  countActiveEmployees: (...args: unknown[]) =>
    mockCountActiveEmployees(...args),
  countLeaveRequestsByStatus: (...args: unknown[]) =>
    mockCountLeaveRequestsByStatus(...args),
  findRequestWithDays: (...args: unknown[]) => mockFindRequestWithDays(...args),
  findOfficeAssignment: (...args: unknown[]) =>
    mockFindOfficeAssignment(...args),
  findAvailableColleagues: (...args: unknown[]) =>
    mockFindAvailableColleagues(...args),
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
const TYPE_ID = '66666666-6666-4666-8666-666666666666';

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
    leave_type_id: TYPE_ID,
    leave_type_code: 'earned',
    leave_type_name: 'Earned Leave',
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

const MANAGER = '77777777-7777-4777-8777-777777777777';

/** A manager: an employee role that happens to have reports (24-2/CAP-2). */
function managerUser(): RequestUser {
  return {
    userId: MANAGER,
    tenantId: TENANT,
    role: Role.EMPLOYEE,
    platformAdmin: false,
    rawJwt: 'jwt',
  };
}

/** A transaction whose subtree walk answers `ids`, everything else empty. */
function txWithSubtree(ids: string[]) {
  return {
    query: jest.fn((sql: string) =>
      sql.includes('with recursive down')
        ? Promise.resolve({ rows: ids.map((user_id) => ({ user_id })) })
        : Promise.resolve({ rows: [] }),
    ),
  } as unknown as PoolClient & { query: jest.Mock };
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
    mockFindOfficeNames.mockReset();
    mockTenantToday.mockReset();
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

  it('carries the request\u2019s leave type for the day modal\u2019s pills \u2014 undefined on legacy rows', async () => {
    const tx = txWithRows([
      [], // overrides
      [{ valid: '[2026-01-01,)', days: [6] }], // tenant default: Saturday off
      [], // holidays
    ]);
    mockListLeaveRequests.mockResolvedValue([
      listRow(),
      listRow({
        id: '33333333-3333-4333-8333-333333333334',
        leave_type_id: null,
        leave_type_code: null,
        leave_type_name: null,
      }),
    ]);
    mockFindDaysForRequests.mockResolvedValue(new Map());

    const result = await serviceOver(tx).listForOwner(ownerUser(), {
      limit: 20,
    });

    expect(result.data[0].leaveTypeId).toBe(TYPE_ID);
    expect(result.data[0].leaveTypeCode).toBe('earned');
    expect(result.data[0].leaveTypeName).toBe('Earned Leave');
    // A legacy request (pre-catalog, nullable column) labels no type.
    expect(result.data[1].leaveTypeId).toBeUndefined();
    expect(result.data[1].leaveTypeName).toBeUndefined();
  });

  it('carries each person\u2019s office covering the tenant\u2019s today — owner list only, undefined without one', async () => {
    const tx = txWithRows([[], [], []]);
    const EMP2 = '22222222-2222-4222-8222-222222222223';
    mockListLeaveRequests.mockResolvedValue([
      listRow(),
      listRow({
        id: '33333333-3333-4333-8333-333333333334',
        employee_id: EMP2,
        avatar_key: null,
      }),
    ]);
    mockFindDaysForRequests.mockResolvedValue(new Map());
    mockFindOfficeNames.mockResolvedValue(new Map([[EMP, 'Gurgaon Hub']]));
    mockTenantToday.mockResolvedValue('2026-11-24');

    const result = await serviceOver(tx).listForOwner(ownerUser(), {
      limit: 20,
    });

    expect(mockFindOfficeNames).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      [EMP, EMP2],
      '2026-11-24', // the tenant's today — never a client date
    );
    expect(result.data[0].officeName).toBe('Gurgaon Hub');
    expect(result.data[1].officeName).toBeUndefined();
  });

  it('listMine never fetches office names — the office line is owner-list-only', async () => {
    const tx = txWithRows([[], [], []]);
    mockListLeaveRequests.mockResolvedValue([]);
    mockFindDaysForRequests.mockResolvedValue(new Map());

    await serviceOver(tx).listMine(techUser(), { limit: 20 });

    expect(mockFindOfficeNames).not.toHaveBeenCalled();
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
    expect(result.data[0].leaveTypeId).toBe(TYPE_ID);
    expect(result.data[0].leaveTypeCode).toBe('earned');
    expect(result.data[0].leaveTypeName).toBe('Earned Leave');
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

  it('a manager\u2019s list scopes to self plus the subtree, not the company', async () => {
    const tx = txWithSubtree(['emp-report']);
    mockListLeaveRequests.mockResolvedValue([]);
    mockFindDaysForRequests.mockResolvedValue(new Map());
    mockFindOfficeNames.mockResolvedValue(new Map());

    await serviceOver(tx).listForOwner(managerUser(), { limit: 20 });

    expect(mockListLeaveRequests).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: TENANT,
        employeeIds: [MANAGER, 'emp-report'],
        employeeId: undefined,
      }),
    );
  });

  it('a manager\u2019s employeeId filter inside the subtree passes through', async () => {
    const tx = txWithSubtree(['emp-report']);
    mockListLeaveRequests.mockResolvedValue([]);
    mockFindDaysForRequests.mockResolvedValue(new Map());
    mockFindOfficeNames.mockResolvedValue(new Map());

    await serviceOver(tx).listForOwner(managerUser(), {
      employeeId: 'emp-report',
      limit: 20,
    });

    expect(mockListLeaveRequests).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        employeeId: 'emp-report',
        employeeIds: undefined,
      }),
    );
  });

  it('a manager\u2019s uppercase UUID filter is matched case-insensitively, like Postgres', async () => {
    const tx = txWithSubtree(['emp-report']);
    mockListLeaveRequests.mockResolvedValue([]);
    mockFindDaysForRequests.mockResolvedValue(new Map());
    mockFindOfficeNames.mockResolvedValue(new Map());

    await expect(
      serviceOver(tx).listForOwner(managerUser(), {
        employeeId: 'EMP-REPORT',
        limit: 20,
      }),
    ).resolves.toMatchObject({ data: [] });
  });

  it('a manager\u2019s filter outside the subtree is 404 before the list runs', async () => {
    const tx = txWithSubtree(['emp-report']);
    mockListLeaveRequests.mockResolvedValue([]);

    const thrown = await serviceOver(tx)
      .listForOwner(managerUser(), { employeeId: 'other-branch', limit: 20 })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(
      (thrown as HttpException).getResponse() as { error_code: string },
    ).toMatchObject({ error_code: 'RESOURCE_NOT_FOUND' });
    expect(mockListLeaveRequests).not.toHaveBeenCalled();
  });

  it('an employee with no reports keeps the 403 it got from the guard before', async () => {
    const tx = txWithSubtree([]);
    mockListLeaveRequests.mockResolvedValue([]);

    const thrown = await serviceOver(tx)
      .listForOwner(techUser(), { limit: 20 })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(mockListLeaveRequests).not.toHaveBeenCalled();
  });

  it('listForOwner threads the 27-1 from/to overlap window through to the repository', async () => {
    const tx = txWithRows([[], [], []]);
    mockListLeaveRequests.mockResolvedValue([]);
    mockFindDaysForRequests.mockResolvedValue(new Map());

    await serviceOver(tx).listForOwner(ownerUser(), {
      status: 'approved',
      from: '2026-11-01',
      to: '2026-11-30',
    });

    expect(mockListLeaveRequests).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: '2026-11-01', to: '2026-11-30' }),
    );
  });

  it('listForOwner refuses from > to with a 422 before any query runs (27-1)', () => {
    const tx = txWithRows([[], [], []]);
    mockListLeaveRequests.mockResolvedValue([]);

    // The pairing check throws synchronously — before any promise exists.
    let thrown: unknown;
    try {
      serviceOver(tx).listForOwner(ownerUser(), {
        from: '2026-11-30',
        to: '2026-11-01',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    // A doomed call never opens the transaction — zero statements ran.
    expect(mockListLeaveRequests).not.toHaveBeenCalled();
    expect(tx.query).not.toHaveBeenCalled();
  });

  it('listForOwner refuses a half-supplied window with a 422 before any query (27-1)', () => {
    const tx = txWithRows([[], [], []]);
    mockListLeaveRequests.mockResolvedValue([]);

    let thrown: unknown;
    try {
      serviceOver(tx).listForOwner(ownerUser(), { from: '2026-11-01' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    expect(mockListLeaveRequests).not.toHaveBeenCalled();
    expect(tx.query).not.toHaveBeenCalled();
  });

  it('listMine never carries the 27-1 window — it stays an owner-only capability', async () => {
    const tx = txWithRows([[], [], []]);
    mockListLeaveRequests.mockResolvedValue([]);
    mockFindDaysForRequests.mockResolvedValue(new Map());

    await serviceOver(tx).listMine(techUser(), {
      from: '2026-11-01',
      to: '2026-11-30',
      limit: 20,
    });

    const input = mockListLeaveRequests.mock.calls[0][1] as {
      from?: string;
      to?: string;
    };
    expect(input.from).toBeUndefined();
    expect(input.to).toBeUndefined();
  });

  it('the owner list forwards the free-text needle to the repository; the me list drops it', async () => {
    mockListLeaveRequests.mockReset();
    mockListLeaveRequests.mockResolvedValue([]);
    mockFindDaysForRequests.mockResolvedValue(new Map());
    mockReadPageSpanFacts.mockResolvedValue(new Map());
    mockFindOfficeNames.mockResolvedValue(new Map());

    await serviceOver(txWithRows([[], [], []])).listForOwner(ownerUser(), {
      q: 'Asha',
      limit: 20,
    });
    expect((mockListLeaveRequests.mock.calls[0][1] as { q?: string }).q).toBe(
      'Asha',
    );

    mockListLeaveRequests.mockClear();
    await serviceOver(txWithRows([[], [], []])).listMine(techUser(), {
      q: 'Asha',
      limit: 20,
    });
    expect(
      (mockListLeaveRequests.mock.calls[0][1] as { q?: string }).q,
    ).toBeUndefined();
  });
});

describe('LeaveReadService 24-5 — the per-row decision answer', () => {
  const DETAIL_MANAGER = '88888888-8888-4888-8888-888888888888';

  function treeMember(
    user_id: string,
    manager_id: string | null,
    role = 'employee',
    disabled = false,
  ) {
    return { user_id, manager_id, role, status: 'active', disabled };
  }

  function txWithTree(
    treeRows: ReturnType<typeof treeMember>[],
    subtree: string[] = [],
  ) {
    return {
      query: jest.fn((sql: string) => {
        if (sql.includes('with recursive down')) {
          return Promise.resolve({
            rows: subtree.map((user_id) => ({ user_id })),
          });
        }
        if (sql.includes('from public.memberships m')) {
          return Promise.resolve({ rows: treeRows });
        }
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as PoolClient & { query: jest.Mock };
  }

  beforeEach(() => {
    mockListLeaveRequests.mockReset();
    mockFindDaysForRequests.mockReset();
    mockFindOfficeNames.mockReset();
    mockReadPageSpanFacts.mockReset();
    // Delegate the facts batch to the real implementation: it answers one
    // entry per requested employee, which is what listTransact asserts.
    mockReadPageSpanFacts.mockImplementation(
      (...args: Parameters<typeof repoActual.readPageSpanFacts>) =>
        repoActual.readPageSpanFacts(...args),
    );
    mockFindDaysForRequests.mockResolvedValue(new Map());
    mockFindOfficeNames.mockResolvedValue(new Map());
  });

  it('the resolved approver sees canDecide: true', async () => {
    mockListLeaveRequests.mockResolvedValue([
      listRow({
        derived_status: 'pending',
        employee_id: EMP,
        created_by: EMP,
      }),
    ]);
    const tx = txWithTree(
      [treeMember(EMP, MANAGER), treeMember(MANAGER, null)],
      [EMP],
    );

    const result = await serviceOver(tx).listForOwner(managerUser(), {
      status: 'pending',
    });

    expect(result.data[0].decision).toEqual({ canDecide: true, reason: null });
  });

  it('a manager above the resolved approver sees the row read-only, with a reason', async () => {
    mockListLeaveRequests.mockResolvedValue([
      listRow({
        derived_status: 'pending',
        employee_id: EMP,
        created_by: EMP,
      }),
    ]);
    const tx = txWithTree(
      [
        treeMember(EMP, MANAGER),
        treeMember(MANAGER, DETAIL_MANAGER),
        treeMember(DETAIL_MANAGER, null),
      ],
      [EMP, MANAGER],
    );

    const result = await serviceOver(tx).listForOwner(
      { ...managerUser(), userId: DETAIL_MANAGER },
      { status: 'pending' },
    );

    expect(result.data[0].decision).toEqual({
      canDecide: false,
      reason: 'higher_manager',
    });
  });

  it('an on-behalf filing routes from the subject, so the filer cannot decide it', async () => {
    mockListLeaveRequests.mockResolvedValue([
      listRow({
        derived_status: 'pending',
        employee_id: EMP,
        // The manager filed on EMP's behalf: the actor is excluded from the
        // walk, so the request goes to the next manager up.
        created_by: MANAGER,
      }),
    ]);
    const tx = txWithTree(
      [
        treeMember(EMP, MANAGER),
        treeMember(MANAGER, DETAIL_MANAGER),
        treeMember(DETAIL_MANAGER, null),
      ],
      [EMP],
    );

    const filer = await serviceOver(tx).listForOwner(managerUser(), {
      status: 'pending',
    });
    expect(filer.data[0].decision).toEqual({
      canDecide: false,
      reason: 'higher_manager',
    });

    const above = await serviceOver(tx).listForOwner(
      { ...managerUser(), userId: DETAIL_MANAGER },
      { status: 'pending' },
    );
    expect(above.data[0].decision).toEqual({
      canDecide: true,
      reason: null,
    });
  });

  it('a decided row answers not_pending without loading the tree', async () => {
    mockListLeaveRequests.mockResolvedValue([
      listRow({ derived_status: 'approved' }),
    ]);
    const tx = txWithTree([]);

    const result = await serviceOver(tx).listForOwner(ownerUser(), {});
    expect(result.data[0].decision).toEqual({
      canDecide: false,
      reason: 'not_pending',
    });

    const treeReads = tx.query.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('from public.memberships m'),
    );
    expect(treeReads).toHaveLength(0);
  });

  it('a corrupt loop answers unresolved for a manager (an admin can still override)', async () => {
    mockListLeaveRequests.mockResolvedValue([
      listRow({
        derived_status: 'pending',
        employee_id: EMP,
        created_by: EMP,
      }),
    ]);
    // EMP -> A (disabled) -> EMP closes the loop the walk cannot resolve.
    const tx = txWithTree(
      [
        treeMember(EMP, DETAIL_MANAGER),
        treeMember(DETAIL_MANAGER, EMP, 'employee', true),
      ],
      [EMP],
    );

    const manager = await serviceOver(tx).listForOwner(managerUser(), {
      status: 'pending',
    });
    expect(manager.data[0].decision).toEqual({
      canDecide: false,
      reason: 'unresolved',
    });

    const admin = await serviceOver(tx).listForOwner(ownerUser(), {
      status: 'pending',
    });
    expect(admin.data[0].decision).toEqual({
      canDecide: true,
      reason: null,
    });
  });

  it('the walk runs once per (employee, filer) pair, not once per row', async () => {
    mockListLeaveRequests.mockResolvedValue([
      listRow({ id: 'r1', derived_status: 'pending' }),
      listRow({ id: 'r2', derived_status: 'pending' }),
      listRow({ id: 'r3', derived_status: 'pending' }),
    ]);
    const tx = txWithTree(
      [treeMember(EMP, MANAGER), treeMember(MANAGER, null)],
      [EMP],
    );

    const result = await serviceOver(tx).listForOwner(managerUser(), {
      status: 'pending',
    });

    expect(result.data.map((row) => row.decision)).toEqual([
      { canDecide: true, reason: null },
      { canDecide: true, reason: null },
      { canDecide: true, reason: null },
    ]);
    const treeReads = tx.query.mock.calls.filter(
      (call: unknown[]) =>
        String(call[0]).includes('from public.memberships m') &&
        !String(call[0]).includes('with recursive down'),
    );
    expect(treeReads).toHaveLength(1);
  });
});

describe('LeaveReadService readSummary — the rail\u2019s team-size fact and the pills\u2019 counts', () => {
  it('answers the headcount plus the whole-tenant counts by derived status', async () => {
    mockCountActiveEmployees.mockReset();
    mockCountActiveEmployees.mockResolvedValue(4);
    mockCountLeaveRequestsByStatus.mockReset();
    mockCountLeaveRequestsByStatus.mockResolvedValue({
      pending: 3,
      approved: 11,
      revoked: 2,
      cancelled: 1,
      rejected: 1,
    });

    const result = await serviceOver({} as PoolClient).readSummary(ownerUser());

    expect(result).toEqual({
      activeEmployees: 4,
      counts: {
        pending: 3,
        approved: 11,
        revoked: 2,
        cancelled: 1,
        rejected: 1,
      },
    });
    expect(mockCountActiveEmployees).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
    );
    expect(mockCountLeaveRequestsByStatus).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
    );
  });
});

describe('LeaveReadService readCoverage — the details card\u2019s coverage check', () => {
  const REQUEST = {
    request: {
      id: ROW_ID,
      tenant_id: TENANT,
      employee_id: EMP,
      request_id: '44444444-4444-4444-8444-444444444444',
      start_date: '2026-11-27',
      end_date: '2026-11-28',
      part: 'full_day' as const,
      reason: '',
      created_by: EMP,
      created_at: '2026-11-20T10:00:00.000Z',
    },
    days: [],
  };
  const OFFICE = { officeId: 'o-1', officeName: 'San Francisco Office' };

  beforeEach(() => {
    for (const mock of [
      mockFindRequestWithDays,
      mockTenantToday,
      mockFindOfficeAssignment,
      mockFindAvailableColleagues,
      mockReadPageSpanFacts,
    ]) {
      mock.mockReset();
    }
    mockTenantToday.mockResolvedValue('2026-11-24');
    mockFindRequestWithDays.mockResolvedValue(REQUEST);
  });

  it('scopes the roster to the span-start office and names the first available colleague — everything anchors at the SPAN, not today', async () => {
    mockFindOfficeAssignment.mockResolvedValue(OFFICE);
    mockFindAvailableColleagues.mockResolvedValue([
      { id: 'c-1', name: 'Priya Sharma' },
      { id: 'c-2', name: 'Ravi Kumar' },
    ]);

    const result = await serviceOver({} as PoolClient).readCoverage(
      ownerUser(),
      ROW_ID,
    );

    expect(result).toEqual({
      officeName: 'San Francisco Office',
      availableCount: 2,
      onDutyName: 'Priya Sharma',
      anchorDate: '2026-11-27',
    });
    // `anchor` is the span's FIRST day — an upcoming leave after a planned
    // transfer answers the office the leave starts under.
    expect(mockFindOfficeAssignment).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      EMP,
      '2026-11-27',
    );
    expect(mockFindAvailableColleagues).toHaveBeenCalledWith(
      expect.anything(),
      {
        tenantId: TENANT,
        excludeEmployeeId: EMP,
        anchor: '2026-11-27',
        officeId: OFFICE.officeId,
        start: '2026-11-27',
        end: '2026-11-28',
      },
    );
    // A multi-day span keeps the plain leave-free roster — the working-day
    // filter is a single-day refinement only.
    expect(mockReadPageSpanFacts).not.toHaveBeenCalled();
  });

  it('falls back to the company-wide roster when the requester has no office', async () => {
    mockFindOfficeAssignment.mockResolvedValue(null);
    mockFindAvailableColleagues.mockResolvedValue([]);

    const result = await serviceOver({} as PoolClient).readCoverage(
      ownerUser(),
      ROW_ID,
    );

    expect(result).toEqual({
      officeName: null,
      availableCount: 0,
      onDutyName: null,
      anchorDate: '2026-11-27',
    });
    expect(mockFindAvailableColleagues).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ officeId: null }),
    );
  });

  it('pairs on duty with the first NAMED colleague — an unnamed member ahead in name order never renders a blank name', async () => {
    mockFindOfficeAssignment.mockResolvedValue(OFFICE);
    mockFindAvailableColleagues.mockResolvedValue([
      // PG ASC orders NULLS LAST (a null name trails at the END), but ''
      // sorts FIRST among real names — the truthiness pick must skip both.
      { id: 'c-0', name: null },
      { id: 'c-0b', name: '' },
      { id: 'c-1', name: 'Ravi Kumar' },
    ]);

    const result = await serviceOver({} as PoolClient).readCoverage(
      ownerUser(),
      ROW_ID,
    );

    expect(result.availableCount).toBe(3);
    expect(result.onDutyName).toBe('Ravi Kumar');
  });

  it('a PAST span anchors the reads at the span start too — the office the leave opened under, not today\u2019s', async () => {
    mockFindRequestWithDays.mockResolvedValue({
      ...REQUEST,
      request: {
        ...REQUEST.request,
        start_date: '2026-11-10',
        end_date: '2026-11-12',
      },
    });
    mockFindOfficeAssignment.mockResolvedValue(OFFICE);
    mockFindAvailableColleagues.mockResolvedValue([
      { id: 'c-1', name: 'Then Roster' },
    ]);

    const result = await serviceOver({} as PoolClient).readCoverage(
      ownerUser(),
      ROW_ID,
    );

    // tenantToday is 2026-11-24 — every date-anchored read answers
    // 2026-11-10, the day the span opened (the planned-transfer story's
    // inverse: who covered it THEN, not who is around now).
    expect(result.anchorDate).toBe('2026-11-10');
    expect(mockFindOfficeAssignment).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      EMP,
      '2026-11-10',
    );
    expect(mockFindAvailableColleagues).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        anchor: '2026-11-10',
        start: '2026-11-10',
        end: '2026-11-12',
      }),
    );
  });

  it('a single-day span drops weekly-off/holiday colleagues — available reads actually working that day (batched span facts)', async () => {
    mockFindRequestWithDays.mockResolvedValue({
      ...REQUEST,
      request: {
        ...REQUEST.request,
        start_date: '2026-11-27',
        end_date: '2026-11-27',
      },
    });
    mockFindOfficeAssignment.mockResolvedValue(OFFICE);
    mockFindAvailableColleagues.mockResolvedValue([
      { id: 'c-1', name: 'Off Roster' },
      { id: 'c-2', name: 'Ravi Kumar' },
    ]);
    const facts = new Map([
      [
        'c-1',
        new Map([
          [
            '2026-11-27',
            { date: '2026-11-27', isWorkingDay: false, kind: 'weekly_off' },
          ],
        ]),
      ],
      [
        'c-2',
        new Map([
          [
            '2026-11-27',
            { date: '2026-11-27', isWorkingDay: true, kind: 'working' },
          ],
        ]),
      ],
    ]);
    mockReadPageSpanFacts.mockResolvedValue(facts);

    const result = await serviceOver({} as PoolClient).readCoverage(
      ownerUser(),
      ROW_ID,
    );

    expect(result).toEqual({
      officeName: 'San Francisco Office',
      availableCount: 1,
      onDutyName: 'Ravi Kumar',
      anchorDate: '2026-11-27',
    });
    expect(mockReadPageSpanFacts).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      [
        { employeeId: 'c-1', dates: ['2026-11-27'] },
        { employeeId: 'c-2', dates: ['2026-11-27'] },
      ],
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('a fact-less roster member stays IN — the filter only proves someone off, never invents an absence', async () => {
    mockFindRequestWithDays.mockResolvedValue({
      ...REQUEST,
      request: {
        ...REQUEST.request,
        start_date: '2026-11-27',
        end_date: '2026-11-27',
      },
    });
    mockFindOfficeAssignment.mockResolvedValue(OFFICE);
    mockFindAvailableColleagues.mockResolvedValue([
      { id: 'c-1', name: 'Solo' },
    ]);
    mockReadPageSpanFacts.mockResolvedValue(new Map()); // the read missed entirely

    const result = await serviceOver({} as PoolClient).readCoverage(
      ownerUser(),
      ROW_ID,
    );

    expect(result.availableCount).toBe(1);
    expect(result.onDutyName).toBe('Solo');
  });

  it('a manager reads coverage for a report\u2019s request', async () => {
    const tx = txWithSubtree([EMP]);
    mockFindOfficeAssignment.mockResolvedValue(OFFICE);
    mockFindAvailableColleagues.mockResolvedValue([]);

    const result = await serviceOver(tx).readCoverage(managerUser(), ROW_ID);

    expect(result.anchorDate).toBe('2026-11-27');
  });

  it('a manager\u2019s coverage read for another branch is 404, no roster read', async () => {
    const tx = txWithSubtree(['someone-else']);
    const thrown = await serviceOver(tx)
      .readCoverage(managerUser(), ROW_ID)
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(
      (thrown as HttpException).getResponse() as { error_code: string },
    ).toMatchObject({ error_code: 'LEAVE_REQUEST_NOT_FOUND' });
    expect(mockFindAvailableColleagues).not.toHaveBeenCalled();
  });

  it('a caller with no reports gets 403 even when the request does not exist — no existence oracle', async () => {
    const tx = txWithSubtree([]);
    mockFindRequestWithDays.mockResolvedValue(null);

    const thrown = await serviceOver(tx)
      .readCoverage(techUser(), ROW_ID)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(mockFindRequestWithDays).not.toHaveBeenCalled();
  });

  it('404s a request outside the tenant — no existence leak, no roster read', async () => {
    mockFindRequestWithDays.mockResolvedValue(null);
    const thrown = await serviceOver({} as PoolClient)
      .readCoverage(ownerUser(), ROW_ID)
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(mockFindAvailableColleagues).not.toHaveBeenCalled();
  });

  it('reads the request with the OWNER\u2019s tenant id — the isolation-bearing first read', async () => {
    mockFindOfficeAssignment.mockResolvedValue(null);
    mockFindAvailableColleagues.mockResolvedValue([]);
    await serviceOver({} as PoolClient).readCoverage(ownerUser(), ROW_ID);
    expect(mockFindRequestWithDays).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      ROW_ID,
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

  it('24-3: a manager previews on-behalf only inside their subtree — outside is an inline refusal, never a 404', async () => {
    const service = serviceOver(txWithSubtree([]));
    const dto = new OnBehalfPreviewQueryDto();
    dto.employeeId = EMP;
    dto.startDate = '2026-11-23';
    dto.endDate = '2026-11-24';
    dto.part = 'full_day';

    const result = await service.previewApplyOnBehalf(managerUser(), dto);

    expect(result).toEqual({
      ok: false,
      errorCode: 'ATTENDANCE_EMPLOYEE_NOT_FOUND',
      message: 'Employee not found in your company',
    });
    expect(mockReadEnrolmentFloor).not.toHaveBeenCalled();
  });

  it('24-3: a manager previews on-behalf inside their subtree', async () => {
    previewOk(txWithSubtree([EMP]), SICK_TYPE);
    const service = serviceOver(txWithSubtree([EMP]));
    const dto = new OnBehalfPreviewQueryDto();
    dto.employeeId = EMP;
    dto.startDate = '2026-11-23';
    dto.endDate = '2026-11-24';
    dto.part = 'full_day';
    dto.leaveTypeId = SICK_TYPE.id;

    await expect(
      service.previewApplyOnBehalf(managerUser(), dto),
    ).resolves.toMatchObject({ ok: true, workingDays: 2 });
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
