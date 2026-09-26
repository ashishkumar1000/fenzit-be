import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { ErrorCode } from '../common/enums/error-code.enum';
import { SETUP_STEPS } from './dto/update-setup-step.dto';

// A step other than the initial 'offices' — proves the marker actually moves.
const NEXT_STEP = SETUP_STEPS[1];

/**
 * The read chain of readSettings/readProgress: select('*').eq('tenant_id', ...)
 * .maybeSingle(). `eqs` holds the eq mocks in chain-call order so tests can
 * assert the tenant filter; maybeSingle resolves `result` on every call —
 * startSetup/completeSetup read settings more than once, and the mock must
 * survive that (a one-shot would break the second read).
 */
function maybeSingleChain(result: { data: unknown; error: unknown }) {
  const maybeSingle = jest.fn().mockResolvedValue(result);
  const eqs: jest.Mock[] = [];
  const inner = { maybeSingle };
  const eq = jest.fn().mockReturnValue(inner);
  eqs.push(eq);
  const select = jest.fn().mockReturnValue({ eq });
  return { select, eqs, maybeSingle };
}

/**
 * The guarded-UPDATE chain of saveStep: update(...).eq('tenant_id', ...)
 * .select('tenant_id'), awaited directly — so the tail must be thenable
 * resolving `result`.
 */
function updateChain(result: { data: unknown; error: unknown }) {
  const qb = {} as Record<string, jest.Mock> & { then: jest.Mock };
  const eqs: [string, unknown][] = [];
  for (const m of ['update', 'eq', 'select']) {
    qb[m] = jest.fn();
  }
  // eqs records every eq filter in chain-call order (saveStep has exactly
  // one — the tenant guard).
  qb.eq.mockImplementation((field: string, value: unknown) => {
    eqs.push([field, value]);
    return qb;
  });
  for (const m of ['update', 'select']) {
    qb[m].mockReturnValue(qb);
  }
  qb.then = jest.fn((resolve: (v: unknown) => unknown) => resolve(result));
  // Named properties (not a spread) so jest's inferred types survive.
  return { update: qb.update, eq: qb.eq, select: qb.select, then: qb.then, eqs };
}

