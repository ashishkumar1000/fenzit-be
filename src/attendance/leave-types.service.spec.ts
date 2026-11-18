import { InternalServerErrorException } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { PgPoolFactory } from '../common/pg/pg-pool.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { LeaveTypesService } from './leave-types.service';

/**
 * The catalog service talks to the leave_types table plus the audit rpc
 * (23-13: the FIXED catalog — create/delete retired, the owner PATCHes
 * VALUES only; typing runs on a pg tx). This stand-in recognises each
 * builder by what it does — an update sets its flag, a full column select
 * is a row read, an ordered select is the list — so a mistake in the
 * service's own call order fails loudly here.
 */
function build(
  opts: {
    row?: Record<string, unknown> | null;
    updateTypeResult?: Record<string, unknown> | null;
    updateTypeError?: { code?: string; message?: string } | null;
    updateRequestResult?: Record<string, unknown> | null;
    updateRequestError?: { code?: string; message?: string } | null;
    listRows?: Array<Record<string, unknown>>;
    listError?: { code?: string; message?: string } | null;
    rpcResult?: { data: unknown; error: unknown };
    rpcRejects?: unknown;
    // setRequestType runs on a pg tx (23-9): these drive the stand-in tx's
    // SQL-shape routing; everything else above stays supabase-builder based.
    pgRequestRows?: Array<Record<string, unknown>>;
    pgDayRows?: Array<{ leave_date: string }>;
    pgTypeRows?: Array<Record<string, unknown>>;
    pgUpdateRows?: Array<Record<string, unknown>>;
    pgUpdateError?: { code: string; message: string } | null;
    pgLockRows?: Array<{ month: string }>;
  } = {},
) {
  const updateTypePayloads: Array<Record<string, unknown>> = [];
  const updateRequestPayloads: Array<Record<string, unknown>> = [];
  const orderCalls: Array<unknown[]> = [];
  const txQueries: Array<[string, unknown[]?]> = [];

  const mkBuilder = (table: string) => {
    const b: Record<string, unknown> = {};
    let updatePayload: Record<string, unknown> | undefined;
    for (const name of ['eq', 'neq', 'order', 'limit']) {
      b[name] = jest.fn((...args: unknown[]) => {
        if (name === 'order') orderCalls.push(args);
        return b;
      });
    }
    b['select'] = jest.fn(() => b);
    b['update'] = jest.fn((payload: Record<string, unknown>) => {
      updatePayload = payload;
      if (table === 'leave_types') updateTypePayloads.push(payload);
      else updateRequestPayloads.push(payload);
      return b;
    });
    b['maybeSingle'] = jest.fn(() => b);
    b['single'] = jest.fn(() => b);
    b['then'] = (resolve: (v: unknown) => void) => {
      if (table === 'leave_types') {
        if (updatePayload !== undefined) {
          resolve({
            data: opts.updateTypeResult ?? null,
            error: opts.updateTypeError ?? null,
          });
          return;
        }
        if (orderCalls.length > 0) {
          // the tenant list (name-ascending)
          const listRows: Array<Record<string, unknown>> = opts.listRows ?? [];
          const listError = opts.listError ?? null;
          resolve({ data: listRows, error: listError });
          return;
        }
        resolve({ data: opts.row ?? null, error: null });
        return;
      }
      // leave_requests
      if (updatePayload !== undefined) {
        resolve({
          data: opts.updateRequestResult ?? null,
          error: opts.updateRequestError ?? null,
        });
        return;
      }
      resolve({ data: null, error: null });
    };
    return b;
  };

  const from = jest.fn((table: string) => mkBuilder(table));
  const rpc =
    opts.rpcRejects !== undefined
      ? jest.fn().mockRejectedValue(opts.rpcRejects)
      : jest
          .fn()
          .mockResolvedValue(opts.rpcResult ?? { data: null, error: null });
  const admin = { from, rpc };
  const factory = {
    createAdmin: jest.fn(() => admin),
  } as unknown as jest.Mocked<SupabaseClientFactory>;

  // The typing tx stand-in: routes by SQL shape — the service's routing
  // changes fail loudly here (the payroll-lock spec's idiom).
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      txQueries.push([sql, params]);
      const trimmed = sql.trim().toLowerCase();
      // 23-13: the re-type holds the target employee's advisory lock.
      if (sql.includes('attendance_lock_employee')) {
        return Promise.resolve({ rows: [] });
      }
      if (
        trimmed.startsWith('select') &&
        sql.includes('from public.leave_requests')
      ) {
        return Promise.resolve({ rows: opts.pgRequestRows ?? [] });
      }
      if (sql.includes('from public.leave_request_days')) {
        return Promise.resolve({
          rows: opts.pgDayRows ?? [{ leave_date: '2026-10-05' }],
        });
      }
      if (
        trimmed.startsWith('select') &&
        sql.includes('from public.leave_types')
      ) {
        // readType probes by id — serve the row that was ASKED for, so a
        // current-type read and a target read can stage different rows.
        const requested = params?.[0];
        const rows = opts.pgTypeRows ?? [];
        const matched =
          typeof requested === 'string'
            ? rows.filter((r) => r['id'] === requested)
            : rows;
        return Promise.resolve({
          rows: matched.length > 0 ? [matched[0]] : [],
        });
      }
      if (sql.includes('update public.leave_requests')) {
        if (opts.pgUpdateError) {
          return Promise.reject(
            Object.assign(new Error(opts.pgUpdateError.message), {
              code: opts.pgUpdateError.code,
            }),
          );
        }
        return Promise.resolve({ rows: opts.pgUpdateRows ?? [] });
      }
      // The payroll-date gate's reads: no calendar rows (default cutoff 25),
      // and locks only when the test stages a frozen month.
      if (
        sql.includes('payroll_calendar') ||
        sql.includes('payroll_month_locks') ||
        sql.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: opts.pgLockRows ?? [] });
      }
      return Promise.reject(
        new Error(`unexpected SQL in the typing tx: ${sql}`),
      );
    }),
  };
  const pg = {
    withTransaction: jest.fn((work: (c: unknown) => Promise<unknown>) =>
      work(tx),
    ),
  } as unknown as jest.Mocked<PgPoolFactory>;

  const service = new LeaveTypesService(factory, pg);
  return {
    service,
    from,
    rpc,
    updateTypePayloads,
    updateRequestPayloads,
    orderCalls,
    txQueries,
  };
}

