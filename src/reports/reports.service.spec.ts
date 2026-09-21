import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ReportsService } from './reports.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { StorageService } from '../storage/storage.service';
import { ReportRegistry } from './registry/report-registry';
import { ConfigService } from '@nestjs/config';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ErrorCode } from '../common/enums/error-code.enum';
import { ReportRequestStatus } from './enums/report-status.enum';
import { TECHNICIAN_JOB_ACTIVITY_TYPE } from './registry/technician-job-activity.definition';
import { MAX_TECHNICIANS_PER_REPORT } from './reports.service';
import { decodeCursor, encodeCursor } from '../common/utils/cursor.util';
// Real SDK class (not mocked in this spec) — presignOrThrow maps an SDK
// NotFound (R2 404, missing report file) to 410 Gone.
import { NotFound } from '@aws-sdk/client-s3';

/**
 * The select chain of getOwnRowOrThrow: select('*').eq('id', ...).eq('tenant_id', ...)
 * .single(). Built inside-out like jobs.service.spec.ts's singleChain — `eqs`
 * holds the eq mocks in chain-call order, so tests can assert both filters.
 */
function singleChain(result: { data: unknown; error: unknown }) {
  const single = jest.fn().mockResolvedValue(result);
  const eqs: jest.Mock[] = [];
  let node: Record<string, unknown> = { single };
  for (let i = 0; i < 2; i++) {
    const inner = node;
    const eq = jest.fn().mockReturnValue(inner);
    eqs.unshift(eq);
    node = { eq };
  }
  const select = jest.fn().mockReturnValue(node);
  return { select, eqs, single };
}

/**
 * The guarded-UPDATE chain of retryReport: update(...).eq('id', ...).
 * eq('status', ...).select('*'), awaited directly — so the tail must be
 * thenable resolving `result`.
 */