/**
 * Shared across all AttendanceService describes: asserts the rejection is an
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

describe('AttendanceService — setup routes (story 15-2)', () => {
  let service: AttendanceService;
  let supabaseClientFactory: jest.Mocked<SupabaseClientFactory>;

  const TENANT_ID = '00000000-0000-4000-8000-0000000000c1';

  const ownerUser: RequestUser = {
    userId: 'owner-uuid',
    tenantId: TENANT_ID,
    role: Role.OWNER,
    rawJwt: 'mock-jwt',
  };

  const noTenantUser: RequestUser = { ...ownerUser, tenantId: null };

  const unstartedSettings = null;
  const settingsRow = {
    tenant_id: TENANT_ID,
    enabled: false,
    setup_completed_at: null,
    created_at: '2026-09-26T00:00:00Z',
    updated_at: '2026-09-26T00:00:00Z',
  };
  const completedRow = {
    ...settingsRow,
    enabled: true,
    setup_completed_at: '2026-09-26T01:00:00Z',
  };
  const progressRow = {
    tenant_id: TENANT_ID,
    current_step: 'timings',
    created_at: '2026-09-26T00:00:00Z',
    updated_at: '2026-09-26T00:00:00Z',
  };

  /**
   * getSetupState/startSetup/completeSetup touch both attendance tables via
   * two read chains (select → maybeSingle) and one or two RPCs; saveStep
   * touches attendance_setup_progress via a guarded UPDATE. `from` dispatches
   * on the first chained method the service calls (select vs update), the
   * read chains are dispatched on the table name. RPCs are stubbed on the
   * admin client itself with their real argument names.
   */
  function mockAdmin(
    opts: {
      settings?: { data: unknown; error: unknown };
      progress?: { data: unknown; error: unknown };
      update?: { data: unknown; error: unknown };
      rpcError?: { code: string; message: string; hint?: string } | null;
    } = {},
  ) {
    const settingsQb = maybeSingleChain(
      opts.settings ?? { data: settingsRow, error: null },
    );
    const progressQb = maybeSingleChain(
      opts.progress ?? { data: progressRow, error: null },
    );
    const updateQb = updateChain(
      opts.update ?? { data: [TENANT_ID], error: null },
    );
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: opts.rpcError ?? null,
    });
    const from = jest.fn((table: string) => {
      switch (table) {
        case 'attendance_settings':
          return { select: settingsQb.select };
        case 'attendance_setup_progress':
          return { select: progressQb.select, update: updateQb.update };
        default:
          throw new Error(`unexpected table ${table}`);
      }
    });
    supabaseClientFactory.createAdmin.mockReturnValue({
      from,
      rpc,
    } as never);
    return { from, rpc, settingsQb, progressQb, updateQb };
  }

  beforeEach(async () => {
    const mockFactory = { create: jest.fn(), createAdmin: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: SupabaseClientFactory, useValue: mockFactory },
      ],
    }).compile();

    service = module.get<AttendanceService>(AttendanceService);
    supabaseClientFactory = module.get(SupabaseClientFactory);
  });

  describe('getSetupState', () => {
    it('reports started=false with nulls when no rows exist yet', async () => {
      mockAdmin({
        settings: { data: unstartedSettings, error: null },
        progress: { data: null, error: null },
      });

      await expect(service.getSetupState(ownerUser)).resolves.toEqual({
        started: false,
        currentStep: null,
        setupCompletedAt: null,
        enabled: false,
      });
    });

    it('maps the snake_case rows to the camelCase resume state', async () => {
      mockAdmin();

      await expect(service.getSetupState(ownerUser)).resolves.toEqual({
        started: true,
        currentStep: 'timings',
        setupCompletedAt: null,
        enabled: false,
      });
    });

    it('reads BOTH tables scoped to the caller tenant', async () => {
      const { settingsQb, progressQb } = mockAdmin();

      await service.getSetupState(ownerUser);

      expect(settingsQb.eqs[0]).toHaveBeenCalledWith('tenant_id', TENANT_ID);
      expect(settingsQb.maybeSingle).toHaveBeenCalledTimes(1);
      expect(progressQb.eqs[0]).toHaveBeenCalledWith('tenant_id', TENANT_ID);
    });

    it('reports enabled=true and the completed timestamp after completion', async () => {
      mockAdmin({
        settings: { data: completedRow, error: null },
      });

      await expect(service.getSetupState(ownerUser)).resolves.toEqual({
        started: true,
        currentStep: 'timings',
        setupCompletedAt: '2026-09-26T01:00:00Z',
        enabled: true,
      });
    });

    it('requires a tenant — 400 VALIDATION_ERROR before any client call', async () => {
      const { from } = mockAdmin();

      await expectErrorCode(
        service.getSetupState(noTenantUser),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('startSetup', () => {
    it('calls attendance_start_setup with the tenant and actor, and reports created=true on first start', async () => {
      const { rpc, settingsQb } = mockAdmin({
        settings: { data: unstartedSettings, error: null },
        progress: { data: progressRow, error: null },
      });
      // Two settings reads happen: the pre-RPC check (no row → created=true)
      // and the post-RPC re-read (row exists → started=true). Once-queued
      // results are consumed in call order — first read null, second sees
      // the row the RPC just inserted.
      (settingsQb.maybeSingle as jest.Mock)
        .mockResolvedValueOnce({ data: unstartedSettings, error: null })
        .mockResolvedValueOnce({ data: { ...settingsRow }, error: null });

      const { state, created } = await service.startSetup(ownerUser);

      expect(created).toBe(true);
      expect(state).toEqual({
        started: true,
        currentStep: 'timings',
        setupCompletedAt: null,
        enabled: false,
      });
      expect(rpc).toHaveBeenCalledWith('attendance_start_setup', {
        p_tenant_id: TENANT_ID,
        p_actor_id: 'owner-uuid',
      });
    });

    it('reports created=false when the wizard is already under way (resume), and still calls the idempotent RPC', async () => {
      const { rpc } = mockAdmin();

      const { created } = await service.startSetup(ownerUser);

      expect(created).toBe(false);
      expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('rejects a completed setup with 409 and never calls the RPC', async () => {
      const { rpc } = mockAdmin({
        settings: { data: completedRow, error: null },
      });

      await expectErrorCode(
        service.startSetup(ownerUser),
        409,
        ErrorCode.ATTENDANCE_SETUP_ALREADY_COMPLETED,
      );
      expect(rpc).not.toHaveBeenCalled();
    });

    it('requires a tenant — 400 VALIDATION_ERROR before any client call', async () => {
      const { rpc, from } = mockAdmin();

      await expectErrorCode(
        service.startSetup(noTenantUser),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(from).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    });

    it('maps an RPC failure to 500 INTERNAL_SERVER_ERROR', async () => {
      mockAdmin({
        settings: { data: unstartedSettings, error: null },
        rpcError: { code: 'XX000', message: 'boom' },
      });

      await expectErrorCode(
        service.startSetup(ownerUser),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
    });
  });

  describe('saveStep', () => {
    it('updates only current_step, guarded by the tenant filter', async () => {
      const { updateQb } = mockAdmin();

      await service.saveStep(ownerUser, {
        currentStep: NEXT_STEP,
      });

      expect(updateQb.update).toHaveBeenCalledWith({
        current_step: NEXT_STEP,
      });
      expect(updateQb.eqs).toEqual([
        ['tenant_id', TENANT_ID],
      ]);
    });

    it('returns 404 ATTENDANCE_SETUP_NOT_STARTED when the update matches no row', async () => {
      mockAdmin({
        update: { data: [], error: null },
      });

      await expectErrorCode(
        service.saveStep(ownerUser, {
          currentStep: NEXT_STEP,
        }),
        404,
        ErrorCode.ATTENDANCE_SETUP_NOT_STARTED,
      );
    });

    it('maps an update failure to 500 INTERNAL_SERVER_ERROR', async () => {
      mockAdmin({
        update: { data: null, error: { code: 'XX000', message: 'boom' } },
      });

      await expectErrorCode(
        service.saveStep(ownerUser, {
          currentStep: NEXT_STEP,
        }),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
    });

    it('requires a tenant — 400 VALIDATION_ERROR before any client call', async () => {
      const { from } = mockAdmin();

      await expectErrorCode(
        service.saveStep(noTenantUser, {
          currentStep: NEXT_STEP,
        }),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(from).not.toHaveBeenCalled();
    });

    it('returns 404 ATTENDANCE_SETUP_NOT_STARTED when there is no settings row (guard, before the update)', async () => {
      const { updateQb } = mockAdmin({
        settings: { data: unstartedSettings, error: null },
      });

      await expectErrorCode(
        service.saveStep(ownerUser, {
          currentStep: NEXT_STEP,
        }),
        404,
        ErrorCode.ATTENDANCE_SETUP_NOT_STARTED,
      );
      expect(updateQb.update).not.toHaveBeenCalled();
    });

    it('returns 409 ATTENDANCE_SETUP_ALREADY_COMPLETED once setup is completed (guard, before the update)', async () => {
      const { updateQb } = mockAdmin({
        settings: { data: completedRow, error: null },
      });

      await expectErrorCode(
        service.saveStep(ownerUser, {
          currentStep: NEXT_STEP,
        }),
        409,
        ErrorCode.ATTENDANCE_SETUP_ALREADY_COMPLETED,
      );
      expect(updateQb.update).not.toHaveBeenCalled();
    });
  });

  describe('completeSetup', () => {
    it('calls attendance_complete_setup with the tenant and actor, then returns the enabled state', async () => {
      const { rpc, settingsQb } = mockAdmin({
        settings: { data: completedRow, error: null },
      });
      // Two settings reads happen: the pre-check (un-completed row → RPC
      // runs) and the post-RPC re-read (completed row → the response). The
      // default chain returns the completed row; queue the un-completed one
      // for the pre-check only.
      (settingsQb.maybeSingle as jest.Mock).mockResolvedValueOnce({
        data: { ...settingsRow },
        error: null,
      });

      await expect(service.completeSetup(ownerUser)).resolves.toEqual({
        started: true,
        currentStep: 'timings',
        setupCompletedAt: '2026-09-26T01:00:00Z',
        enabled: true,
      });
      expect(rpc).toHaveBeenCalledWith('attendance_complete_setup', {
        p_tenant_id: TENANT_ID,
        p_actor_id: 'owner-uuid',
      });
      // The pre-check read (before the RPC) and the final read (after it)
      // both go through the same tenant-scoped chain.
      expect(settingsQb.eqs[0]).toHaveBeenCalledWith('tenant_id', TENANT_ID);
      expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('returns 404 ATTENDANCE_SETUP_NOT_STARTED when there is no settings row', async () => {
      const { rpc } = mockAdmin({
        settings: { data: unstartedSettings, error: null },
      });

      await expectErrorCode(
        service.completeSetup(ownerUser),
        404,
        ErrorCode.ATTENDANCE_SETUP_NOT_STARTED,
      );
      expect(rpc).not.toHaveBeenCalled();
    });

    it('returns 409 ATTENDANCE_SETUP_ALREADY_COMPLETED when the row is already completed (pre-check)', async () => {
      const { rpc } = mockAdmin({
        settings: { data: completedRow, error: null },
      });

      await expectErrorCode(
        service.completeSetup(ownerUser),
        409,
        ErrorCode.ATTENDANCE_SETUP_ALREADY_COMPLETED,
      );
      expect(rpc).not.toHaveBeenCalled();
    });

    it('maps the RPC PT422 gate rejection to 422 ATTENDANCE_SETUP_INCOMPLETE', async () => {
      mockAdmin({
        settings: { data: settingsRow, error: null },
        rpcError: {
          code: 'PT422',
          message: 'Setup gates unmet',
          hint: 'ATTENDANCE_SETUP_INCOMPLETE',
        },
      });

      await expectErrorCode(
        service.completeSetup(ownerUser),
        422,
        ErrorCode.ATTENDANCE_SETUP_INCOMPLETE,
      );
    });

    it('maps the RPC PT409 race fallback to 409 ATTENDANCE_SETUP_ALREADY_COMPLETED', async () => {
      // Pre-check sees an un-completed row, so the 409 can only come from the
      // RPC — proving the concurrent-completion fallback path.
      mockAdmin({
        settings: { data: settingsRow, error: null },
        rpcError: {
          code: 'PT409',
          message: 'already completed',
          hint: 'ATTENDANCE_SETUP_ALREADY_COMPLETED',
        },
      });

      await expectErrorCode(
        service.completeSetup(ownerUser),
        409,
        ErrorCode.ATTENDANCE_SETUP_ALREADY_COMPLETED,
      );
    });

    it('maps any other RPC failure to 500 INTERNAL_SERVER_ERROR', async () => {
      mockAdmin({
        settings: { data: settingsRow, error: null },
        rpcError: { code: 'XX000', message: 'boom' },
      });

      await expectErrorCode(
        service.completeSetup(ownerUser),
        500,
        ErrorCode.INTERNAL_SERVER_ERROR,
      );
    });

    it('requires a tenant — 400 VALIDATION_ERROR before any client call', async () => {
      const { from, rpc } = mockAdmin();

      await expectErrorCode(
        service.completeSetup(noTenantUser),
        400,
        ErrorCode.VALIDATION_ERROR,
      );
      expect(from).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  it('is injectable with just the Supabase factory (no other providers)', () => {
    expect(service).toBeDefined();
  });
});