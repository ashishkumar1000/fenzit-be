import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { HolidaysService } from './holidays.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ErrorCode } from '../common/enums/error-code.enum';

/**
 * 15-2/15-3's chain builders specialised for HolidaysService's call shapes:
 * the holidays table serves the list chain (select → eq → order, awaited)
 * and the post-update re-read (select → eq → eq → maybeSingle, awaited) —
 * both consume one queued result per await. rpc(name, args) dispatches on
 * name with its own result queue and call log.
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

const TENANT_ID = '00000000-0000-4000-8000-0000000000c6';
const HOLIDAY_ID = '00000000-0000-4000-8000-0000000000e6';

const holidayRow = {
  id: HOLIDAY_ID,
  tenant_id: TENANT_ID,
  holiday_date: '2026-10-02',
  name: 'Gandhi Jayanti',
  created_at: '2026-09-27T00:00:00Z',
  updated_at: '2026-09-27T00:00:00Z',
};

describe('HolidaysService (story 15-5)', () => {
  let service: HolidaysService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;

  const ownerUser: RequestUser = {
    userId: 'owner-uuid',
    tenantId: TENANT_ID,
    role: Role.OWNER,
    rawJwt: 'mock-jwt',
  };
  const noTenantUser: RequestUser = { ...ownerUser, tenantId: null };

  function mockAdmin(opts: {
    holidays?: RpcResult[];
    rpc?: Record<string, RpcResult[]>;
  } = {}) {
    const holidaysQb = flexQb({ data: [], error: null });
    for (const r of opts.holidays ?? []) holidaysQb.queue.push(r);

    const rpcs = new Map<string, ReturnType<typeof rpcQueue>>();
    for (const [name, results] of Object.entries(opts.rpc ?? {})) {
      rpcs.set(name, rpcQueue(...results));
    }

    const from = jest.fn((table: string) => {
      switch (table) {
        case 'holidays':
          return holidaysQb.qb;
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

    return { from, rpc, holidaysQb, rpcs };
  }

  beforeEach(async () => {
    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HolidaysService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
      ],
    }).compile();

    service = module.get<HolidaysService>(HolidaysService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
  });

  describe('listHolidays', () => {
    it('maps rows to { id, date, name }, tenant-scoped, ordered by date ascending', async () => {
      const q = mockAdmin({
        holidays: [
          {
            data: [
              holidayRow,
              { ...holidayRow, id: 'h2', holiday_date: '2026-12-25', name: 'Christmas' },
            ],
            error: null,
          },
        ],
        rpc: { attendance_today: [{ data: '2026-09-27', error: null }] },
      });

      await expect(service.listHolidays(ownerUser)).resolves.toEqual([
        { id: HOLIDAY_ID, date: '2026-10-02', name: 'Gandhi Jayanti' },
        { id: 'h2', date: '2026-12-25', name: 'Christmas' },
      ]);
      expect(q.holidaysQb.qb.select).toHaveBeenCalledWith('*');
      expect(q.holidaysQb.qb.eq).toHaveBeenCalledWith('tenant_id', TENANT_ID);
      expect(q.holidaysQb.qb.order).toHaveBeenCalledWith('holiday_date', { ascending: true });
    });

    it('returns [] when the tenant has no holidays — no rows is not a 404', async () => {
      mockAdmin({ rpc: { attendance_today: [{ data: '2026-09-27', error: null }] } });

      await expect(service.listHolidays(ownerUser)).resolves.toEqual([]);
    });

    it('maps an unknown tenant to 404 ATTENDANCE_TENANT_NOT_FOUND (uniform stale-tenant contract)', async () => {
      const q = mockAdmin();
      q.rpcs.set('attendance_today', rpcQueue({
        data: null,
        error: { code: 'PT404', hint: 'ATTENDANCE_TENANT_NOT_FOUND', message: 'no tenant' },
      }));

      await expectErrorCode(
        service.listHolidays(ownerUser),
        404,
        ErrorCode.ATTENDANCE_TENANT_NOT_FOUND,
      );
      expect(q.from).not.toHaveBeenCalled();
    });

    it('requires a tenant — 400 VALIDATION_ERROR before any client call', async () => {
      const q = mockAdmin();

      await expectErrorCode(
        service.listHolidays(noTenantUser),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(q.from).not.toHaveBeenCalled();
    });

    it('maps a read failure to 500 INTERNAL_SERVER_ERROR', async () => {
      mockAdmin({
        holidays: [{ data: null, error: { code: 'XX000' } }],
        rpc: { attendance_today: [{ data: '2026-09-27', error: null }] },
      });

      await expectErrorCode(
        service.listHolidays(ownerUser),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
    });
  });

  describe('createHoliday', () => {
    const dto = { date: '2026-10-02', name: 'Gandhi Jayanti' };

    it('calls attendance_add_holiday and returns the created holiday', async () => {
      const q = mockAdmin();
      q.rpcs.set('attendance_add_holiday', rpcQueue({ data: HOLIDAY_ID, error: null }));

      await expect(service.createHoliday(ownerUser, dto)).resolves.toEqual({
        id: HOLIDAY_ID,
        date: '2026-10-02',
        name: 'Gandhi Jayanti',
      });
      expect(q.rpc).toHaveBeenCalledWith('attendance_add_holiday', {
        p_tenant_id: TENANT_ID,
        p_holiday_date: '2026-10-02',
        p_name: 'Gandhi Jayanti',
      });
    });

    it('maps the duplicate-date PT409 to 409 ATTENDANCE_HOLIDAY_TAKEN', async () => {
      const q = mockAdmin();
      q.rpcs.set('attendance_add_holiday', rpcQueue({
        data: null,
        error: { code: 'PT409', hint: 'ATTENDANCE_HOLIDAY_TAKEN', message: 'taken' },
      }));

      await expectErrorCode(
        service.createHoliday(ownerUser, dto),
        409,
        ErrorCode.ATTENDANCE_HOLIDAY_TAKEN,
      );
    });

    it('maps the unknown-tenant PT404 to 404 ATTENDANCE_TENANT_NOT_FOUND', async () => {
      const q = mockAdmin();
      q.rpcs.set('attendance_add_holiday', rpcQueue({
        data: null,
        error: { code: 'PT404', hint: 'ATTENDANCE_TENANT_NOT_FOUND', message: 'no tenant' },
      }));

      await expectErrorCode(
        service.createHoliday(ownerUser, dto),
        404,
        ErrorCode.ATTENDANCE_TENANT_NOT_FOUND,
      );
    });

    it('maps a resolved-without-id (RPC contract break) to 500', async () => {
      const q = mockAdmin();
      q.rpcs.set('attendance_add_holiday', rpcQueue({ data: null, error: null }));

      await expectErrorCode(
        service.createHoliday(ownerUser, dto),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
    });

    it('maps any other RPC failure to 500', async () => {
      const q = mockAdmin();
      q.rpcs.set('attendance_add_holiday', rpcQueue({
        data: null,
        error: { code: 'XX000', message: 'boom' },
      }));

      await expectErrorCode(
        service.createHoliday(ownerUser, dto),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
    });

    it('requires a tenant — 400 before any client call', async () => {
      const q = mockAdmin();

      await expectErrorCode(
        service.createHoliday(noTenantUser, dto),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(q.rpc).not.toHaveBeenCalled();
    });
  });

  describe('updateHoliday', () => {
    it('calls attendance_update_holiday (name only) and returns the re-read row', async () => {
      const q = mockAdmin({
        holidays: [
          { data: { ...holidayRow, name: 'Diwali' }, error: null },
        ],
      });
      q.rpcs.set('attendance_update_holiday', rpcQueue({ data: null, error: null }));

      await expect(
        service.updateHoliday(ownerUser, HOLIDAY_ID, { name: 'Diwali' }),
      ).resolves.toEqual({ id: HOLIDAY_ID, date: '2026-10-02', name: 'Diwali' });
      expect(q.rpc).toHaveBeenCalledWith('attendance_update_holiday', {
        p_tenant_id: TENANT_ID,
        p_holiday_id: HOLIDAY_ID,
        p_name: 'Diwali',
      });
      // The re-read is tenant-scoped — a foreign id cannot leak.
      expect(q.holidaysQb.qb.eq).toHaveBeenCalledWith('id', HOLIDAY_ID);
      expect(q.holidaysQb.qb.eq).toHaveBeenCalledWith('tenant_id', TENANT_ID);
    });

    it('maps the unknown-id PT404 to 404 ATTENDANCE_HOLIDAY_NOT_FOUND', async () => {
      const q = mockAdmin();
      q.rpcs.set('attendance_update_holiday', rpcQueue({
        data: null,
        error: { code: 'PT404', hint: 'ATTENDANCE_HOLIDAY_NOT_FOUND', message: 'missing' },
      }));

      await expectErrorCode(
        service.updateHoliday(ownerUser, HOLIDAY_ID, { name: 'Diwali' }),
        404,
        ErrorCode.ATTENDANCE_HOLIDAY_NOT_FOUND,
      );
    });

    it('maps a vanished post-update row (deleted between RPC and read) to 404', async () => {
      const q = mockAdmin({ holidays: [{ data: null, error: null }] });
      q.rpcs.set('attendance_update_holiday', rpcQueue({ data: null, error: null }));

      await expectErrorCode(
        service.updateHoliday(ownerUser, HOLIDAY_ID, { name: 'Diwali' }),
        404,
        ErrorCode.ATTENDANCE_HOLIDAY_NOT_FOUND,
      );
    });
  });

  describe('removeHoliday', () => {
    it('calls attendance_remove_holiday and resolves null (204 at the route)', async () => {
      const q = mockAdmin();
      q.rpcs.set('attendance_remove_holiday', rpcQueue({ data: null, error: null }));

      await expect(service.removeHoliday(ownerUser, HOLIDAY_ID)).resolves.toBeNull();
      expect(q.rpc).toHaveBeenCalledWith('attendance_remove_holiday', {
        p_tenant_id: TENANT_ID,
        p_holiday_id: HOLIDAY_ID,
      });
    });

    it('maps the unknown-id PT404 to 404 ATTENDANCE_HOLIDAY_NOT_FOUND', async () => {
      const q = mockAdmin();
      q.rpcs.set('attendance_remove_holiday', rpcQueue({
        data: null,
        error: { code: 'PT404', hint: 'ATTENDANCE_HOLIDAY_NOT_FOUND', message: 'missing' },
      }));

      await expectErrorCode(
        service.removeHoliday(ownerUser, HOLIDAY_ID),
        404,
        ErrorCode.ATTENDANCE_HOLIDAY_NOT_FOUND,
      );
    });

    it('requires a tenant — 400 before any client call', async () => {
      const q = mockAdmin();

      await expectErrorCode(
        service.removeHoliday(noTenantUser, HOLIDAY_ID),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(q.rpc).not.toHaveBeenCalled();
    });
  });

  describe('getImpact', () => {
    it('maps the preview rows to camelCase', async () => {
      const q = mockAdmin();
      q.rpcs.set('attendance_holiday_impact', rpcQueue({
        data: [
          { employee_id: 'emp-1', employee_name: 'Ravi Kumar' },
          { employee_id: 'emp-2', employee_name: 'Priya Sharma' },
        ],
        error: null,
      }));

      await expect(
        service.getImpact(ownerUser, { date: '2026-10-02' }),
      ).resolves.toEqual({
        date: '2026-10-02',
        affectedEmployees: [
          { employeeId: 'emp-1', employeeName: 'Ravi Kumar' },
          { employeeId: 'emp-2', employeeName: 'Priya Sharma' },
        ],
      });
      expect(q.rpc).toHaveBeenCalledWith('attendance_holiday_impact', {
        p_tenant_id: TENANT_ID,
        p_date: '2026-10-02',
      });
    });

    it('returns the empty preview pre-15-7 — 200, never a 42P01 failure', async () => {
      const q = mockAdmin();
      q.rpcs.set('attendance_holiday_impact', rpcQueue({ data: [], error: null }));

      await expect(
        service.getImpact(ownerUser, { date: '2030-01-01' }),
      ).resolves.toEqual({ date: '2030-01-01', affectedEmployees: [] });
    });

    it('maps the unknown-tenant PT404 to 404 (fail-loud attendance_today)', async () => {
      const q = mockAdmin();
      q.rpcs.set('attendance_holiday_impact', rpcQueue({
        data: null,
        error: { code: 'PT404', hint: 'ATTENDANCE_TENANT_NOT_FOUND', message: 'no tenant' },
      }));

      await expectErrorCode(
        service.getImpact(ownerUser, { date: '2026-10-02' }),
        404,
        ErrorCode.ATTENDANCE_TENANT_NOT_FOUND,
      );
    });

    it('requires a tenant — 400 before any client call', async () => {
      const q = mockAdmin();

      await expectErrorCode(
        service.getImpact(noTenantUser, { date: '2026-10-02' }),
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