const companyAdmin: RequestUser = {
  userId: 'admin-1',
  tenantId: 'tenant-A',
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'jwt',
};

const typeRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'type-1',
  tenant_id: 'tenant-A',
  code: 'earned',
  name: 'Earned Leave',
  accrual_mode: 'monthly',
  accrual_days: '1.00',
  carry_forward: true,
  allow_over_balance: false,
  paid: true,
  enabled: true,
  created_at: '2026-11-17T00:00:00Z',
  updated_at: '2026-11-17T00:00:00Z',
  ...overrides,
});

const requestRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'request-1',
  tenant_id: 'tenant-A',
  employee_id: 'employee-1',
  leave_type_id: null,
  ...overrides,
});

/** The audited rpc call: [name, payload], typed so details asserts cleanly. */
function auditedRpc(
  rpc: { mock: { calls: Array<Array<unknown>> } },
  index: number,
): { name: string; payload: Record<string, unknown> } {
  const call = rpc.mock.calls[index] as unknown as [
    string,
    Record<string, unknown>,
  ];
  return { name: call[0], payload: call[1] };
}

const bodyOf = (e: unknown) => (e as { getResponse(): unknown }).getResponse();

const errorOf = async (run: () => Promise<unknown>) => {
  const err = await run().catch((e: unknown) => e);
  return {
    status: (err as { status?: number }).status ?? 0,
    body: bodyOf(err) as Record<string, unknown>,
  };
};

