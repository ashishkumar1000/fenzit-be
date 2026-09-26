import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, NotFoundException } from '@nestjs/common';
import { OfficesService } from './offices.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ErrorCode } from '../common/enums/error-code.enum';

/**
 * 15-2's chain builders specialised for OfficesService's call shapes:
 * - today is one rpc (attendance_today) — stubbed per test.
 * - the offices table serves three shapes: the list select chain (select → eq
 *   → is → order, awaited directly), the readOffice chain (select → eq → eq →
 *   maybeSingle) and the guarded UPDATE (update → eq → eq → is → select,
 *   awaited directly). All await via the chain's `then`, which shifts a
 *   result queue (mockResolvedValueOnce ordering, as 15-2's startSetup).
 * - the rules table serves readRulesForOffices (.in, awaited) and
 *   readAllRules (eq + eq, awaited).
 * rpc(name, args) dispatches on name; each name holds its own result queue
 * and call log, so the archive flow's second RPC (blockers) is observable.
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
 * different failure modes pass. Same pattern as 15-2's service spec.
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

const TENANT_ID = '00000000-0000-4000-8000-0000000000c1';
const OFFICE_ID = '00000000-0000-4000-8000-0000000000e1';
const TODAY = '2026-09-26';

const officeRow = {
  id: OFFICE_ID,
  tenant_id: TENANT_ID,
  name: 'Andheri West',
  latitude: 19.1364,
  longitude: 72.8296,
  radius_m: 100,
  archived_at: null,
  created_at: '2026-09-26T00:00:00Z',
  updated_at: '2026-09-26T00:00:00Z',
};

const ruleRow = {
  id: 'rule-1',
  office_id: OFFICE_ID,
  tenant_id: TENANT_ID,
  valid: '[2026-09-26,)',
  start_time: '10:00:00',
  end_time: '18:00:00',
  late_cutoff_minutes: 15,
  full_day_hours: '8.00',
  half_day_hours: '4.00',
  created_at: '2026-09-26T00:00:00Z',
  updated_at: '2026-09-26T00:00:00Z',
};

describe('OfficesService (story 15-3)', () => {
  let service: OfficesService;
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
    offices?: RpcResult[];
    rules?: RpcResult[];
    rpc?: Record<string, RpcResult[]>;
  } = {}) {
    const officesQb = flexQb({ data: [], error: null });
    for (const r of opts.offices ?? []) officesQb.queue.push(r);
    const rulesQb = flexQb({ data: [], error: null });
    for (const r of opts.rules ?? []) rulesQb.queue.push(r);

    const rpcs = new Map<string, ReturnType<typeof rpcQueue>>();
    for (const [name, results] of Object.entries(opts.rpc ?? {})) {
      rpcs.set(name, rpcQueue(...results));
    }

    const from = jest.fn((table: string) => {
      switch (table) {
        case 'attendance_offices':
          return officesQb.qb;
        case 'attendance_office_rules':
          return rulesQb.qb;
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

    return { from, rpc, officesQb, rulesQb, rpcs };
  }

  /** Every service method starts from attendance_today (AD-7). */
  function seeded(q: ReturnType<typeof mockAdmin>) {
    q.rpcs.set('attendance_today', rpcQueue({ data: TODAY, error: null }));
    return q;
  }

  const seededRules = () => ({ data: [ruleRow], error: null });

  beforeEach(async () => {
    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OfficesService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
      ],
    }).compile();

    service = module.get<OfficesService>(OfficesService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
  });

  describe('listOffices', () => {
    it('maps rows to the API shape — the rule covering today, HH:mm times, numeric hours', async () => {
      const q = seeded(mockAdmin({
        offices: [{ data: [officeRow], error: null }],
        rules: [seededRules()],
      }));

      await expect(service.listOffices(ownerUser)).resolves.toEqual([
        {
          id: OFFICE_ID,
          name: 'Andheri West',
          latitude: 19.1364,
          longitude: 72.8296,
          radiusM: 100,
          archivedAt: null,
          rule: {
            id: 'rule-1',
            startTime: '10:00',
            endTime: '18:00',
            lateCutoffMinutes: 15,
            fullDayHours: 8,
            halfDayHours: 4,
            validFrom: '2026-09-26',
            validTo: null,
          },
          nextRule: null,
        },
      ]);
      expect(q.rpc).toHaveBeenCalledWith('attendance_today', { p_tenant_id: TENANT_ID });
    });

    it('scopes the read to the tenant and hides archived offices by default', async () => {
      const q = seeded(mockAdmin({
        offices: [{ data: [officeRow], error: null }],
        rules: [seededRules()],
      }));

      await service.listOffices(ownerUser);

      expect(q.officesQb.qb.select).toHaveBeenCalledWith('*');
      expect(q.officesQb.qb.eq).toHaveBeenCalledWith('tenant_id', TENANT_ID);
      expect(q.officesQb.qb.is).toHaveBeenCalledWith('archived_at', null);
      expect(q.officesQb.qb.order).toHaveBeenCalledWith('name');
    });

    it('includeArchived skips the archived filter', async () => {
      const q = seeded(mockAdmin({ offices: [{ data: [], error: null }] }));

      await service.listOffices(ownerUser, true);

      expect(q.officesQb.qb.is).not.toHaveBeenCalled();
    });

    it('returns [] without reading rules when the tenant has no offices', async () => {
      seeded(mockAdmin({ offices: [{ data: [], error: null }] }));

      await expect(service.listOffices(ownerUser)).resolves.toEqual([]);
      expect(
        (supabaseClientFactory.createAdmin() as unknown as { from: jest.Mock }).from,
      ).not.toHaveBeenCalledWith('attendance_office_rules');
    });

    it('carries a future rule as nextRule — the pending rules edit', async () => {
      const nextRule = {
        ...ruleRow,
        id: 'rule-2',
        valid: '[2026-09-27,)',
        start_time: '09:00:00',
        late_cutoff_minutes: 20,
      };
      seeded(mockAdmin({
        offices: [{ data: [officeRow], error: null }],
        rules: [{ data: [ruleRow, nextRule], error: null }],
      }));

      const result = await service.listOffices(ownerUser);
      expect(result[0].rule?.validFrom).toBe('2026-09-26');
      expect(result[0].nextRule).toEqual(
        expect.objectContaining({
          id: 'rule-2',
          startTime: '09:00',
          validFrom: '2026-09-27',
          validTo: null,
        }),
      );
    });

    it('returns rule=null when the office row carries no covering rule', async () => {
      seeded(mockAdmin({
        offices: [{ data: [officeRow], error: null }],
        rules: [{ data: [], error: null }],
      }));

      const [office] = await service.listOffices(ownerUser);
      expect(office.rule).toBeNull();
      expect(office.nextRule).toBeNull();
    });

    it('requires a tenant — 400 VALIDATION_ERROR before any client call', async () => {
      const q = seeded(mockAdmin());

      await expectErrorCode(
        service.listOffices(noTenantUser),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(q.from).not.toHaveBeenCalled();
    });

    it('maps a read failure to 500 INTERNAL_SERVER_ERROR', async () => {
      seeded(mockAdmin({ offices: [{ data: null, error: { code: 'XX000' } }] }));

      await expectErrorCode(
        service.listOffices(ownerUser),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
    });
  });

  describe('createOffice', () => {
    const dto = {
      name: 'Andheri West',
      latitude: 19.1364,
      longitude: 72.8296,
      radiusM: 100,
      startTime: '10:00',
      endTime: '18:00',
      lateCutoffMinutes: 15,
      fullDayHours: 8,
      halfDayHours: 4,
    };

    it('calls attendance_create_office with the tenant, actor and full dto, then returns the office with its seeded rule', async () => {
      const q = seeded(mockAdmin({
        offices: [{ data: officeRow, error: null }],
        rules: [seededRules()],
      }));
      q.rpcs.set('attendance_create_office', rpcQueue({ data: OFFICE_ID, error: null }));

      const result = await service.createOffice(ownerUser, dto as never);

      expect(q.rpc).toHaveBeenCalledWith('attendance_create_office', {
        p_tenant_id: TENANT_ID,
        p_actor_id: 'owner-uuid',
        p_name: 'Andheri West',
        p_latitude: 19.1364,
        p_longitude: 72.8296,
        p_radius_m: 100,
        p_start_time: '10:00',
        p_end_time: '18:00',
        p_late_cutoff_minutes: 15,
        p_full_day_hours: 8,
        p_half_day_hours: 4,
      });
      expect(result).toEqual(
        expect.objectContaining({
          id: OFFICE_ID,
          name: 'Andheri West',
          radiusM: 100,
          rule: expect.objectContaining({ validFrom: '2026-09-26', validTo: null }),
          // A just-created office cannot have a pending rule yet.
          nextRule: null,
        }),
      );
    });

    it('maps the duplicate-name PT409 to 409 ATTENDANCE_OFFICE_NAME_TAKEN', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_create_office', rpcQueue({
        data: null,
        error: { code: 'PT409', hint: 'ATTENDANCE_OFFICE_NAME_TAKEN', message: 'taken' },
      }));

      await expectErrorCode(
        service.createOffice(ownerUser, dto as never),
        409,
        ErrorCode.ATTENDANCE_OFFICE_NAME_TAKEN,
      );
    });

    it('maps a CHECK-violation (23514) to 422 VALIDATION_ERROR', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_create_office', rpcQueue({
        data: null,
        error: { code: '23514', message: 'check violation' },
      }));

      await expectErrorCode(
        service.createOffice(ownerUser, dto as never),
        422,
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('maps a numeric-precision overflow (22003) to 422 VALIDATION_ERROR', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_create_office', rpcQueue({
        data: null,
        error: { code: '22003', message: 'numeric field overflow' },
      }));

      await expectErrorCode(
        service.createOffice(ownerUser, dto as never),
        422,
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('maps the unknown-tenant PT404 (ATTENDANCE_TENANT_NOT_FOUND hint) to 404', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_today', rpcQueue({
        data: null,
        error: { code: 'PT404', hint: 'ATTENDANCE_TENANT_NOT_FOUND', message: 'no tenant' },
      }));

      await expectErrorCode(
        service.createOffice(ownerUser, dto as never),
        404,
        ErrorCode.ATTENDANCE_TENANT_NOT_FOUND,
      );
    });

    it('maps an attendance_today failure to 500 (AD-7 fail loud)', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_today', rpcQueue({
        data: null,
        error: { code: 'XX000', message: 'clock exploded' },
      }));

      await expectErrorCode(
        service.createOffice(ownerUser, dto as never),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
      expect(q.from).not.toHaveBeenCalled();
    });

    it('maps any other RPC failure to 500', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_create_office', rpcQueue({
        data: null,
        error: { code: 'XX000', message: 'boom' },
      }));

      await expectErrorCode(
        service.createOffice(ownerUser, dto as never),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
    });

    it('requires a tenant — 400 before any client call', async () => {
      const q = seeded(mockAdmin());

      await expectErrorCode(
        service.createOffice(noTenantUser, dto as never),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(q.from).not.toHaveBeenCalled();
      expect(q.rpc).not.toHaveBeenCalled();
    });
  });

  describe('getOffice', () => {
    it('returns the full history ascending (the edit screen\'s source)', async () => {
      const q = seeded(mockAdmin({
        offices: [{ data: officeRow, error: null }],
        rules: [seededRules()],
      }));

      await expect(service.getOffice(ownerUser, OFFICE_ID)).resolves.toEqual({
        id: OFFICE_ID,
        name: 'Andheri West',
        latitude: 19.1364,
        longitude: 72.8296,
        radiusM: 100,
        archivedAt: null,
        rules: [
          {
            id: 'rule-1',
            startTime: '10:00',
            endTime: '18:00',
            lateCutoffMinutes: 15,
            fullDayHours: 8,
            halfDayHours: 4,
            validFrom: '2026-09-26',
            validTo: null,
          },
        ],
      });
      // The office read is tenant-scoped.
      expect(q.officesQb.qb.eq).toHaveBeenCalledWith('id', OFFICE_ID);
      expect(q.officesQb.qb.eq).toHaveBeenCalledWith('tenant_id', TENANT_ID);
    });

    it('returns 404 ATTENDANCE_OFFICE_NOT_FOUND when the office is missing (or foreign)', async () => {
      seeded(mockAdmin({ offices: [{ data: null, error: null }] }));

      await expectErrorCode(
        service.getOffice(ownerUser, OFFICE_ID),
        404,
        ErrorCode.ATTENDANCE_OFFICE_NOT_FOUND,
      );
    });
  });

  describe('updateOffice', () => {
    it('routes profile-only fields to the guarded UPDATE and never calls the rules RPC', async () => {
      const q = seeded(mockAdmin({
        offices: [
          { data: [OFFICE_ID], error: null }, // guarded UPDATE hit
          { data: officeRow, error: null }, // re-read
        ],
        rules: [seededRules()],
      }));

      await service.updateOffice(ownerUser, OFFICE_ID, { radiusM: 200 } as never);

      expect(q.officesQb.qb.update).toHaveBeenCalledWith({ radius_m: 200 });
      expect(q.officesQb.qb.eq).toHaveBeenCalledWith('id', OFFICE_ID);
      expect(q.officesQb.qb.eq).toHaveBeenCalledWith('tenant_id', TENANT_ID);
      expect(q.officesQb.qb.is).toHaveBeenCalledWith('archived_at', null);
      expect(q.rpc).not.toHaveBeenCalledWith('attendance_update_office_rules', expect.anything());
    });

    it('routes a complete rules set to the RPC and never touches the profile UPDATE', async () => {
      const q = seeded(mockAdmin({
        offices: [{ data: officeRow, error: null }],
        rules: [seededRules()],
      }));
      q.rpcs.set('attendance_update_office_rules', rpcQueue({ data: null, error: null }));

      await service.updateOffice(ownerUser, OFFICE_ID, {
        startTime: '09:00',
        endTime: '17:00',
        lateCutoffMinutes: 20,
        fullDayHours: 8,
        halfDayHours: 4,
      } as never);

      expect(q.officesQb.qb.update).not.toHaveBeenCalled();
      expect(q.rpc).toHaveBeenCalledWith('attendance_update_office_rules', {
        p_tenant_id: TENANT_ID,
        p_actor_id: 'owner-uuid',
        p_office_id: OFFICE_ID,
        p_start_time: '09:00',
        p_end_time: '17:00',
        p_late_cutoff_minutes: 20,
        p_full_day_hours: 8,
        p_half_day_hours: 4,
      });
    });

    it('routes a mixed body through BOTH mechanics — guarded UPDATE then rules RPC', async () => {
      const q = seeded(mockAdmin({
        offices: [{ data: [{ ...officeRow, name: 'Renamed' }], error: null }],
        rules: [seededRules()],
      }));
      q.rpcs.set('attendance_update_office_rules', rpcQueue({ data: null, error: null }));

      await service.updateOffice(ownerUser, OFFICE_ID, {
        name: 'Renamed',
        startTime: '09:00',
        endTime: '17:00',
        lateCutoffMinutes: 20,
        fullDayHours: 8,
        halfDayHours: 4,
      } as never);

      // Profile group went through the UPDATE chain, rules group through the
      // RPC — the one-route/two-mechanics split must not drop either half.
      expect(q.officesQb.qb.update).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Renamed' }),
      );
      expect(q.rpc).toHaveBeenCalledWith(
        'attendance_update_office_rules',
        expect.objectContaining({ p_start_time: '09:00', p_half_day_hours: 4 }),
      );
    });

    it('rejects a partial rules set with 400 — rules travel as a complete set of five', async () => {
      const q = seeded(mockAdmin());

      await expectErrorCode(
        service.updateOffice(ownerUser, OFFICE_ID, { startTime: '08:00' } as never),
        400,
        ErrorCode.VALIDATION_ERROR,
        { message: expect.stringContaining('complete set') },
      );
      expect(q.officesQb.qb.update).not.toHaveBeenCalled();
      expect(q.rpc).not.toHaveBeenCalled();
    });

    it('rejects an empty body with 400 — at least one field required', async () => {
      const q = seeded(mockAdmin());

      await expectErrorCode(
        service.updateOffice(ownerUser, OFFICE_ID, {} as never),
        400,
        ErrorCode.VALIDATION_ERROR,
        { message: 'Nothing to update' },
      );
      expect(q.officesQb.qb.update).not.toHaveBeenCalled();
      expect(q.rpc).not.toHaveBeenCalled();
    });

    it('maps a profile UPDATE matching no row to 404 ATTENDANCE_OFFICE_NOT_FOUND', async () => {
      const q = seeded(mockAdmin({ offices: [{ data: [], error: null }] }));

      await expectErrorCode(
        service.updateOffice(ownerUser, OFFICE_ID, { radiusM: 200 } as never),
        404,
        ErrorCode.ATTENDANCE_OFFICE_NOT_FOUND,
      );
    });

    it('maps a rename hitting the unique index (23505) to 409 ATTENDANCE_OFFICE_NAME_TAKEN', async () => {
      const q = seeded(mockAdmin({
        offices: [{ data: null, error: { code: '23505', message: 'unique' } }],
      }));

      await expectErrorCode(
        service.updateOffice(ownerUser, OFFICE_ID, { name: 'Taken' } as never),
        409,
        ErrorCode.ATTENDANCE_OFFICE_NAME_TAKEN,
      );
    });

    it('maps the rules RPC PT404 (unknown/archived office) to 404', async () => {
      const q = seeded(mockAdmin({
        offices: [{ data: officeRow, error: null }],
        rules: [seededRules()],
      }));
      q.rpcs.set('attendance_update_office_rules', rpcQueue({
        data: null,
        error: { code: 'PT404', hint: 'ATTENDANCE_OFFICE_NOT_FOUND', message: 'missing' },
      }));

      await expectErrorCode(
        service.updateOffice(ownerUser, OFFICE_ID, {
          startTime: '09:00',
          endTime: '17:00',
          lateCutoffMinutes: 20,
          fullDayHours: 8,
          halfDayHours: 4,
        } as never),
        404,
        ErrorCode.ATTENDANCE_OFFICE_NOT_FOUND,
      );
    });

    it('requires a tenant — 400 before any client call', async () => {
      const q = seeded(mockAdmin());

      await expectErrorCode(
        service.updateOffice(noTenantUser, OFFICE_ID, { radiusM: 200 } as never),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(q.from).not.toHaveBeenCalled();
    });
  });

  describe('archiveOffice', () => {
    it('calls attendance_archive_office and resolves null on success (204 at the route)', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_archive_office', rpcQueue({ data: null, error: null }));

      await expect(service.archiveOffice(ownerUser, OFFICE_ID)).resolves.toBeNull();
      expect(q.rpc).toHaveBeenCalledWith('attendance_archive_office', {
        p_tenant_id: TENANT_ID,
        p_actor_id: 'owner-uuid',
        p_office_id: OFFICE_ID,
      });
    });

    it('on the blockers PT409, assembles the 409 body from the preview function', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_archive_office', rpcQueue({
        data: null,
        error: { code: 'PT409', hint: 'ATTENDANCE_OFFICE_ARCHIVE_BLOCKED', message: 'blocked' },
      }));
      q.rpcs.set('attendance_office_archive_blockers', rpcQueue({
        data: [
          { employee_id: 'emp-1', employee_name: 'Ravi Kumar' },
          { employee_id: 'emp-2', employee_name: 'Priya Sharma' },
        ],
        error: null,
      }));

      const err = await service.archiveOffice(ownerUser, OFFICE_ID).catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        error_code: ErrorCode.ATTENDANCE_OFFICE_ARCHIVE_BLOCKED,
        message: 'Office has tracked employees assigned',
        blockers: [
          { employeeId: 'emp-1', employeeName: 'Ravi Kumar' },
          { employeeId: 'emp-2', employeeName: 'Priya Sharma' },
        ],
      });
      expect(q.rpc).toHaveBeenCalledWith('attendance_office_archive_blockers', {
        p_tenant_id: TENANT_ID,
        p_office_id: OFFICE_ID,
      });
    });

    it('keeps the 409 with empty blockers when the preview read itself fails', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_archive_office', rpcQueue({
        data: null,
        error: { code: 'PT409', hint: 'ATTENDANCE_OFFICE_ARCHIVE_BLOCKED', message: 'blocked' },
      }));
      q.rpcs.set('attendance_office_archive_blockers', rpcQueue({
        data: null,
        error: { code: '42P01', message: 'relation missing' },
      }));

      const err = await service.archiveOffice(ownerUser, OFFICE_ID).catch((e) => e);
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        error_code: ErrorCode.ATTENDANCE_OFFICE_ARCHIVE_BLOCKED,
        blockers: [],
      });
    });

    it('maps a PT404 (unknown office) to 404', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_archive_office', rpcQueue({
        data: null,
        error: { code: 'PT404', hint: 'ATTENDANCE_OFFICE_NOT_FOUND', message: 'missing' },
      }));

      await expectErrorCode(
        service.archiveOffice(ownerUser, OFFICE_ID),
        404,
        ErrorCode.ATTENDANCE_OFFICE_NOT_FOUND,
      );
    });

    it('maps a lazy-compile failure (42P01, pre-15-7) to 500 — fail loud', async () => {
      const q = seeded(mockAdmin());
      q.rpcs.set('attendance_archive_office', rpcQueue({
        data: null,
        error: { code: '42P01', message: 'relation does not exist' },
      }));

      await expectErrorCode(
        service.archiveOffice(ownerUser, OFFICE_ID),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
    });
  });

  describe('getArchiveBlockers', () => {
    it('returns the office id with the blockers mapped to camelCase', async () => {
      const q = seeded(mockAdmin({
        offices: [{ data: officeRow, error: null }],
      }));
      q.rpcs.set('attendance_office_archive_blockers', rpcQueue({
        data: [{ employee_id: 'emp-1', employee_name: 'Ravi Kumar' }],
        error: null,
      }));

      await expect(service.getArchiveBlockers(ownerUser, OFFICE_ID)).resolves.toEqual({
        officeId: OFFICE_ID,
        blockers: [{ employeeId: 'emp-1', employeeName: 'Ravi Kumar' }],
      });
    });

    it('returns 404 when the office does not exist (read before the preview)', async () => {
      seeded(mockAdmin({ offices: [{ data: null, error: null }] }));

      await expectErrorCode(
        service.getArchiveBlockers(ownerUser, OFFICE_ID),
        404,
        ErrorCode.ATTENDANCE_OFFICE_NOT_FOUND,
      );
    });

    it('maps the preview-function lazy-compile failure (pre-15-7) to 500', async () => {
      const q = seeded(mockAdmin({
        offices: [{ data: officeRow, error: null }],
      }));
      q.rpcs.set('attendance_office_archive_blockers', rpcQueue({
        data: null,
        error: { code: '42P01', message: 'relation does not exist' },
      }));

      await expectErrorCode(
        service.getArchiveBlockers(ownerUser, OFFICE_ID),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
    });
  });

  it('is injectable with just the Supabase factory (no other providers)', () => {
    expect(service).toBeDefined();
  });
});
