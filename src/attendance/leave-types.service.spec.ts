import { InternalServerErrorException } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { LeaveTypesService, defaultPaidMarking } from './leave-types.service';

/**
 * The catalog service talks to two tables (leave_types, leave_requests) plus
 * the audit rpc. This stand-in recognises each builder by what it does — an
 * insert/update/delete sets its flag, a `select('id')` is a probe, a full
 * column select is a row read — and answers with the matching result, so a
 * mistake in the service's own call order fails loudly here.
 */
function build(
  opts: {
    row?: Record<string, unknown> | null;
    requestRow?: Record<string, unknown> | null;
    probeRow?: { id: string } | null;
    referenceRow?: { id: string } | null;
    insertResult?: Record<string, unknown> | null;
    insertError?: { code?: string; message?: string } | null;
    updateTypeResult?: Record<string, unknown> | null;
    updateTypeError?: { code?: string; message?: string } | null;
    updateRequestResult?: Record<string, unknown> | null;
    updateRequestError?: { code?: string; message?: string } | null;
    deleteError?: { code?: string; message?: string } | null;
    deleteResult?: Array<{ id: string }>;
    listRows?: Array<Record<string, unknown>>;
    listError?: { code?: string; message?: string } | null;
    rpcResult?: { data: unknown; error: unknown };
    rpcRejects?: unknown;
  } = {},
) {
  const insertPayloads: Array<Record<string, unknown>> = [];
  const updateTypePayloads: Array<Record<string, unknown>> = [];
  const updateRequestPayloads: Array<Record<string, unknown>> = [];
  const deletedFlags: string[] = [];
  const orderCalls: Array<unknown[]> = [];

  const mkBuilder = (table: string) => {
    const b: Record<string, unknown> = {};
    let selectArg: unknown = null;
    let insertPayload: Record<string, unknown> | undefined;
    let updatePayload: Record<string, unknown> | undefined;
    let deleted = false;
    for (const name of ['eq', 'neq', 'order', 'limit']) {
      b[name] = jest.fn((...args: unknown[]) => {
        if (name === 'order') orderCalls.push(args);
        return b;
      });
    }
    b['select'] = jest.fn((arg: unknown) => {
      selectArg = arg;
      return b;
    });
    b['insert'] = jest.fn((payload: Record<string, unknown>) => {
      insertPayload = payload;
      insertPayloads.push(payload);
      return b;
    });
    b['update'] = jest.fn((payload: Record<string, unknown>) => {
      updatePayload = payload;
      if (table === 'leave_types') updateTypePayloads.push(payload);
      else updateRequestPayloads.push(payload);
      return b;
    });
    b['delete'] = jest.fn(() => {
      deleted = true;
      deletedFlags.push(table);
      return b;
    });
    b['maybeSingle'] = jest.fn(() => b);
    b['single'] = jest.fn(() => b);
    b['then'] = (resolve: (v: unknown) => void) => {
      if (table === 'leave_types') {
        if (insertPayload !== undefined) {
          resolve({
            data: opts.insertResult ?? null,
            error: opts.insertError ?? null,
          });
          return;
        }
        if (updatePayload !== undefined) {
          resolve({
            data: opts.updateTypeResult ?? null,
            error: opts.updateTypeError ?? null,
          });
          return;
        }
        if (deleted) {
          // The delete was made row-returning (remove checks the count).
          const removedRows: Array<{ id: string }> = opts.deleteResult ?? [
            { id: 'type-1' },
          ];
          resolve({ data: removedRows, error: opts.deleteError ?? null });
          return;
        }
        if (selectArg === 'id') {
          resolve({ data: opts.probeRow ?? null, error: null });
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
      if (selectArg === 'id') {
        // The in-use probe is limit(1) — it reads an ARRAY now.
        resolve({
          data: opts.referenceRow ? [opts.referenceRow] : [],
          error: null,
        });
        return;
      }
      resolve({ data: opts.requestRow ?? null, error: null });
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
  const service = new LeaveTypesService(factory);
  return {
    service,
    from,
    rpc,
    insertPayloads,
    updateTypePayloads,
    updateRequestPayloads,
    deletedFlags,
    orderCalls,
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
  name: 'Casual Leave',
  paid: true,
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
  describe('defaultPaidMarking — the confirmed keyword table', () => {
    it('casual, sick and earned default to paid', () => {
      expect(defaultPaidMarking('Casual Leave')).toBe(true);
      expect(defaultPaidMarking('Sick Leave')).toBe(true);
      expect(defaultPaidMarking('Earned Leave')).toBe(true);
    });

    it('unpaid and LOP default to unpaid, word-scoped', () => {
      expect(defaultPaidMarking('Unpaid Leave')).toBe(false);
      expect(defaultPaidMarking('LOP')).toBe(false);
      expect(defaultPaidMarking('LOP Leave')).toBe(false);
      expect(defaultPaidMarking('a galloping name')).toBe(true); // no word "lop"
    });

    it('unpaid is word-scoped too: a compound that contains it does not match', () => {
      expect(defaultPaidMarking('Unpaidleave')).toBe(true);
      expect(defaultPaidMarking('sununpaidish')).toBe(true);
      expect(defaultPaidMarking('unpaid-ish')).toBe(false); // hyphen is a boundary
    });

    it('anything else defaults to paid', () => {
      expect(defaultPaidMarking('Special Shutdown')).toBe(true);
      expect(defaultPaidMarking('Comp-off')).toBe(true);
    });
  });

  describe('create', () => {
    it('applies the paid keyword default and says so', async () => {
      const { service, insertPayloads, rpc } = build({
        insertResult: typeRow({ name: 'Casual Leave', paid: true }),
      });
      const view = await service.create(companyAdmin, {
        name: 'Casual Leave',
      });
      expect(view).toMatchObject({ paid: true, appliedDefault: 'paid' });
      expect(insertPayloads[0]).toEqual({
        tenant_id: 'tenant-A',
        name: 'Casual Leave',
        paid: true,
      });
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(auditedRpc(rpc, 0).name).toBe('write_audit_row');
      expect(auditedRpc(rpc, 0).payload.p_action).toBe('leave.type_created');
    });

    it('applies the unpaid keyword default for LOP names', async () => {
      const { service, insertPayloads } = build({
        insertResult: typeRow({ name: 'LOP', paid: false }),
      });
      const view = await service.create(companyAdmin, { name: 'LOP' });
      expect(view).toMatchObject({ paid: false, appliedDefault: 'unpaid' });
      expect(insertPayloads[0]?.['paid']).toBe(false);
    });

    it('an explicit flag wins and no default is reported', async () => {
      const { service, insertPayloads } = build({
        insertResult: typeRow({ name: 'Special', paid: false }),
      });
      const view = await service.create(companyAdmin, {
        name: 'Special',
        paid: false,
      });
      expect(view).toEqual({
        id: 'type-1',
        name: 'Special',
        paid: false,
        createdAt: '2026-11-17T00:00:00Z',
        updatedAt: '2026-11-17T00:00:00Z',
      });
      expect(insertPayloads[0]?.['paid']).toBe(false);
    });

    it('an explicit paid: null takes the keyword default and reports it', async () => {
      const { service, insertPayloads } = build({
        insertResult: typeRow({ name: 'Sick Leave', paid: true }),
      });
      const view = await service.create(companyAdmin, {
        name: 'Sick Leave',
        paid: null,
      });
      expect(view).toMatchObject({ paid: true, appliedDefault: 'paid' });
      expect(insertPayloads[0]?.['paid']).toBe(true);
    });

    it('a name another type wears is a 409 naming it, and nothing is written', async () => {
      const { service, insertPayloads } = build({
        probeRow: { id: 'type-9' },
      });
      const { status, body } = await errorOf(() =>
        service.create(companyAdmin, { name: 'Casual Leave' }),
      );
      expect(status).toBe(409);
      expect(body).toMatchObject({ error_code: 'DUPLICATE_RESOURCE' });
      expect(String(body['message'])).toContain('Casual Leave');
      expect(insertPayloads).toHaveLength(0);
    });

    it('a 23505 that slips past the probe answers the same 409', async () => {
      const { service } = build({
        insertError: { code: '23505', message: 'duplicate key' },
      });
      const { status, body } = await errorOf(() =>
        service.create(companyAdmin, { name: 'Casual Leave' }),
      );
      expect(status).toBe(409);
      expect(String(body['message'])).toContain('Casual Leave');
    });

    it('a caller with no company is refused before any read', async () => {
      const { service, from } = build();
      const { status } = await errorOf(() =>
        service.create(
          { ...companyAdmin, tenantId: null },
          {
            name: 'X',
          },
        ),
      );
      expect(status).toBe(400);
      expect(from).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('flips the marking with a field-by-field payload and one audit entry', async () => {
      const { service, updateTypePayloads, rpc } = build({
        row: typeRow(),
        updateTypeResult: typeRow({ paid: false }),
      });
      await expect(
        service.update(companyAdmin, 'type-1', { paid: false }),
      ).resolves.toMatchObject({ paid: false });
      expect(updateTypePayloads[0]).toMatchObject({ paid: false });
      expect(typeof updateTypePayloads[0]['updated_at']).toBe('string');
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(auditedRpc(rpc, 0).payload.p_action).toBe('leave.type_updated');
      expect(auditedRpc(rpc, 0).payload.p_details).toEqual({
        changed_fields: ['paid'],
        old_paid: true,
        new_paid: false,
      });
    });

    it('renaming into a name another type wears probes with self excluded and refuses', async () => {
      const { service, updateTypePayloads } = build({
        row: typeRow({ name: 'Old Name' }),
        probeRow: { id: 'type-2' },
      });
      const { status, body } = await errorOf(() =>
        service.update(companyAdmin, 'type-1', { name: 'Casual Leave' }),
      );
      expect(status).toBe(409);
      expect(body).toMatchObject({ error_code: 'DUPLICATE_RESOURCE' });
      expect(String(body['message'])).toContain('Casual Leave');
      expect(updateTypePayloads).toHaveLength(0);
    });

    it('a duplicate probe is self-excluded: the type may keep its own name', async () => {
      const { service, from } = build({ row: typeRow({ name: 'Old Name' }) });
      await service.update(companyAdmin, 'type-1', { name: 'Old Name' });
      // No probe and no write: unchanged name means a no-op save.
      expect(from).toHaveBeenCalledTimes(1); // the row read only
    });

    it('null or blank name and null paid are refused — there is no clear verb', async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ name: null }, 'rename'],
        [{ paid: null }, 'cannot be cleared'],
        [{ name: '   ' }, 'empty'],
      ];
      for (const [payload, fragment] of cases) {
        const { service } = build({ row: typeRow() });
        const { status, body } = await errorOf(() =>
          service.update(companyAdmin, 'type-1', payload),
        );
        expect(status).toBe(422);
        expect(String(body['message'])).toContain(fragment);
      }
    });

    it('a save that changes nothing writes no row and no audit entry', async () => {
      const { service, rpc, updateTypePayloads } = build({
        row: typeRow({ name: 'Casual Leave', paid: true }),
      });
      await service.update(companyAdmin, 'type-1', {
        name: 'Casual Leave',
        paid: true,
      });
      expect(updateTypePayloads).toHaveLength(0);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('the type of another company answers 404', async () => {
      const { service } = build({ row: null });
      const { status, body } = await errorOf(() =>
        service.update(companyAdmin, 'foreign-1', { paid: false }),
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
        service.update(companyAdmin, 'type-1', { paid: false }),
      );
      expect(status).toBe(404);
      expect(body).toMatchObject({ error_code: 'RESOURCE_NOT_FOUND' });
    });
  });

  describe('list', () => {
    it('orders by name ascending and maps the rows', async () => {
      const { service, orderCalls } = build({
        listRows: [typeRow({ name: 'A first' }), typeRow({ name: 'B second' })],
      });
      const views = await service.list(companyAdmin);
      expect(views).toHaveLength(2);
      expect(views[0]).toMatchObject({ name: 'A first', paid: true });
      expect(orderCalls[0]).toEqual(['name', { ascending: true }]);
    });

    it('an empty catalog answers an empty list, not an error', async () => {
      const { service } = build({ listRows: [] });
      await expect(service.list(companyAdmin)).resolves.toEqual([]);
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

  describe('remove', () => {
    it('a type that requests reference is refused, and nothing is deleted', async () => {
      const { service, deletedFlags } = build({
        row: typeRow(),
        referenceRow: { id: 'request-7' },
      });
      const { status, body } = await errorOf(() =>
        service.remove(companyAdmin, 'type-1'),
      );
      expect(status).toBe(409);
      expect(body).toMatchObject({ error_code: 'LEAVE_TYPE_IN_USE' });
      expect(deletedFlags).toHaveLength(0);
    });

    it('an unused type is deleted and audited', async () => {
      const { service, deletedFlags, rpc } = build({ row: typeRow() });
      await service.remove(companyAdmin, 'type-1');
      expect(deletedFlags).toEqual(['leave_types']);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(auditedRpc(rpc, 0).name).toBe('write_audit_row');
      expect(auditedRpc(rpc, 0).payload.p_action).toBe('leave.type_deleted');
    });

    it('a delete that removed zero rows answers 404 and writes NO audit entry', async () => {
      const { service, rpc } = build({
        row: typeRow(),
        deleteResult: [], // the row was already gone (a raced delete)
      });
      const { status, body } = await errorOf(() =>
        service.remove(companyAdmin, 'type-1'),
      );
      expect(status).toBe(404);
      expect(body).toMatchObject({ error_code: 'RESOURCE_NOT_FOUND' });
      expect(rpc).not.toHaveBeenCalled();
    });

    it('a 23503 that slips past the probe answers the same 409', async () => {
      const { service } = build({
        row: typeRow(),
        deleteError: { code: '23503', message: 'foreign key' },
      });
      const { status } = await errorOf(() =>
        service.remove(companyAdmin, 'type-1'),
      );
      expect(status).toBe(409);
    });

    it('a missing type answers 404', async () => {
      const { service } = build({ row: null });
      const { status } = await errorOf(() =>
        service.remove(companyAdmin, 'ghost-1'),
      );
      expect(status).toBe(404);
    });
  });

  describe('setRequestType — tri-state typing', () => {
    it('absent key is untouched and returns the current effective marking', async () => {
      const { service, updateRequestPayloads, rpc } = build({
        requestRow: requestRow(),
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
      expect(updateRequestPayloads).toHaveLength(0);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('null clears the typing back to the untyped = paid default', async () => {
      const { service, updateRequestPayloads, rpc } = build({
        requestRow: requestRow({ leave_type_id: 'type-1' }),
        row: typeRow(), // the current type, read for the effective marking
        updateRequestResult: requestRow({ leave_type_id: null }),
      });
      const result = await service.setRequestType(companyAdmin, 'request-1', {
        leaveTypeId: null,
      });
      expect(result).toMatchObject({ leaveTypeId: null, paid: true });
      expect(updateRequestPayloads[0]).toEqual({ leave_type_id: null });
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(auditedRpc(rpc, 0).name).toBe('write_audit_row');
      expect(auditedRpc(rpc, 0).payload.p_action).toBe('leave.request_typed');
    });

    it('a value reads the type, writes the link, and audits the old/new paid flags', async () => {
      const { service, updateRequestPayloads, rpc } = build({
        requestRow: requestRow(),
        row: typeRow({ id: 'type-2', name: 'Unpaid Leave', paid: false }),
        updateRequestResult: requestRow({ leave_type_id: 'type-2' }),
      });
      const result = await service.setRequestType(companyAdmin, 'request-1', {
        leaveTypeId: 'type-2',
      });
      expect(result).toMatchObject({ leaveTypeId: 'type-2', paid: false });
      expect(updateRequestPayloads[0]).toEqual({ leave_type_id: 'type-2' });
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(auditedRpc(rpc, 0).name).toBe('write_audit_row');
      expect(auditedRpc(rpc, 0).payload.p_action).toBe('leave.request_typed');
      expect(auditedRpc(rpc, 0).payload.p_details).toEqual({
        changed_fields: ['leave_type_id'],
        old_paid: true,
        new_paid: false,
      });
    });

    it('a foreign or unknown type id answers 404', async () => {
      const { service } = build({
        requestRow: requestRow(),
        row: null,
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
        requestRow: requestRow(),
        row: typeRow({ id: 'type-2', name: 'Unpaid Leave', paid: false }),
        updateRequestError: { code: '23503', message: 'foreign key' },
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

    it('the request vanishing between read and write answers 404', async () => {
      const { service } = build({
        requestRow: requestRow(),
        updateRequestError: { code: 'PGRST116', message: 'no rows' },
      });
      const { status } = await errorOf(() =>
        service.setRequestType(companyAdmin, 'request-1', {
          leaveTypeId: 'type-2',
        }),
      );
      expect(status).toBe(404);
    });

    it('a request of another company answers 404, no existence leak', async () => {
      const { service } = build({ requestRow: null });
      const { status } = await errorOf(() =>
        service.setRequestType(companyAdmin, 'stranger-1', {
          leaveTypeId: 'type-1',
        }),
      );
      expect(status).toBe(404);
    });

    it('typing the same value again writes nothing and audits nothing', async () => {
      const { service, updateRequestPayloads, rpc } = build({
        requestRow: requestRow({ leave_type_id: 'type-1' }),
        row: typeRow(),
      });
      const result = await service.setRequestType(companyAdmin, 'request-1', {
        leaveTypeId: 'type-1',
      });
      expect(result.paid).toBe(true);
      expect(updateRequestPayloads).toHaveLength(0);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('a failed audit entry does not undo the typing', async () => {
      const { service } = build({
        requestRow: requestRow(),
        row: typeRow({ id: 'type-2', paid: false }),
        updateRequestResult: requestRow({ leave_type_id: 'type-2' }),
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
        requestRow: requestRow(),
        row: typeRow({ id: 'type-2', paid: false }),
        updateRequestResult: requestRow({ leave_type_id: 'type-2' }),
        rpcRejects: new Error('network down'),
      });
      await expect(
        service.setRequestType(companyAdmin, 'request-1', {
          leaveTypeId: 'type-2',
        }),
      ).resolves.toMatchObject({ paid: false });
    });
  });

  it('an unknown database error hides behind a generic 500 with no database text', async () => {
    const { service } = build({
      insertError: { code: 'XX000', message: 'opaque internal text' },
    });
    const err = await service
      .create(companyAdmin, { name: 'X' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InternalServerErrorException);
    expect(JSON.stringify(bodyOf(err))).not.toContain('opaque internal text');
  });
});
