import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { WeeklyOffsService } from './weekly-offs.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ErrorCode } from '../common/enums/error-code.enum';

/**
 * 15-2/15-3's chain builders specialised for WeeklyOffsService's call shapes:
 * - today is one rpc (attendance_today) — stubbed per test (AD-7).
 * - the defaults/overrides tables serve read chains (select → eq [→ eq],
 *   awaited directly); the users table serves the name lookup
 *   (select → eq → in, awaited). All await via the chain's `then`, which
 *   shifts a result queue (mockResolvedValueOnce ordering, as 15-2's
 *   startSetup).
 * rpc(name, args) dispatches on name; each name holds its own result queue
 * and call log, so a write RPC's args are observable.
 */
type RpcResult = {
  data: unknown;
  error: { code?: string; hint?: string; message?: string } | null;
};

function resultQueue(fallback: RpcResult, ...queued: RpcResult[]) {
  return {
    next: () => (queued.length > 0 ? (queued.shift() as RpcResult) : fallback),
    push: (r: RpcResult) => queued.push(r),
  };
}

function flexQb(defaultResult: RpcResult) {
  const queue = resultQueue(defaultResult);
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['select', 'eq', 'is', 'order', 'in', 'update', 'maybeSingle', 'single']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  // Awaiting the chain consumes exactly one queued result.
  (qb as unknown as { then: unknown }).then = jest.fn(
    (resolve: (v: RpcResult) => unknown) => Promise.resolve(resolve(queue.next())),
  );
  return { qb, queue };
}

function rpcQueue(...queued: RpcResult[]) {
  const calls: Array<Record<string, unknown>> = [];
  return { queue: resultQueue({ data: null, error: null }, ...queued), calls };
}

/**
 * Shared across all describes: asserts the rejection is an HttpException with
 * BOTH the HTTP status and the stable error_code body field (plus any extra
 * body keys a test needs to pin) — a bare status match would let two
 * different failure modes pass. Same pattern as the 15-2/15-3 service specs.
 */
async function expectErrorCode(
  promise: Promise<unknown>,
  status: number,
  errorCode: ErrorCode,
  extra: Record<string, unknown> = {},
) {
  await expect(promise).rejects.toBeInstanceOf(HttpException);
  await promise.catch((e: HttpException) => {
    expect(e.getStatus()).toBe(status);
    expect(e.getResponse()).toMatchObject({
      error_code: errorCode,
      ...extra,
    });
  });
}

const TENANT_ID = '00000000-0000-4000-8000-0000000000c5';
const EMPLOYEE_ID = '00000000-0000-4000-8000-0000000000e5';
const TODAY = '2026-09-27';

const defaultRow = {
  id: 'wo-1',
  tenant_id: TENANT_ID,
  valid: '[2026-09-20,)',
  days: [7, 6],
  created_at: '2026-09-20T00:00:00Z',
  updated_at: '2026-09-20T00:00:00Z',
};

const overrideRow = {
  id: 'wo-o1',
  tenant_id: TENANT_ID,
  employee_id: EMPLOYEE_ID,
  valid: '[2026-09-25,)',
  days: [5],
  created_at: '2026-09-25T00:00:00Z',
  updated_at: '2026-09-25T00:00:00Z',
};