function updateChain(result: { data: unknown; error: unknown }) {
  const qb = {} as Record<string, jest.Mock> & { then: jest.Mock };
  for (const m of ['update', 'eq', 'select']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.then = jest.fn((resolve: (v: unknown) => unknown) => resolve(result));
  return qb;
}

/**
 * Shared across all ReportsService describes: asserts the rejection is an
 * HttpException with BOTH the HTTP status and the stable error_code body
 * field — a bare status match would let two different failure modes pass.
 */
async function expectErrorCode(
  promise: Promise<unknown>,
  status: number,
  errorCode: ErrorCode,
) {
  await expect(promise).rejects.toBeInstanceOf(HttpException);
  await promise.catch((e: HttpException) => {
    expect(e.getStatus()).toBe(status);
    expect(
      (e.getResponse() as Record<string, unknown>).error_code,
    ).toBe(errorCode);
  });
}

describe('ReportsService — retryReport (story 12-7)', () => {
  let service: ReportsService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;

  const REQUEST_ID = '00000000-0000-4000-8000-0000000000a1';

  const ownerUser: RequestUser = {
    userId: 'owner-uuid',
    tenantId: 'tenant-uuid',
    role: Role.OWNER,
    rawJwt: 'mock-jwt',
  };

  const noTenantUser: RequestUser = { ...ownerUser, tenantId: null };

  const failedRow = {
    id: REQUEST_ID,
    tenant_id: 'tenant-uuid',
    requested_by: 'owner-uuid',
    report_type: 'technician_job_activity',
    params: {
      start_date: '2026-09-01',
      end_date: '2026-09-07',
      technician_ids: [],
    },
    status: ReportRequestStatus.FAILED,
    attempt_count: 2,
    locked_until: null,
    r2_key: null,
    file_size_bytes: null,
    error_code: 'REPORT_GENERATION_FAILED',
    created_at: '2026-09-10T10:00:00Z',
    completed_at: '2026-09-10T10:05:00Z',
  };

  const requeuedRow = {
    ...failedRow,
    status: ReportRequestStatus.QUEUED,
    error_code: null,
    completed_at: null,
    locked_until: null,
    attempt_count: 0,
  };

  /**
   * retryReport touches `report_requests` via two chains: the tenant-scoped
   * fetch (starting .select('*'), terminating in .single()) and the guarded
   * UPDATE (starting .update(...), awaited directly). `from` dispatches on
   * the first chained method the service calls.
   */
  function mockAdmin(opts: {
    row?: { data: unknown; error: unknown };
    update?: { data: unknown; error: unknown };
  }) {
    const selectQb = singleChain(
      opts.row ?? { data: failedRow, error: null },
    );
    const updateQb = updateChain(
      opts.update ?? { data: [requeuedRow], error: null },
    );
    const from = jest.fn((table: string) => {
      if (table !== 'report_requests') {
        throw new Error(`unexpected table ${table}`);
      }
      // Dispatch on the first chained method, not call count: short-circuit
      // paths (404 at the fetch, 409 before the update) never consume the
      // UPDATE chain, so call parity would hand the next call the wrong chain.
      return { select: selectQb.select, update: updateQb.update };
    });
    supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
    return { from, selectQb, updateQb };
  }

  beforeEach(async () => {
    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
        { provide: StorageService, useValue: { getPresignedReadUrl: jest.fn() } },
        { provide: ReportRegistry, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get<ReportsService>(ReportsService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
  });

  describe('happy path', () => {
    it('re-queues the failed row and returns the camelCase response', async () => {
      const { selectQb, updateQb } = mockAdmin({
        update: { data: [requeuedRow], error: null },
      });

      const result = await service.retryReport(ownerUser, REQUEST_ID);

      expect(result).toEqual({
        id: REQUEST_ID,
        status: ReportRequestStatus.QUEUED,
        createdAt: '2026-09-10T10:00:00Z',
      });
      // Fetch chain: tenant-scoped select ending in .single().
      expect(selectQb.select).toHaveBeenCalledWith('*');
      expect(selectQb.eqs[0]).toHaveBeenCalledWith('id', REQUEST_ID);
      expect(selectQb.eqs[1]).toHaveBeenCalledWith('tenant_id', 'tenant-uuid');
      expect(selectQb.single).toHaveBeenCalled();
    });

    it('resets the error stamp and attempt budget with an EXACT update payload', async () => {
      const { updateQb } = mockAdmin({
        update: { data: [requeuedRow], error: null },
      });

      await service.retryReport(ownerUser, REQUEST_ID);

      expect(updateQb.update).toHaveBeenCalledWith({
        status: ReportRequestStatus.QUEUED,
        error_code: null,
        completed_at: null,
        locked_until: null,
        attempt_count: 0,
      });
      // The guarded UPDATE carries both predicates — the race-lost guard.
      expect(updateQb.eq).toHaveBeenCalledWith('id', REQUEST_ID);
      expect(updateQb.eq).toHaveBeenCalledWith(
        'status',
        ReportRequestStatus.FAILED,
      );
      expect(updateQb.select).toHaveBeenCalledWith('*');
    });
  });

  describe('404 — unknown or cross-tenant row', () => {
    it('maps a PGRST116 single() miss to 404 RESOURCE_NOT_FOUND', async () => {
      mockAdmin({
        row: {
          data: null,
          error: { code: 'PGRST116', message: 'JSON object requested' },
        },
      });

      await expectErrorCode(
        service.retryReport(ownerUser, REQUEST_ID),
        404,
        ErrorCode.RESOURCE_NOT_FOUND,
      );
      await expect(service.retryReport(ownerUser, REQUEST_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("another tenant's row is indistinguishable from an unknown id (same 404 path)", async () => {
      mockAdmin({
        row: { data: null, error: { code: 'PGRST116', message: 'miss' } },
      });

      await expectErrorCode(
        service.retryReport(ownerUser, REQUEST_ID),
        404,
        ErrorCode.RESOURCE_NOT_FOUND,
      );
    });

    it('short-circuits with 400 before any DB call when tenantId is null', async () => {
      const createAdmin = supabaseClientFactory.createAdmin as jest.Mock;

      await expectErrorCode(
        service.retryReport(noTenantUser, REQUEST_ID),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      await expect(
        service.retryReport(noTenantUser, REQUEST_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(createAdmin).not.toHaveBeenCalled();
    });
  });

  describe('409 — not retryable', () => {
    it.each([
      [ReportRequestStatus.READY],
      [ReportRequestStatus.QUEUED],
      [ReportRequestStatus.GENERATING],
    ])('a %s row is 409 REPORT_NOT_RETRYABLE and the UPDATE never runs', async (status) => {
      const { from, updateQb } = mockAdmin({
        row: { data: { ...failedRow, status }, error: null },
      });

      await expectErrorCode(
        service.retryReport(ownerUser, REQUEST_ID),
        409,
        ErrorCode.REPORT_NOT_RETRYABLE,
      );

      // Only the fetch chain ran — the guarded UPDATE was never issued.
      expect(from).toHaveBeenCalledTimes(1);
      expect(updateQb.update).not.toHaveBeenCalled();
    });

    it('an empty update result (guard predicate lost the race) is the same 409 contract', async () => {
      mockAdmin({ update: { data: [], error: null } });

      await expectErrorCode(
        service.retryReport(ownerUser, REQUEST_ID),
        409,
        ErrorCode.REPORT_NOT_RETRYABLE,
      );
    });
  });

  describe('update errors', () => {
    it('maps SQLSTATE PT429 from the in-flight guard trigger to 429 REPORT_IN_FLIGHT_LIMIT', async () => {
      mockAdmin({
        update: {
          data: null,
          error: { code: 'PT429', message: 'in-flight cap reached' },
        },
      });

      await expectErrorCode(
        service.retryReport(ownerUser, REQUEST_ID),
        429,
        ErrorCode.REPORT_IN_FLIGHT_LIMIT,
      );
    });

    it('maps any other update error to 500 INTERNAL_SERVER_ERROR', async () => {
      mockAdmin({
        update: {
          data: null,
          error: { code: 'XX000', message: 'connection reset' },
        },
      });

      await expectErrorCode(
        service.retryReport(ownerUser, REQUEST_ID),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
      await expect(
        service.retryReport(ownerUser, REQUEST_ID),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });
});

/**
 * Story 12-2 coverage. Unlike the retryReport describe above, this block
 * wires the REAL ReportRegistry (a plain Map — no dependencies), so
 * createReport's type resolution and the definition's validateParams
 * (calendar-date shape, start <= end, the 92-day cap, the IST future check)
 * run for real — only the DB boundary is mocked.
 */
describe('ReportsService — story 12-2 (createReport / listReports / getReportStatus)', () => {
  let service: ReportsService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;
  let storage: { getPresignedReadUrl: jest.Mock };
  let configGet: jest.Mock;

  const TENANT = 'tenant-uuid';
  const REQUEST_ID = '00000000-0000-4000-8000-0000000000b2';

  const ownerUser: RequestUser = {
    userId: 'owner-uuid',
    tenantId: TENANT,
    role: Role.OWNER,
    rawJwt: 'mock-jwt',
  };

  const noTenantUser: RequestUser = { ...ownerUser, tenantId: null };

  /**
   * A range that is always valid regardless of the run date: real calendar
   * dates, 7 inclusive days, and safely in the past so the IST "not in the
   * future" check never fires on a happy path.
   */
  const RANGE = { startDate: '2026-08-01', endDate: '2026-08-07' };

  const createdRow = {
    id: REQUEST_ID,
    tenant_id: TENANT,
    requested_by: 'owner-uuid',
    report_type: TECHNICIAN_JOB_ACTIVITY_TYPE,
    params: {
      start_date: '2026-08-01',
      end_date: '2026-08-07',
      technician_ids: [],
    },
    status: ReportRequestStatus.QUEUED,
    attempt_count: 0,
    locked_until: null,
    r2_key: null,
    file_size_bytes: null,
    error_code: null,
    created_at: '2026-09-10T10:00:00Z',
    completed_at: null,
  };

  /** The insert chain of createReport: insert(...).select('*').single(). */
  function insertChain(result: { data: unknown; error: unknown }) {
    const single = jest.fn().mockResolvedValue(result);
    const select = jest.fn().mockReturnValue({ single });
    const insert = jest.fn().mockReturnValue({ select });
    return { insert, select, single };
  }

  /**
   * The technician-membership probe of resolveTechnicianIds:
   * select('id').eq('tenant_id', ...).eq('role', 'technician').in('id', ...).
   */
  function usersChain(result: { data: unknown; error: unknown }) {
    const inFn = jest.fn().mockResolvedValue(result);
    const roleEq = jest.fn().mockReturnValue({ in: inFn });
    const tenantEq = jest.fn().mockReturnValue({ eq: roleEq });
    const select = jest.fn().mockReturnValue({ eq: tenantEq });
    return { select, tenantEq, roleEq, in: inFn };
  }

  /**
   * The listReports builder: select('*').eq(...)[.or(...)].order(...).order(...)
   * .limit(21), awaited on .limit (mirror of jobs.service.spec's listChain).
   */
  function listChain(result: { data: unknown; error: unknown }) {
    const builder: Record<string, jest.Mock> = {};
    for (const m of ['select', 'eq', 'or', 'order']) {
      builder[m] = jest.fn().mockReturnValue(builder);
    }
    builder.limit = jest.fn().mockResolvedValue(result);
    return builder;
  }

  function listRow(i: number, overrides: Record<string, unknown> = {}) {
    return {
      id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
      tenant_id: TENANT,
      requested_by: 'owner-uuid',
      report_type: TECHNICIAN_JOB_ACTIVITY_TYPE,
      params: {
        start_date: '2026-08-01',
        end_date: '2026-08-07',
        technician_ids: ['t-1'],
      },
      status: ReportRequestStatus.READY,
      attempt_count: 1,
      locked_until: null,
      r2_key: null,
      file_size_bytes: null,
      error_code: null,
      created_at: `2026-09-10T10:00:00.${String(i).padStart(3, '0')}Z`,
      completed_at: null,
      ...overrides,
    };
  }

  const readyRow = {
    ...listRow(0, {
      id: REQUEST_ID,
      r2_key: 'tenants/tenant-uuid/reports/report.pdf',
      file_size_bytes: 123456,
      created_at: '2026-09-10T10:00:00Z',
      completed_at: '2026-09-10T10:05:00Z',
    }),
  };

  beforeEach(async () => {
    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };
    storage = { getPresignedReadUrl: jest.fn() };
    configGet = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
        { provide: StorageService, useValue: storage },
        // Real registry: createReport resolves reportType through it and runs
        // the definition's validateParams — the deep date validation under test.
        { provide: ReportRegistry, useClass: ReportRegistry },
        { provide: ConfigService, useValue: { get: configGet } },
      ],
    }).compile();

    service = module.get<ReportsService>(ReportsService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
  });

  describe('createReport', () => {
    /**
     * `from` dispatches on table + first chained method. `users` is
     * opt-in (null by default): a test that passes technicianIds but
     * forgets the users result fails loudly instead of silently hitting
     * an empty membership set.
     */
    function mockCreateAdmin(opts: {
      insert?: { data: unknown; error: unknown };
      users?: { data: unknown; error: unknown } | null;
    } = {}) {
      const insertQb = insertChain(
        opts.insert ?? { data: createdRow, error: null },
      );
      const usersQb = opts.users ? usersChain(opts.users) : null;
      const from = jest.fn((table: string) => {
        if (table === 'users') {
          if (!usersQb) throw new Error('unexpected users query');
          return { select: usersQb.select };
        }
        if (table !== 'report_requests') {
          throw new Error(`unexpected table ${table}`);
        }
        return { insert: insertQb.insert };
      });
      supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
      return { from, insertQb, usersQb };
    }

    it('inserts a queued report_requests row and returns the camelCase response', async () => {
      const { from, insertQb } = mockCreateAdmin();

      const result = await service.createReport(ownerUser, { ...RANGE });

      expect(result).toEqual({
        id: REQUEST_ID,
        status: ReportRequestStatus.QUEUED,
        createdAt: createdRow.created_at,
      });
      expect(from).toHaveBeenCalledWith('report_requests');
      // No technicianIds → no membership probe, no second table touched.
      expect(from).toHaveBeenCalledTimes(1);
      expect(insertQb.insert).toHaveBeenCalledWith({
        tenant_id: TENANT,
        requested_by: 'owner-uuid',
        report_type: TECHNICIAN_JOB_ACTIVITY_TYPE,
        params: {
          start_date: '2026-08-01',
          end_date: '2026-08-07',
          technician_ids: [],
        },
      });
      expect(insertQb.select).toHaveBeenCalledWith('*');
    });

    it('falls back to the registry default for a blank reportType', async () => {
      const { insertQb } = mockCreateAdmin();

      await service.createReport(ownerUser, { ...RANGE, reportType: '   ' });

      expect(insertQb.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          report_type: TECHNICIAN_JOB_ACTIVITY_TYPE,
        }),
      );
    });

    it('rejects an unknown report type with 400 VALIDATION_ERROR before any DB call', async () => {
      mockCreateAdmin();

      await expectErrorCode(
        service.createReport(ownerUser, { ...RANGE, reportType: 'nope' }),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });

    it('rejects start_date after end_date with 400 VALIDATION_ERROR', async () => {
      mockCreateAdmin();

      await expectErrorCode(
        service.createReport(ownerUser, {
          startDate: '2026-08-07',
          endDate: '2026-08-01',
        }),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      // The range error never reaches the insert.
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });

    it('rejects a range over 92 inclusive days with 400 REPORT_RANGE_TOO_LARGE', async () => {
      mockCreateAdmin();

      await expectErrorCode(
        service.createReport(ownerUser, {
          startDate: '2026-01-01',
          endDate: '2026-06-01',
        }),
        400,
        ErrorCode.REPORT_RANGE_TOO_LARGE,
      );
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });

    it('accepts a range of exactly 92 days (the inclusive cap boundary)', async () => {
      const { insertQb } = mockCreateAdmin();

      // May 1 → Jul 31 = 31 + 30 + 31 = 92 inclusive days.
      await service.createReport(ownerUser, {
        startDate: '2026-05-01',
        endDate: '2026-07-31',
      });

      expect(insertQb.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({
            start_date: '2026-05-01',
            end_date: '2026-07-31',
          }),
        }),
      );
    });

    it('rejects a future end_date (IST clock) with 400 VALIDATION_ERROR', async () => {
      mockCreateAdmin();

      // Single-day range, so the 92-day cap passes and the future check fires.
      await expectErrorCode(
        service.createReport(ownerUser, {
          startDate: '2999-01-01',
          endDate: '2999-01-01',
        }),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });

    it('rejects more than 25 technicians with 400 REPORT_TOO_MANY_TECHNICIANS before any DB call', async () => {
      const tooMany = Array.from(
        { length: MAX_TECHNICIANS_PER_REPORT + 1 },
        (_, i) => `t-${i}`,
      );

      await expectErrorCode(
        service.createReport(ownerUser, { ...RANGE, technicianIds: tooMany }),
        400,
        ErrorCode.REPORT_TOO_MANY_TECHNICIANS,
      );
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });

    it('validates technicianIds against the tenant technicians, deduped, and stores the resolved ids', async () => {
      const { from, usersQb, insertQb } = mockCreateAdmin({
        users: { data: [{ id: 't-1' }, { id: 't-2' }], error: null },
      });

      await service.createReport(ownerUser, {
        ...RANGE,
        technicianIds: ['t-2', 't-1', 't-2'],
      });

      expect(from).toHaveBeenCalledWith('users');
      expect(usersQb.select).toHaveBeenCalledWith('id');
      expect(usersQb.tenantEq).toHaveBeenCalledWith('tenant_id', TENANT);
      expect(usersQb.roleEq).toHaveBeenCalledWith('role', Role.TECHNICIAN);
      expect(usersQb.in).toHaveBeenCalledWith('id', ['t-2', 't-1']);
      expect(insertQb.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({
            technician_ids: ['t-2', 't-1'],
          }),
        }),
      );
    });

    it('rejects an id that is not a technician of the tenant with 400 VALIDATION_ERROR', async () => {
      const { insertQb } = mockCreateAdmin({
        users: { data: [{ id: 't-1' }], error: null },
      });

      await expectErrorCode(
        service.createReport(ownerUser, {
          ...RANGE,
          technicianIds: ['t-1', 't-unknown'],
        }),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(insertQb.insert).not.toHaveBeenCalled();
    });

    it('maps a users-table query error to 500 INTERNAL_SERVER_ERROR', async () => {
      mockCreateAdmin({
        users: { data: null, error: { code: 'XX000', message: 'conn' } },
      });

      await expectErrorCode(
        service.createReport(ownerUser, { ...RANGE, technicianIds: ['t-1'] }),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
    });

    it('maps the PT429 in-flight guard trigger to 429 REPORT_IN_FLIGHT_LIMIT', async () => {
      mockCreateAdmin({
        insert: {
          data: null,
          error: { code: 'PT429', message: 'in-flight cap reached' },
        },
      });

      await expectErrorCode(
        service.createReport(ownerUser, { ...RANGE }),
        429,
        ErrorCode.REPORT_IN_FLIGHT_LIMIT,
      );
    });

    it('maps any other insert error to 500 INTERNAL_SERVER_ERROR', async () => {
      mockCreateAdmin({
        insert: {
          data: null,
          error: { code: 'XX000', message: 'connection reset' },
        },
      });

      await expectErrorCode(
        service.createReport(ownerUser, { ...RANGE }),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
    });

    it('short-circuits with 400 VALIDATION_ERROR before any DB call when tenantId is null', async () => {
      await expectErrorCode(
        service.createReport(noTenantUser, { ...RANGE }),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });
  });

  describe('listReports', () => {
    function mockListAdmin(result: { data: unknown; error: unknown }) {
      const qb = listChain(result);
      const from = jest.fn((table: string) => {
        if (table !== 'report_requests') {
          throw new Error(`unexpected table ${table}`);
        }
        return { select: qb.select };
      });
      supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
      return { from, qb };
    }

    it('short-circuits with 400 VALIDATION_ERROR before any DB call when tenantId is null', async () => {
      await expectErrorCode(
        service.listReports(noTenantUser, {}),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });

    it('returns a full page without a next cursor, scoped to the tenant, newest first', async () => {
      const rows = Array.from({ length: 20 }, (_, i) => listRow(i));
      const { from, qb } = mockListAdmin({ data: rows, error: null });

      const result = await service.listReports(ownerUser, {});

      expect(from).toHaveBeenCalledWith('report_requests');
      expect(qb.select).toHaveBeenCalledWith('*');
      expect(qb.eq).toHaveBeenCalledWith('tenant_id', TENANT);
      expect(qb.or).not.toHaveBeenCalled();
      expect(qb.order).toHaveBeenCalledWith('created_at', {
        ascending: false,
      });
      expect(qb.order).toHaveBeenCalledWith('id', { ascending: false });
      // PAGE_SIZE + 1 lookahead row — the keyset hasMore probe.
      expect(qb.limit).toHaveBeenCalledWith(21);
      expect(result.data).toHaveLength(20);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
      // ListItem mapping (camelCase, range flattened, null technicianCount = all).
      expect(result.data[0]).toEqual({
        id: rows[0].id,
        reportType: TECHNICIAN_JOB_ACTIVITY_TYPE,
        range: { startDate: '2026-08-01', endDate: '2026-08-07' },
        technicianCount: 1,
        status: ReportRequestStatus.READY,
        errorCode: null,
        createdAt: rows[0].created_at,
        completedAt: null,
      });
    });

    it('maps an empty technician list to a null technicianCount (all technicians)', async () => {
      const { qb } = mockListAdmin({
        data: [listRow(0, { params: { start_date: '2026-08-01', end_date: '2026-08-07', technician_ids: [] } })],
        error: null,
      });

      const result = await service.listReports(ownerUser, {});

      expect(qb.eq).toHaveBeenCalledWith('tenant_id', TENANT);
      expect(result.data[0].technicianCount).toBeNull();
    });

    it('mints a reports-list cursor from the 20th row when a lookahead row exists', async () => {
      const rows = Array.from({ length: 21 }, (_, i) => listRow(i));
      mockListAdmin({ data: rows, error: null });

      const result = await service.listReports(ownerUser, {});

      expect(result.data).toHaveLength(20);
      expect(result.hasMore).toBe(true);
      const payload = decodeCursor(result.nextCursor as string, 'reports-list');
      expect(payload.id).toBe(rows[19].id);
      expect(payload.createdAt).toBe(rows[19].created_at);
    });

    it('applies the keyset .or() filter when a cursor is provided', async () => {
      const { qb } = mockListAdmin({ data: [], error: null });
      const cursor = encodeCursor(
        '00000000-0000-4000-8000-000000000099',
        '2026-09-01T10:00:00Z',
        'reports-list',
      );

      await service.listReports(ownerUser, { cursor });

      expect(qb.or).toHaveBeenCalledWith(
        'created_at.lt.2026-09-01T10:00:00Z,and(created_at.eq.2026-09-01T10:00:00Z,id.lt.00000000-0000-4000-8000-000000000099)',
      );
    });

    it('maps a query error to 500 INTERNAL_SERVER_ERROR', async () => {
      mockListAdmin({
        data: null,
        error: { code: 'XX000', message: 'connection reset' },
      });

      await expectErrorCode(
        service.listReports(ownerUser, {}),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
    });
  });

  describe('getReportStatus', () => {
    function mockStatusAdmin(row: { data: unknown; error: unknown }) {
      const fetchQb = singleChain(row);
      const from = jest.fn((table: string) => {
        if (table !== 'report_requests') {
          throw new Error(`unexpected table ${table}`);
        }
        return { select: fetchQb.select };
      });
      supabaseClientFactory.createAdmin.mockReturnValue({ from } as never);
      return { from, fetchQb };
    }

    it('a ready row carries a fresh presigned file block with the default 600s TTL', async () => {
      const { fetchQb } = mockStatusAdmin({ data: readyRow, error: null });
      storage.getPresignedReadUrl.mockResolvedValue(
        'https://signed.example/report.pdf',
      );

      const result = await service.getReportStatus(ownerUser, REQUEST_ID);

      expect(fetchQb.eqs[0]).toHaveBeenCalledWith('id', REQUEST_ID);
      expect(fetchQb.eqs[1]).toHaveBeenCalledWith('tenant_id', TENANT);
      // Presigned per request from the stored r2_key — never a stored URL.
      expect(storage.getPresignedReadUrl).toHaveBeenCalledWith(
        readyRow.r2_key,
        600,
      );
      expect(result.file).toEqual({
        url: 'https://signed.example/report.pdf',
        sizeBytes: 123456,
        filename: 'technician_job_activity_2026-08-01_2026-08-07.pdf',
      });
      expect(result.error).toBeUndefined();
      expect(result.params).toEqual({
        startDate: '2026-08-01',
        endDate: '2026-08-07',
        technicianIds: ['t-1'],
      });
    });

    it('honours a configured REPORT_PRESIGN_TTL_SECONDS', async () => {
      mockStatusAdmin({ data: readyRow, error: null });
      storage.getPresignedReadUrl.mockResolvedValue('https://signed.example/x');
      configGet.mockReturnValue(120);

      await service.getReportStatus(ownerUser, REQUEST_ID);

      expect(configGet).toHaveBeenCalledWith('REPORT_PRESIGN_TTL_SECONDS');
      expect(storage.getPresignedReadUrl).toHaveBeenCalledWith(
        readyRow.r2_key,
        120,
      );
    });

    it('a failed row carries the engine error code and never a file', async () => {
      mockStatusAdmin({
        data: { ...readyRow, status: ReportRequestStatus.FAILED, error_code: 'REPORT_TOO_LARGE' },
        error: null,
      });

      const result = await service.getReportStatus(ownerUser, REQUEST_ID);

      expect(result.error).toEqual({ code: 'REPORT_TOO_LARGE' });
      expect(result.file).toBeUndefined();
      expect(storage.getPresignedReadUrl).not.toHaveBeenCalled();
    });

    it('a failed row with a null error_code falls back to REPORT_GENERATION_FAILED', async () => {
      mockStatusAdmin({
        data: { ...readyRow, status: ReportRequestStatus.FAILED, error_code: null },
        error: null,
      });

      const result = await service.getReportStatus(ownerUser, REQUEST_ID);

      expect(result.error).toEqual({
        code: ErrorCode.REPORT_GENERATION_FAILED,
      });
    });

    it('a queued row carries neither a file nor an error', async () => {
      mockStatusAdmin({
        data: { ...readyRow, status: ReportRequestStatus.QUEUED },
        error: null,
      });

      const result = await service.getReportStatus(ownerUser, REQUEST_ID);

      expect(result.file).toBeUndefined();
      expect(result.error).toBeUndefined();
      expect(storage.getPresignedReadUrl).not.toHaveBeenCalled();
    });

    it('a ready row with no stored artifact carries no file block', async () => {
      mockStatusAdmin({ data: { ...readyRow, r2_key: null }, error: null });

      const result = await service.getReportStatus(ownerUser, REQUEST_ID);

      expect(result.file).toBeUndefined();
      expect(storage.getPresignedReadUrl).not.toHaveBeenCalled();
    });

    it('maps a PGRST116 single() miss to 404 RESOURCE_NOT_FOUND', async () => {
      mockStatusAdmin({
        data: null,
        error: { code: 'PGRST116', message: 'JSON object requested' },
      });

      await expectErrorCode(
        service.getReportStatus(ownerUser, REQUEST_ID),
        404,
        ErrorCode.RESOURCE_NOT_FOUND,
      );
    });

    it('a row belonging to another tenant is the same 404 (defense-in-depth tenant check)', async () => {
      mockStatusAdmin({
        data: { ...readyRow, tenant_id: 'other-tenant' },
        error: null,
      });

      await expectErrorCode(
        service.getReportStatus(ownerUser, REQUEST_ID),
        404,
        ErrorCode.RESOURCE_NOT_FOUND,
      );
    });

    it('maps a non-miss fetch error to 500 INTERNAL_SERVER_ERROR', async () => {
      mockStatusAdmin({
        data: null,
        error: { code: 'XX000', message: 'connection reset' },
      });

      await expectErrorCode(
        service.getReportStatus(ownerUser, REQUEST_ID),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
    });

    it('maps a presign failure to 500 REPORT_PRESIGN_FAILED', async () => {
      mockStatusAdmin({ data: readyRow, error: null });
      storage.getPresignedReadUrl.mockRejectedValue(new Error('r2 down'));

      await expectErrorCode(
        service.getReportStatus(ownerUser, REQUEST_ID),
        500,
        ErrorCode.REPORT_PRESIGN_FAILED,
      );
    });

    it('maps an SDK NotFound (missing R2 file) to 410 REPORT_PRESIGN_FAILED', async () => {
      mockStatusAdmin({ data: readyRow, error: null });
      storage.getPresignedReadUrl.mockRejectedValue(
        new NotFound({ $metadata: {} }),
      );

      await expectErrorCode(
        service.getReportStatus(ownerUser, REQUEST_ID),
        410,
        ErrorCode.REPORT_PRESIGN_FAILED,
      );
    });

    it('short-circuits with 400 VALIDATION_ERROR before any DB call when tenantId is null', async () => {
      await expectErrorCode(
        service.getReportStatus(noTenantUser, REQUEST_ID),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(supabaseClientFactory.createAdmin).not.toHaveBeenCalled();
    });
  });
});