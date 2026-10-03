import type { PoolClient } from 'pg';
import { Role } from '../common/enums/role.enum';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import type { RequestUser } from '../common/interfaces/request-user.interface';
import { LeaveReadService } from './leave-read.service';
import type { LeaveListRow, PageSpan } from './leave.repository';

/**
 * The list wiring (listTransact) at the service layer. The repository spec
 * pins the batch SQL; THIS pins what the review caught nothing else does:
 * the row → PageSpan → facts-lookup chain that every list row's
 * `workingDays` flows through. A keying regression there (say, spans built
 * from `row.id`) would otherwise ship `workingDays: 0` on every row with a
 * green suite — the batch is real here, so the count is derived end to end.
 */

const repoActual = jest.requireActual(
  './leave.repository',
) as typeof import('./leave.repository');

const mockListLeaveRequests = jest.fn();
const mockFindDaysForRequests = jest.fn();
const mockReadPageSpanFacts = jest.fn();

jest.mock('./leave.repository', () => ({
  ...jest.requireActual('./leave.repository'),
  listLeaveRequests: (...args: unknown[]) => mockListLeaveRequests(...args),
  findDaysForRequests: (...args: unknown[]) => mockFindDaysForRequests(...args),
  readPageSpanFacts: (...args: unknown[]) => mockReadPageSpanFacts(...args),
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
    derived_status: 'approved',
    ...overrides,
  };
}

function ownerUser(): RequestUser {
  return { userId: OWNER, tenantId: TENANT, role: Role.OWNER, rawJwt: 'jwt' };
}

function techUser(): RequestUser {
  return {
    userId: EMP,
    tenantId: TENANT,
    role: Role.TECHNICIAN,
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
  return new LeaveReadService(pool as unknown as PgPoolFactory);
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