describe('WeeklyOffsService (story 15-5)', () => {
  let service: WeeklyOffsService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;

  const ownerUser: RequestUser = {
    userId: 'owner-uuid',
    tenantId: TENANT_ID,
    role: Role.OWNER,
    rawJwt: 'mock-jwt',
  };
  const noTenantUser: RequestUser = { ...ownerUser, tenantId: null };

  /**
   * Per-test wiring: flex query builders per table (result queues, call
   * records) and per-name RPC queues. Unqueued results default to success
   * with null data, so tests queue only what they assert on.
   */
  function mockAdmin(opts: {
    defaults?: RpcResult[];
    overrides?: RpcResult[];
    users?: RpcResult[];
    rpc?: Record<string, RpcResult[]>;
  } = {}) {
    const defaultsQb = flexQb({ data: [], error: null });
    for (const r of opts.defaults ?? []) defaultsQb.queue.push(r);
    const overridesQb = flexQb({ data: [], error: null });
    for (const r of opts.overrides ?? []) overridesQb.queue.push(r);
    const usersQb = flexQb({ data: [], error: null });
    for (const r of opts.users ?? []) usersQb.queue.push(r);

    const rpcs = new Map<string, ReturnType<typeof rpcQueue>>();
    for (const [name, results] of Object.entries(opts.rpc ?? {})) {
      rpcs.set(name, rpcQueue(...results));
    }

    const from = jest.fn((table: string) => {
      switch (table) {
        case 'attendance_weekly_off_defaults':
          return defaultsQb.qb;
        case 'attendance_weekly_off_overrides':
          return overridesQb.qb;
        case 'users':
          return usersQb.qb;
        default:
          throw new Error(`unexpected table ${table}`);
      }
    });
    const rpc = jest.fn((name: string, args?: Record<string, unknown>) => {
      const q = rpcs.get(name);
      if (!q) throw new Error(`unexpected rpc ${name}`);
      q.calls.push(args ?? {});
      return Promise.resolve(q.queue.next());
    });

    supabaseClientFactory.createAdmin.mockReturnValue({
      from,
      rpc,
    } as never);

    return { from, rpc, defaultsQb, overridesQb, usersQb, rpcs };
  }

  /** Every read starts from attendance_today (AD-7). */
  function seeded(q: ReturnType<typeof mockAdmin>) {
    q.rpcs.set('attendance_today', rpcQueue({ data: TODAY, error: null }));
    return q;
  }

  beforeEach(async () => {
    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeeklyOffsService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
      ],
    }).compile();

    service = module.get<WeeklyOffsService>(WeeklyOffsService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
  });

  describe('getWeeklyOffs', () => {
    it('returns the empty state when nothing is configured — 200, never 404', async () => {
      const q = seeded(mockAdmin());

      await expect(service.getWeeklyOffs(ownerUser)).resolves.toEqual({
        default: null,
        next: null,
        history: [],
      });
      expect(q.rpc).toHaveBeenCalledWith('attendance_today', { p_tenant_id: TENANT_ID });
    });

    it('picks the covering range as default, the earliest future edit as next, history ascending', async () => {
      const q = seeded(mockAdmin({
        defaults: [
          {
            data: [
              { ...defaultRow, id: 'wo-past', valid: '[2026-09-01,2026-09-20)', days: [1] },
              defaultRow,
              { ...defaultRow, id: 'wo-next', valid: '[2026-10-05,)', days: [7] },
            ],
            error: null,
          },
        ],
      }));

      await expect(service.getWeeklyOffs(ownerUser)).resolves.toEqual({
        default: { days: [6, 7], validFrom: '2026-09-20', validTo: null },
        next: { days: [7], validFrom: '2026-10-05', validTo: null },
        history: [
          { days: [1], validFrom: '2026-09-01', validTo: '2026-09-20' },
          { days: [6, 7], validFrom: '2026-09-20', validTo: null },
          { days: [7], validFrom: '2026-10-05', validTo: null },
        ],
      });
    });

    it('scopes the read to the tenant', async () => {
      const q = seeded(mockAdmin({ defaults: [{ data: [defaultRow], error: null }] }));

      await service.getWeeklyOffs(ownerUser);

      expect(q.defaultsQb.qb.select).toHaveBeenCalledWith('*');
      expect(q.defaultsQb.qb.eq).toHaveBeenCalledWith('tenant_id', TENANT_ID);
    });

    it('requires a tenant — 400 VALIDATION_ERROR before any client call', async () => {
      const q = seeded(mockAdmin());

      await expectErrorCode(
        service.getWeeklyOffs(noTenantUser),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(q.from).not.toHaveBeenCalled();
    });

    it('maps a read failure to 500 INTERNAL_SERVER_ERROR', async () => {
      seeded(mockAdmin({ defaults: [{ data: null, error: { code: 'XX000' } }] }));

      await expectErrorCode(
        service.getWeeklyOffs(ownerUser),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
    });
  });

  describe('setWeeklyOffDefault', () => {
    it('calls attendance_set_weekly_off_default and responds with the resolved default', async () => {
      const q = seeded(mockAdmin({
        defaults: [{ data: [defaultRow], error: null }],
      }));
      q.rpcs.set('attendance_set_weekly_off_default', rpcQueue({ data: null, error: null }));

      await expect(
        service.setWeeklyOffDefault(ownerUser, { days: [6, 7] }),
      ).resolves.toEqual({
        default: { days: [6, 7], validFrom: '2026-09-20', validTo: null },
        next: null,
        history: [{ days: [6, 7], validFrom: '2026-09-20', validTo: null }],
      });
      expect(q.rpc).toHaveBeenCalledWith('attendance_set_weekly_off_default', {
        p_tenant_id: TENANT_ID,
        p_days: [6, 7],
        p_effective_from: null,
      });
    });

    it('passes an explicit effectiveFrom through (the RPC clamps past dates)', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_set_weekly_off_default', rpcQueue({ data: null, error: null }));

      await service.setWeeklyOffDefault(ownerUser, {
        days: [7],
        effectiveFrom: '2026-10-05',
      });

      expect(q.rpc).toHaveBeenCalledWith(
        'attendance_set_weekly_off_default',
        expect.objectContaining({ p_effective_from: '2026-10-05' }),
      );
    });

    it('allows an empty days array — the explicit clear (all 7 days working)', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_set_weekly_off_default', rpcQueue({ data: null, error: null }));

      await service.setWeeklyOffDefault(ownerUser, { days: [] });

      expect(q.rpc).toHaveBeenCalledWith(
        'attendance_set_weekly_off_default',
        expect.objectContaining({ p_days: [] }),
      );
    });

    it('rejects all seven days with 422 ATTENDANCE_NO_WORKING_DAYS before any DB call', async () => {
      const q = seeded(mockAdmin());

      await expectErrorCode(
        service.setWeeklyOffDefault(ownerUser, { days: [1, 2, 3, 4, 5, 6, 7] }),
        422,
        ErrorCode.ATTENDANCE_NO_WORKING_DAYS,
      );
      expect(q.from).not.toHaveBeenCalled();
      expect(q.rpc).not.toHaveBeenCalled();
    });

    it('maps the RPC PT422 backstop to 422 ATTENDANCE_NO_WORKING_DAYS', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_set_weekly_off_default', rpcQueue({
        data: null,
        error: { code: 'PT422', hint: 'ATTENDANCE_NO_WORKING_DAYS', message: 'seven' },
      }));

      await expectErrorCode(
        service.setWeeklyOffDefault(ownerUser, { days: [6] }),
        422,
        ErrorCode.ATTENDANCE_NO_WORKING_DAYS,
      );
    });

    it('maps the days-CHECK violation (23514) to 422 ATTENDANCE_NO_WORKING_DAYS', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_set_weekly_off_default', rpcQueue({
        data: null,
        error: { code: '23514', message: 'check violation' },
      }));

      await expectErrorCode(
        service.setWeeklyOffDefault(ownerUser, { days: [6] }),
        422,
        ErrorCode.ATTENDANCE_NO_WORKING_DAYS,
      );
    });

    it('maps the unknown-tenant PT404 (ATTENDANCE_TENANT_NOT_FOUND hint) to 404', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_set_weekly_off_default', rpcQueue({
        data: null,
        error: { code: 'PT404', hint: 'ATTENDANCE_TENANT_NOT_FOUND', message: 'no tenant' },
      }));

      await expectErrorCode(
        service.setWeeklyOffDefault(ownerUser, { days: [6] }),
        404,
        ErrorCode.ATTENDANCE_TENANT_NOT_FOUND,
      );
    });

    it('maps any other RPC failure to 500', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_set_weekly_off_default', rpcQueue({
        data: null,
        error: { code: 'XX000', message: 'boom' },
      }));

      await expectErrorCode(
        service.setWeeklyOffDefault(ownerUser, { days: [6] }),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
    });

    it('requires a tenant — 400 before any client call', async () => {
      const q = seeded(mockAdmin());

      await expectErrorCode(
        service.setWeeklyOffDefault(noTenantUser, { days: [6] }),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(q.rpc).not.toHaveBeenCalled();
    });
  });

  describe('listOverrides', () => {
    it('returns [] without reading users when no override exists', async () => {
      const q = seeded(mockAdmin());

      await expect(service.listOverrides(ownerUser)).resolves.toEqual([]);
      expect(q.usersQb.qb.select).not.toHaveBeenCalled();
    });

    it('groups rows per employee, resolves names, sorts by employeeName', async () => {
      const empB = '00000000-0000-4000-8000-0000000000eb';
      const empA = '00000000-0000-4000-8000-0000000000ea';
      const q = seeded(mockAdmin({
        overrides: [
          {
            data: [
              { ...overrideRow, employee_id: empB, days: [5] },
              { ...overrideRow, employee_id: empA, valid: '[2026-10-05,)', days: [1] },
            ],
            error: null,
          },
        ],
        users: [
          {
            data: [
              { id: empA, name: 'Alpha Singh', country_code: '+91', phone_number: '9999900001' },
              { id: empB, name: 'Zeta Kumar', country_code: '+91', phone_number: '9999900002' },
            ],
            error: null,
          },
        ],
      }));

      const result = await service.listOverrides(ownerUser);

      expect(result.map((r) => r.employeeName)).toEqual(['Alpha Singh', 'Zeta Kumar']);
      expect(result[0]).toEqual({
        employeeId: empA,
        employeeName: 'Alpha Singh',
        // A future-only override has nothing covering today.
        current: null,
        next: { days: [1], validFrom: '2026-10-05', validTo: null },
      });
      expect(q.usersQb.qb.select).toHaveBeenCalledWith('id, name, country_code, phone_number');
      expect(q.usersQb.qb.in).toHaveBeenCalledWith('id', [empB, empA]);
    });

    it('falls back to the reassembled E.164 number, then Unknown employee', async () => {
      const q = seeded(mockAdmin({
        overrides: [
          {
            data: [
              { ...overrideRow, employee_id: EMPLOYEE_ID },
              {
                ...overrideRow,
                employee_id: '00000000-0000-4000-8000-0000000000ec',
              },
            ],
            error: null,
          },
        ],
        users: [
          {
            data: [
              // No name — the phone fallback the RPCs also use (20260927000003).
              { id: EMPLOYEE_ID, name: null, country_code: '+91', phone_number: '9999900003' },
            ],
            error: null,
          },
        ],
      }));

      const result = await service.listOverrides(ownerUser);
      const byId = new Map(result.map((r) => [r.employeeId, r.employeeName]));
      expect(byId.get(EMPLOYEE_ID)).toBe('+919999900003');
      expect(byId.get('00000000-0000-4000-8000-0000000000ec')).toBe('Unknown employee');
    });

    it('requires a tenant — 400 before any client call', async () => {
      const q = seeded(mockAdmin());

      await expectErrorCode(
        service.listOverrides(noTenantUser),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(q.from).not.toHaveBeenCalled();
    });
  });

  describe('setOverride', () => {
    const dto = { days: [5] };

    it('calls the override RPC scoped to the employee and returns the picked detail', async () => {
      const q = seeded(mockAdmin({
        overrides: [{ data: [overrideRow], error: null }],
        users: [
          { data: [{ id: EMPLOYEE_ID, name: 'Ravi Kumar', country_code: '+91', phone_number: '9999900004' }], error: null },
        ],
      }));
      q.rpcs.set('attendance_set_weekly_off_override', rpcQueue({ data: null, error: null }));

      await expect(service.setOverride(ownerUser, EMPLOYEE_ID, dto)).resolves.toEqual({
        employeeId: EMPLOYEE_ID,
        employeeName: 'Ravi Kumar',
        current: { days: [5], validFrom: '2026-09-25', validTo: null },
        next: null,
      });
      expect(q.rpc).toHaveBeenCalledWith('attendance_set_weekly_off_override', {
        p_tenant_id: TENANT_ID,
        p_employee_id: EMPLOYEE_ID,
        p_days: [5],
        p_effective_from: null,
      });
      // The detail re-read is employee-scoped.
      expect(q.overridesQb.qb.eq).toHaveBeenCalledWith('employee_id', EMPLOYEE_ID);
    });

    it('rejects all seven days with 422 ATTENDANCE_NO_WORKING_DAYS before any DB call', async () => {
      const q = seeded(mockAdmin());

      await expectErrorCode(
        service.setOverride(ownerUser, EMPLOYEE_ID, { days: [1, 2, 3, 4, 5, 6, 7] }),
        422,
        ErrorCode.ATTENDANCE_NO_WORKING_DAYS,
      );
      expect(q.rpc).not.toHaveBeenCalled();
    });

    it('maps the non-member PT404 to 404 ATTENDANCE_EMPLOYEE_NOT_FOUND', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_set_weekly_off_override', rpcQueue({
        data: null,
        error: { code: 'PT404', hint: 'ATTENDANCE_EMPLOYEE_NOT_FOUND', message: 'not member' },
      }));

      await expectErrorCode(
        service.setOverride(ownerUser, EMPLOYEE_ID, dto),
        404,
        ErrorCode.ATTENDANCE_EMPLOYEE_NOT_FOUND,
      );
    });

    it('maps an empty days override through (works all 7 days)', async () => {
      const q = seeded(mockAdmin({
        overrides: [{ data: [{ ...overrideRow, days: [] }], error: null }],
        users: [{ data: [{ id: EMPLOYEE_ID, name: 'Ravi', country_code: '+91', phone_number: '1' }], error: null }],
      }));
      q.rpcs.set('attendance_set_weekly_off_override', rpcQueue({ data: null, error: null }));

      await expect(service.setOverride(ownerUser, EMPLOYEE_ID, { days: [] })).resolves.toEqual({
        employeeId: EMPLOYEE_ID,
        employeeName: 'Ravi',
        current: { days: [], validFrom: '2026-09-25', validTo: null },
        next: null,
      });
      expect(q.rpc).toHaveBeenCalledWith(
        'attendance_set_weekly_off_override',
        expect.objectContaining({ p_days: [] }),
      );
    });
  });

  describe('removeOverride', () => {
    it('calls the removal RPC and returns the post-removal detail (current null once nothing covers today)', async () => {
      const q = seeded(mockAdmin({
        overrides: [{ data: [], error: null }],
        users: [{ data: [{ id: EMPLOYEE_ID, name: 'Ravi Kumar', country_code: '+91', phone_number: '9999900004' }], error: null }],
      }));
      q.rpcs.set('attendance_remove_weekly_off_override', rpcQueue({ data: null, error: null }));

      await expect(
        service.removeOverride(ownerUser, EMPLOYEE_ID, {}),
      ).resolves.toEqual({
        employeeId: EMPLOYEE_ID,
        employeeName: 'Ravi Kumar',
        current: null,
        next: null,
      });
      expect(q.rpc).toHaveBeenCalledWith('attendance_remove_weekly_off_override', {
        p_tenant_id: TENANT_ID,
        p_employee_id: EMPLOYEE_ID,
        p_effective_from: null,
      });
    });

    it('passes an explicit effectiveFrom through', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_remove_weekly_off_override', rpcQueue({ data: null, error: null }));

      await service.removeOverride(ownerUser, EMPLOYEE_ID, { effectiveFrom: '2026-10-05' });

      expect(q.rpc).toHaveBeenCalledWith(
        'attendance_remove_weekly_off_override',
        expect.objectContaining({ p_effective_from: '2026-10-05' }),
      );
    });

    it('maps the non-member PT404 to 404 (removal of a foreign employee)', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_remove_weekly_off_override', rpcQueue({
        data: null,
        error: { code: 'PT404', hint: 'ATTENDANCE_EMPLOYEE_NOT_FOUND', message: 'not member' },
      }));

      await expectErrorCode(
        service.removeOverride(ownerUser, EMPLOYEE_ID, {}),
        404,
        ErrorCode.ATTENDANCE_EMPLOYEE_NOT_FOUND,
      );
    });

    it('requires a tenant — 400 before any client call', async () => {
      const q = seeded(mockAdmin());

      await expectErrorCode(
        service.removeOverride(noTenantUser, EMPLOYEE_ID, {}),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(q.rpc).not.toHaveBeenCalled();
    });
  });

  it('is injectable with just the Supabase factory (no other providers)', () => {
    expect(service).toBeDefined();
  });
});