describe('LeaveTypesService', () => {
  describe('list — the owner catalog', () => {
    it('orders by name ascending and maps the rows with the accrual shape', async () => {
      const { service, orderCalls } = build({
        listRows: [
          typeRow({ name: 'A first' }),
          typeRow({
            id: 'type-9',
            code: null,
            accrual_mode: null,
            name: 'B remnant',
          }),
        ],
      });
      const views = await service.list(companyAdmin);
      expect(views).toHaveLength(2);
      expect(views[0]).toMatchObject({
        name: 'A first',
        code: 'earned',
        accrualMode: 'monthly',
        accrualDays: 1,
        carryForward: true,
        configurable: true,
        enabled: true,
      });
      // A legacy remnant answers configurable: false — its values cannot
      // be edited anywhere.
      expect(views[1]).toMatchObject({ code: null, configurable: false });
      expect(orderCalls[0]).toEqual(['name', { ascending: true }]);
    });

    it('a read failure hides behind a generic 500', async () => {
      const { service } = build({
        listError: { code: 'XX000', message: 'opaque internal text' },
      });
      const err = await service.list(companyAdmin).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect(JSON.stringify(bodyOf(err))).not.toContain('opaque internal text');
    });
  });

  describe('listEnabled — the employee catalog', () => {
    it('filters to enabled types only (Comp-Off included, remnants never)', async () => {
      const { service, orderCalls } = build({
        listRows: [
          typeRow({ name: 'Comp-Off', code: 'comp_off', accrual_mode: 'none' }),
        ],
      });
      const views = await service.listEnabled(companyAdmin);
      expect(views).toHaveLength(1);
      expect(views[0]).toMatchObject({ code: 'comp_off', accrualMode: 'none' });
      expect(orderCalls[0]).toEqual(['name', { ascending: true }]);
    });

    it('a read failure hides behind a generic 500 too', async () => {
      const { service } = build({
        listError: { code: 'XX000', message: 'opaque internal text' },
      });
      const err = await service
        .listEnabled(companyAdmin)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('patchValues — values-only editing of the FIXED catalog', () => {
    it('updates the accrual value field-by-field and audits old/new pairs', async () => {
      const { service, updateTypePayloads, rpc } = build({
        row: typeRow(),
        updateTypeResult: typeRow({ accrual_days: '2.00' }),
      });
      await expect(
        service.patchValues(companyAdmin, 'type-1', { accrualDays: 2 }),
      ).resolves.toMatchObject({ accrualDays: 2 });
      expect(updateTypePayloads[0]).toMatchObject({ accrual_days: 2 });
      expect(typeof updateTypePayloads[0]['updated_at']).toBe('string');
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(auditedRpc(rpc, 0).payload.p_action).toBe('leave.type_updated');
      expect(auditedRpc(rpc, 0).payload.p_details).toEqual({
        changed_fields: ['accrual_days'],
        old: { accrual_days: 1 },
        new: { accrual_days: 2 },
      });
    });

    it('multi-field PATCHes name every changed column in one audit entry', async () => {
      const { service, rpc } = build({
        row: typeRow({ allow_over_balance: false, enabled: true }),
        updateTypeResult: typeRow({ allow_over_balance: true, enabled: false }),
      });
      await service.patchValues(companyAdmin, 'type-1', {
        allowOverBalance: true,
        enabled: false,
      });
      expect(auditedRpc(rpc, 0).payload.p_details).toEqual({
        changed_fields: ['allow_over_balance', 'enabled'],
        old: { allow_over_balance: false, enabled: true },
        new: { allow_over_balance: true, enabled: false },
      });
    });

    it('a save that changes nothing writes no row and no audit entry', async () => {
      const { service, rpc, updateTypePayloads } = build({ row: typeRow() });
      await service.patchValues(companyAdmin, 'type-1', {
        accrualDays: 1,
        carryForward: true,
        allowOverBalance: false,
        paid: true,
        enabled: true,
      });
      expect(updateTypePayloads).toHaveLength(0);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('name and code arrive stripped by the pipe and land as the no-change answer', async () => {
      // The DTO has no name/code field — anything left after the global
      // pipe's whitelist strip cannot reach the service. This pin proves
      // the SERVICE side: an unknown key (a hostile direct call) still
      // writes nothing and persists nothing non-editable.
      const { service, updateTypePayloads, rpc } = build({ row: typeRow() });
      await service.patchValues(companyAdmin, 'type-1', {
        name: 'Renamed',
      } as unknown as Record<string, never>);
      expect(updateTypePayloads).toHaveLength(0);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('a legacy remnant answers 409 LEAVE_TYPE_NOT_CONFIGURABLE and writes nothing', async () => {
      const { service, updateTypePayloads, rpc } = build({
        row: typeRow({ code: null, accrual_mode: null }),
      });
      const { status, body } = await errorOf(() =>
        service.patchValues(companyAdmin, 'type-1', { paid: false }),
      );
      expect(status).toBe(409);
      expect(body).toMatchObject({
        error_code: 'LEAVE_TYPE_NOT_CONFIGURABLE',
      });
      expect(updateTypePayloads).toHaveLength(0);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('the mode rules refuse impossible values in plain English', async () => {
      const cases: Array<{
        row: Record<string, unknown>;
        dto: Record<string, unknown>;
        fragment: string;
      }> = [
        {
          row: typeRow({ code: 'comp_off', accrual_mode: 'none' }),
          dto: { accrualDays: 1 },
          fragment: 'no accrual to configure',
        },
        {
          row: typeRow({
            code: 'bereavement',
            accrual_mode: 'annual',
            carry_forward: false,
          }),
          dto: { carryForward: true },
          fragment: 'carry forward',
        },
        {
          row: typeRow({
            code: 'bereavement',
            accrual_mode: 'annual',
            allow_over_balance: false,
          }),
          dto: { allowOverBalance: true },
          fragment: 'over-balance',
        },
      ];
      for (const { row, dto: payload, fragment } of cases) {
        const { service, updateTypePayloads } = build({ row });
        const { status, body } = await errorOf(() =>
          service.patchValues(companyAdmin, 'type-1', payload),
        );
        expect(status).toBe(422);
        expect(String(body['message'])).toContain(fragment);
        expect(updateTypePayloads).toHaveLength(0);
      }
    });

    it('legal values on every mode pass (annual grant, comp-off disable)', async () => {
      const { service } = build({
        row: typeRow({
          code: 'bereavement',
          accrual_mode: 'annual',
          carry_forward: false,
        }),
        updateTypeResult: typeRow({
          code: 'bereavement',
          accrual_mode: 'annual',
          accrual_days: '5.00',
          carry_forward: false,
        }),
      });
      await expect(
        service.patchValues(companyAdmin, 'type-1', { accrualDays: 5 }),
      ).resolves.toMatchObject({ accrualDays: 5 });
    });

    it('the type of another company answers 404', async () => {
      const { service } = build({ row: null });
      const { status, body } = await errorOf(() =>
        service.patchValues(companyAdmin, 'foreign-1', { paid: false }),
      );
      expect(status).toBe(404);
      expect(body).toMatchObject({ error_code: 'RESOURCE_NOT_FOUND' });
    });

    it('the row vanishing between read and write answers 404, not a 500', async () => {
      const { service } = build({
        row: typeRow(),
        updateTypeError: { code: 'PGRST116', message: 'no rows' },
      });
      const { status, body } = await errorOf(() =>
        service.patchValues(companyAdmin, 'type-1', { paid: false }),
      );
      expect(status).toBe(404);
      expect(body).toMatchObject({ error_code: 'RESOURCE_NOT_FOUND' });
    });

    it('an unknown database error hides behind a generic 500 with no database text', async () => {
      const { service } = build({
        row: typeRow(),
        updateTypeError: { code: 'XX000', message: 'opaque internal text' },
      });
      const err = await service
        .patchValues(companyAdmin, 'type-1', { paid: false })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect(JSON.stringify(bodyOf(err))).not.toContain('opaque internal text');
    });
  });

  describe('setRequestType — tri-state typing (pg tx, 23-9 + 23-13)', () => {
    it('absent key is untouched and returns the current effective marking', async () => {
      const { service, txQueries, rpc } = build({
        pgRequestRows: [requestRow()],
      });
      const result = await service.setRequestType(
        companyAdmin,
        'request-1',
        {},
      );
      expect(result).toEqual({
        requestId: 'request-1',
        employeeId: 'employee-1',
        leaveTypeId: null,
        paid: true, // untyped reads paid
      });
      expect(
        txQueries.some((c) =>
          String(c[0]).includes('update public.leave_requests'),
        ),
      ).toBe(false);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('holds the target employee\u2019s advisory lock before any decision (23-13)', async () => {
      const { service, txQueries } = build({
        pgRequestRows: [requestRow()],
      });
      await service.setRequestType(companyAdmin, 'request-1', {});
      const lock = txQueries.find((c) =>
        String(c[0]).includes('attendance_lock_employee'),
      );
      expect(lock).toBeDefined();
      expect(lock?.[1]?.[0]).toBe('employee-1');
      // The lock lands AFTER the request read (it needs the employee id).
      const requestRead = txQueries.findIndex((c) =>
        String(c[0]).includes('from public.leave_requests'),
      );
      const lockIndex = txQueries.findIndex((c) =>
        String(c[0]).includes('attendance_lock_employee'),
      );
      expect(lockIndex).toBeGreaterThan(requestRead);
    });

    it('null clears the typing back to the untyped = paid default', async () => {
      const { service, txQueries, rpc } = build({
        pgRequestRows: [requestRow({ leave_type_id: 'type-1' })],
        pgTypeRows: [typeRow()],
        pgUpdateRows: [
          { id: 'request-1', employee_id: 'employee-1', leave_type_id: null },
        ],
      });
      const result = await service.setRequestType(companyAdmin, 'request-1', {
        leaveTypeId: null,
      });
      expect(result).toMatchObject({ leaveTypeId: null, paid: true });
      const updateCall = txQueries.find((c) =>
        String(c[0]).includes('update public.leave_requests'),
      );
      expect(updateCall?.[1]?.[0]).toBeNull(); // leave_type_id = null
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(auditedRpc(rpc, 0).payload.p_action).toBe('leave.request_typed');
    });

    it('a value reads the type, writes the link, and audits the old/new paid flags', async () => {
      const { service, rpc } = build({
        pgRequestRows: [requestRow()],
        pgTypeRows: [
          typeRow({
            id: 'type-2',
            code: 'sick',
            name: 'Sick Leave',
            paid: false,
          }),
        ],
        pgUpdateRows: [
          {
            id: 'request-1',
            employee_id: 'employee-1',
            leave_type_id: 'type-2',
          },
        ],
      });
      const result = await service.setRequestType(companyAdmin, 'request-1', {
        leaveTypeId: 'type-2',
      });
      expect(result).toMatchObject({ leaveTypeId: 'type-2', paid: false });
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(auditedRpc(rpc, 0).payload.p_action).toBe('leave.request_typed');
    });

    it('a DISABLED target type is refused 422 LEAVE_TYPE_DISABLED with no write (23-13)', async () => {
      const { service, txQueries, rpc } = build({
        pgRequestRows: [requestRow()],
        pgTypeRows: [typeRow({ id: 'type-2', enabled: false })],
      });
      const { status, body } = await errorOf(() =>
        service.setRequestType(companyAdmin, 'request-1', {
          leaveTypeId: 'type-2',
        }),
      );
      expect(status).toBe(422);
      expect(body).toMatchObject({ error_code: 'LEAVE_TYPE_DISABLED' });
      expect(
        txQueries.some((c) =>
          String(c[0]).includes('update public.leave_requests'),
        ),
      ).toBe(false);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('a legacy REMNANT target (code null) is refused the same way (23-13)', async () => {
      const { service } = build({
        pgRequestRows: [requestRow()],
        pgTypeRows: [
          typeRow({
            id: 'type-2',
            code: null,
            accrual_mode: null,
            name: 'Casual Leave',
          }),
        ],
      });
      const { status, body } = await errorOf(() =>
        service.setRequestType(companyAdmin, 'request-1', {
          leaveTypeId: 'type-2',
        }),
      );
      expect(status).toBe(422);
      expect(body).toMatchObject({ error_code: 'LEAVE_TYPE_DISABLED' });
    });

    it('re-typing FROM a remnant onto a fixed type still works (23-13)', async () => {
      const { service, rpc } = build({
        pgRequestRows: [requestRow({ leave_type_id: 'type-old' })],
        pgTypeRows: [
          // First read: the request's CURRENT type — a remnant is legal
          // there (a legacy request keeps its bucket).
          typeRow({
            id: 'type-old',
            code: null,
            accrual_mode: null,
            name: 'Casual Leave',
          }),
          // Second read: the new target — a fixed type.
          typeRow({ id: 'type-2', code: 'sick', name: 'Sick Leave' }),
        ],
        pgUpdateRows: [
          {
            id: 'request-1',
            employee_id: 'employee-1',
            leave_type_id: 'type-2',
          },
        ],
      });
      await expect(
        service.setRequestType(companyAdmin, 'request-1', {
          leaveTypeId: 'type-2',
        }),
      ).resolves.toMatchObject({ leaveTypeId: 'type-2' });
      expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('a no-op re-type onto a type disabled AFTER the fact answers 200 and writes nothing', async () => {
      const { service, txQueries, rpc } = build({
        pgRequestRows: [requestRow({ leave_type_id: 'type-1' })],
        pgTypeRows: [typeRow({ enabled: false })],
      });
      const result = await service.setRequestType(companyAdmin, 'request-1', {
        leaveTypeId: 'type-1',
      });
      expect(result.paid).toBe(true);
      expect(
        txQueries.some((c) =>
          String(c[0]).includes('update public.leave_requests'),
        ),
      ).toBe(false);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('a foreign or unknown type id answers 404', async () => {
      const { service } = build({
        pgRequestRows: [requestRow()],
        pgTypeRows: [],
      });
      const { status, body } = await errorOf(() =>
        service.setRequestType(companyAdmin, 'request-1', {
          leaveTypeId: 'foreign-1',
        }),
      );
      expect(status).toBe(404);
      expect(body).toMatchObject({ error_code: 'RESOURCE_NOT_FOUND' });
    });

    it('a type deleted mid-typing (23503) answers a typing-flavoured 409', async () => {
      const { service } = build({
        pgRequestRows: [requestRow()],
        pgTypeRows: [typeRow({ id: 'type-2', code: 'sick' })],
        pgUpdateError: { code: '23503', message: 'foreign key' },
      });
      const { status, body } = await errorOf(() =>
        service.setRequestType(companyAdmin, 'request-1', {
          leaveTypeId: 'type-2',
        }),
      );
      expect(status).toBe(409);
      expect(body).toMatchObject({ error_code: 'LEAVE_TYPE_CHANGED' });
      expect(String(body['message'])).toContain('no longer available');
    });

    it('the request vanishing answers 404, and so does a write that touches nothing', async () => {
      const missing = build({});
      const a = await errorOf(() =>
        missing.service.setRequestType(companyAdmin, 'stranger-1', {
          leaveTypeId: 'type-1',
        }),
      );
      expect(a.status).toBe(404);

      const { service } = build({
        pgRequestRows: [requestRow()],
        pgTypeRows: [typeRow({ id: 'type-2', code: 'sick', paid: false })],
        pgUpdateRows: [],
      });
      const b = await errorOf(() =>
        service.setRequestType(companyAdmin, 'request-1', {
          leaveTypeId: 'type-2',
        }),
      );
      expect(b.status).toBe(404);
    });

    it('a request of another company answers 404, no existence leak', async () => {
      const { service } = build({ pgRequestRows: [] });
      const { status } = await errorOf(() =>
        service.setRequestType(companyAdmin, 'stranger-1', {
          leaveTypeId: 'type-1',
        }),
      );
      expect(status).toBe(404);
    });

    it('typing the same value again writes nothing and audits nothing', async () => {
      const { service, txQueries, rpc } = build({
        pgRequestRows: [requestRow({ leave_type_id: 'type-1' })],
        pgTypeRows: [typeRow()],
      });
      const result = await service.setRequestType(companyAdmin, 'request-1', {
        leaveTypeId: 'type-1',
      });
      expect(result.paid).toBe(true);
      expect(
        txQueries.some((c) =>
          String(c[0]).includes('update public.leave_requests'),
        ),
      ).toBe(false);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('a failed audit entry does not undo the typing', async () => {
      const { service } = build({
        pgRequestRows: [requestRow()],
        pgTypeRows: [typeRow({ id: 'type-2', code: 'sick', paid: false })],
        pgUpdateRows: [
          {
            id: 'request-1',
            employee_id: 'employee-1',
            leave_type_id: 'type-2',
          },
        ],
        rpcResult: { data: null, error: { code: 'PT403', message: 'x' } },
      });
      await expect(
        service.setRequestType(companyAdmin, 'request-1', {
          leaveTypeId: 'type-2',
        }),
      ).resolves.toMatchObject({ paid: false });
    });

    it('a rejected audit write does not undo the typing either', async () => {
      const { service } = build({
        pgRequestRows: [requestRow()],
        pgTypeRows: [typeRow({ id: 'type-2', code: 'sick', paid: false })],
        pgUpdateRows: [
          {
            id: 'request-1',
            employee_id: 'employee-1',
            leave_type_id: 'type-2',
          },
        ],
        rpcRejects: new Error('network down'),
      });
      await expect(
        service.setRequestType(companyAdmin, 'request-1', {
          leaveTypeId: 'type-2',
        }),
      ).resolves.toMatchObject({ paid: false });
    });

    it('a frozen date refuses the re-type with 409 PAYROLL_MONTH_LOCKED and no write (23-9)', async () => {
      const { service, txQueries, rpc } = build({
        pgRequestRows: [requestRow()],
        pgTypeRows: [typeRow({ id: 'type-2', code: 'sick', paid: false })],
        pgLockRows: [{ month: '2026-10' }],
      });
      const { status, body } = await errorOf(() =>
        service.setRequestType(companyAdmin, 'request-1', {
          leaveTypeId: 'type-2',
        }),
      );
      expect(status).toBe(409);
      expect(body).toMatchObject({ error_code: 'PAYROLL_MONTH_LOCKED' });
      expect(
        txQueries.some((c) =>
          String(c[0]).includes('update public.leave_requests'),
        ),
      ).toBe(false);
      expect(rpc).not.toHaveBeenCalled();
    });
  });
});
