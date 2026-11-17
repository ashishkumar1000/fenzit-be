import { HttpException, InternalServerErrorException } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import {
  PayrollComponentsService,
  employeeNameList,
} from './payroll-components.service';

/**
 * The components service talks to two tables (salary_components,
 * salary_structures) plus memberships for the deactivation list, and the
 * audit rpc. The stand-in recognises each builder by what it does — the eq
 * args tell the probes apart, so a mistake in the service's own call order
 * fails loudly here.
 */
function build(
  opts: {
    row?: Record<string, unknown> | null;
    listRows?: Array<Record<string, unknown>>;
    listError?: { code?: string; message: string } | null;
    probeRow?: { id: string } | null;
    basicRow?: Record<string, unknown> | null;
    /** Exact count the JSONB-containment reference probe returns. */
    structureRefCount?: number;
    /** The first referencing rows the display read returns. */
    referenceRows?: Array<Record<string, unknown>>;
    nameRows?: Array<Record<string, unknown>>;
    insertResult?: Record<string, unknown> | null;
    insertError?: { code?: string; message: string } | null;
    updateResult?: Record<string, unknown> | null;
    updateError?: { code?: string; message: string } | null;
    rpcRejects?: unknown;
  } = {},
) {
  const insertPayloads: Array<Record<string, unknown>> = [];
  const updatePayloads: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<Record<string, unknown>> = [];

  const mkBuilder = (table: string) => {
    const b: Record<string, unknown> = {};
    let selectArg: unknown = null;
    let headCount = false;
    let ranged = false;
    const eqCalls: Array<[string, unknown]> = [];
    let ordered = false;
    let insertPayload: Record<string, unknown> | undefined;
    let updatePayload: Record<string, unknown> | undefined;
    for (const name of ['neq', 'limit']) {
      b[name] = jest.fn(() => b);
    }
    b['contains'] = jest.fn(() => b);
    b['range'] = jest.fn(() => {
      ranged = true;
      return b;
    });
    b['eq'] = jest.fn((col: string, value: unknown) => {
      eqCalls.push([col, value]);
      return b;
    });
    b['order'] = jest.fn(() => {
      ordered = true;
      return b;
    });
    b['in'] = jest.fn(() => b);
    b['select'] = jest.fn(
      (arg: unknown, options?: { count?: string; head?: boolean }) => {
        selectArg = arg;
        headCount = options?.count === 'exact' && options?.head === true;
        return b;
      },
    );
    b['insert'] = jest.fn((payload: Record<string, unknown>) => {
      insertPayload = payload;
      insertPayloads.push({ ...payload, __table: table });
      return b;
    });
    b['update'] = jest.fn((payload: Record<string, unknown>) => {
      updatePayload = payload;
      updatePayloads.push(payload);
      return b;
    });
    b['upsert'] = jest.fn(() => b);
    b['maybeSingle'] = jest.fn(() => b);
    b['single'] = jest.fn(() => b);
    b['then'] = (resolve: (v: unknown) => void) => {
      if (table === 'salary_components') {
        if (insertPayload !== undefined) {
          resolve({
            data: opts.insertResult ?? null,
            error: opts.insertError ?? null,
          });
          return;
        }
        if (updatePayload !== undefined) {
          resolve({
            data: opts.updateResult ?? null,
            error: opts.updateError ?? null,
          });
          return;
        }
        if (selectArg === 'id') {
          resolve({ data: opts.probeRow ?? null, error: null });
          return;
        }
        if (eqCalls.some(([col]) => col === 'is_basic')) {
          resolve({ data: opts.basicRow ?? null, error: null });
          return;
        }
        if (ordered) {
          resolve({ data: opts.listRows ?? [], error: opts.listError ?? null });
          return;
        }
        resolve({ data: opts.row ?? null, error: null });
        return;
      }
      if (table === 'salary_structures') {
        if (headCount) {
          resolve({
            data: null,
            count: opts.structureRefCount ?? 0,
            error: null,
          });
          return;
        }
        if (ranged) {
          resolve({ data: opts.referenceRows ?? [], error: null });
          return;
        }
        resolve({ data: null, error: null });
        return;
      }
      // memberships
      resolve({ data: opts.nameRows ?? [], error: null });
    };
    return b;
  };

  const from = jest.fn((table: string) => mkBuilder(table));
  const rpc =
    opts.rpcRejects !== undefined
      ? jest.fn().mockRejectedValue(opts.rpcRejects)
      : jest
          .fn()
          .mockImplementation((fn: string, args: Record<string, unknown>) => {
            rpcCalls.push({ fn, ...args });
            return Promise.resolve({ data: null, error: null });
          });
  const admin = { from, rpc };
  const factory = {
    createAdmin: jest.fn(() => admin),
  } as unknown as jest.Mocked<SupabaseClientFactory>;
  const service = new PayrollComponentsService(factory);
  return { service, from, rpc, rpcCalls, insertPayloads, updatePayloads };
}

/** Captures the HttpException a refused call must raise, typed. */
async function httpError(
  promise: Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await promise;
    throw new Error('expected the call to be refused');
  } catch (e) {
    const http = e as HttpException;
    return {
      status: http.getStatus(),
      body: http.getResponse() as Record<string, unknown>,
    };
  }
}

const companyAdmin: RequestUser = {
  userId: 'admin-1',
  tenantId: 'tenant-A',
  role: Role.COMPANY_ADMIN,
  platformAdmin: false,
  rawJwt: 'jwt',
};

const componentRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'comp-1',
  tenant_id: 'tenant-A',
  name: 'Basic',
  is_basic: true,
  active: true,
  created_at: '2026-11-17T00:00:00Z',
  updated_at: '2026-11-17T00:00:00Z',
  ...overrides,
});

describe('PayrollComponentsService — the library (CAP-1)', () => {
  it('creates a component; the insert carries the tenant and the basic flag', async () => {
    const t = build({
      insertResult: componentRow({ name: 'HRA', is_basic: false }),
    });
    const view = await t.service.create(companyAdmin, {
      name: 'HRA',
      isBasic: false,
    });
    expect(view).toMatchObject({ name: 'HRA', isBasic: false, active: true });
    expect(t.insertPayloads[0]).toMatchObject({
      tenant_id: 'tenant-A',
      name: 'HRA',
      is_basic: false,
    });
    expect(t.rpcCalls[0]['p_action']).toBe('payroll.component_created');
  });

  it('creates the basic component when the company has none yet', async () => {
    const t = build({ insertResult: componentRow() });
    await t.service.create(companyAdmin, { name: 'Basic', isBasic: true });
    expect(t.insertPayloads[0]['is_basic']).toBe(true);
  });

  it('refuses a second basic naming the current one — exactly one basic (CAP-1)', async () => {
    const t = build({
      basicRow: componentRow({ id: 'comp-1', name: 'Basic' }),
    });
    const err = await httpError(
      t.service.create(companyAdmin, { name: 'Other', isBasic: true }),
    );
    expect(err.status).toBe(409);
    expect(err.body['error_code']).toBe('BASIC_COMPONENT_EXISTS');
    expect(err.body['message']).toContain('"Basic"');
    expect(t.insertPayloads).toHaveLength(0);
  });

  it('refuses a duplicate name with a 409 naming it, before any write', async () => {
    const t = build({ probeRow: { id: 'comp-x' } });
    const err = await httpError(
      t.service.create(companyAdmin, { name: 'Basic' }),
    );
    expect(err.status).toBe(409);
    expect(err.body['error_code']).toBe('DUPLICATE_RESOURCE');
    expect(err.body['message']).toContain('"Basic"');
    expect(t.insertPayloads).toHaveLength(0);
  });

  it('maps an insert 23505 to the duplicate 409 (probe-write race backstop)', async () => {
    const t = build({
      insertError: { code: '23505', message: 'unique' },
    });
    const err = await httpError(
      t.service.create(companyAdmin, { name: 'Basic' }),
    );
    expect(err.status).toBe(409);
    expect(err.body['error_code']).toBe('DUPLICATE_RESOURCE');
  });

  it('maps an unknown insert failure to a 500 that leaks no DB text', async () => {
    const t = build({
      insertError: { code: 'XX000', message: 'secret db internals' },
    });
    const err = await httpError(
      t.service.create(companyAdmin, { name: 'Basic' }),
    );
    expect(err.status).toBe(500);
    expect(String(err.body['message'])).not.toContain('secret');
  });

  it('renames a component and stamps updated_at itself', async () => {
    const t = build({
      row: componentRow(),
      updateResult: componentRow({ name: 'Basic Pay' }),
    });
    await t.service.update(companyAdmin, 'comp-1', { name: 'Basic Pay' });
    expect(t.updatePayloads[0]).toMatchObject({ name: 'Basic Pay' });
    expect(typeof t.updatePayloads[0]['updated_at']).toBe('string');
    // Only what changed: the basic flag was not part of this edit.
    expect(t.updatePayloads[0]).not.toHaveProperty('is_basic');
    expect(t.rpcCalls[0]['p_action']).toBe('payroll.component_updated');
    expect(t.rpcCalls[0]['p_details']).toEqual({ changed_fields: ['name'] });
  });

  it.each([
    ['name', { name: null }, 'rename the component instead'],
    ['isBasic', { isBasic: null }, 'cannot be cleared'],
    ['active', { active: null }, 'cannot be cleared'],
    ['blank name', { name: '   ' }, 'empty or whitespace'],
  ])(
    'refuses clearing %s with a 422 (no clear verb)',
    async (_field, dto, text) => {
      const t = build({ row: componentRow() });
      const err = await httpError(
        t.service.update(companyAdmin, 'comp-1', dto),
      );
      expect(err.status).toBe(422);
      expect(String(err.body['message'])).toContain(text);
      expect(t.updatePayloads).toHaveLength(0);
    },
  );

  it('an identical re-save changes nothing and audits nothing', async () => {
    const t = build({ row: componentRow() });
    const view = await t.service.update(companyAdmin, 'comp-1', {
      name: 'Basic',
      isBasic: true,
      active: true,
    });
    expect(view.name).toBe('Basic');
    expect(t.updatePayloads).toHaveLength(0);
    expect(t.rpcCalls).toHaveLength(0);
  });

  it('refuses the basic move while another component holds it', async () => {
    const t = build({
      row: componentRow({ id: 'comp-2', name: 'HRA', is_basic: false }),
      basicRow: componentRow({ id: 'comp-1', name: 'Basic' }),
    });
    const err = await httpError(
      t.service.update(companyAdmin, 'comp-2', { isBasic: true }),
    );
    expect(err.status).toBe(409);
    expect(err.body['error_code']).toBe('BASIC_COMPONENT_EXISTS');
    expect(err.body['message']).toContain('"Basic"');
    expect(t.updatePayloads).toHaveLength(0);
  });

  it('clearing the basic designation is allowed (a structure save then re-checks)', async () => {
    const t = build({
      row: componentRow(),
      updateResult: componentRow({ is_basic: false }),
    });
    await t.service.update(companyAdmin, 'comp-1', { isBasic: false });
    expect(t.updatePayloads[0]['is_basic']).toBe(false);
  });

  it('refuses deactivation naming the referencing employees', async () => {
    const t = build({
      row: componentRow({ name: 'HRA', is_basic: false }),
      structureRefCount: 1,
      referenceRows: [{ membership_id: 'm-1' }],
      nameRows: [{ id: 'm-1', users: { name: 'Ramesh' } }],
    });
    const err = await httpError(
      t.service.update(companyAdmin, 'comp-1', { active: false }),
    );
    expect(err.status).toBe(409);
    expect(err.body['error_code']).toBe('SALARY_COMPONENT_IN_USE');
    expect(err.body['message']).toContain('Ramesh');
    expect(t.updatePayloads).toHaveLength(0);
  });

  it('the deactivation refusal stays correct with two referencing structures', async () => {
    const t = build({
      row: componentRow({ name: 'HRA', is_basic: false }),
      structureRefCount: 2,
      referenceRows: [{ membership_id: 'm-1' }, { membership_id: 'm-2' }],
      nameRows: [
        { id: 'm-1', users: { name: 'A' } },
        { id: 'm-2', users: { name: 'B' } },
      ],
    });
    const err = await httpError(
      t.service.update(companyAdmin, 'comp-1', { active: false }),
    );
    expect(err.status).toBe(409);
    expect(String(err.body['message'])).toContain('A, B');
    expect(t.updatePayloads).toHaveLength(0);
  });

  it('deactivates a component nothing references', async () => {
    const t = build({
      row: componentRow({ name: 'HRA', is_basic: false }),
      structureRefCount: 0,
      updateResult: componentRow({ active: false }),
    });
    await t.service.update(companyAdmin, 'comp-1', { active: false });
    expect(t.updatePayloads[0]['active']).toBe(false);
  });

  it('reactivation never probes structures', async () => {
    const t = build({
      row: componentRow({ active: false, name: 'HRA', is_basic: false }),
      updateResult: componentRow({ active: true }),
    });
    await t.service.update(companyAdmin, 'comp-1', { active: true });
    // The structures probe only runs for a deactivation; reactivation went
    // straight to the update.
    expect(t.from).not.toHaveBeenCalledWith('salary_structures');
    expect(t.updatePayloads[0]['active']).toBe(true);
  });

  it('an update PGRST116 (row vanished mid-edit) is a 404, not a 500', async () => {
    const t = build({
      row: componentRow(),
      updateError: { code: 'PGRST116', message: 'no rows' },
    });
    const err = await httpError(
      t.service.update(companyAdmin, 'comp-1', { name: 'X' }),
    );
    expect(err.status).toBe(404);
  });

  it('lists the library name-ascending', async () => {
    const t = build({
      listRows: [
        componentRow({ name: 'Basic' }),
        componentRow({ id: 'comp-2', name: 'HRA', is_basic: false }),
      ],
    });
    const views = await t.service.list(companyAdmin);
    expect(views.map((v) => v.name)).toEqual(['Basic', 'HRA']);
    expect(views[1]).toMatchObject({ isBasic: false, active: true });
  });

  it('a list failure is a 500 without DB text', async () => {
    const t = build({ listError: { code: 'XX000', message: 'boom' } });
    await expect(t.service.list(companyAdmin)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('a caller with no company is a 400 before any query', async () => {
    const t = build();
    const err = await httpError(
      t.service.list({ ...companyAdmin, tenantId: null }),
    );
    expect(err.status).toBe(400);
    expect(t.from).not.toHaveBeenCalled();
  });

  it('an audit rpc rejection never undoes the save', async () => {
    const t = build({
      insertResult: componentRow({ name: 'HRA', is_basic: false }),
      rpcRejects: new Error('network down'),
    });
    const view = await t.service.create(companyAdmin, { name: 'HRA' });
    expect(view.name).toBe('HRA');
  });
});

it('a truncated display list still states the full count', async () => {
  const t = build({
    row: componentRow({ name: 'HRA', is_basic: false }),
    structureRefCount: 7,
    referenceRows: [1, 2, 3, 4, 5].map((i) => ({ membership_id: `m-${i}` })),
    nameRows: [1, 2, 3, 4, 5].map((i) => ({
      id: `m-${i}`,
      users: { name: `E${i}` },
    })),
  });
  const err = await httpError(
    t.service.update(companyAdmin, 'comp-1', { active: false }),
  );
  expect(err.status).toBe(409);
  expect(String(err.body['message'])).toContain(
    'E1, E2, E3, E4, E5 and 2 more',
  );
});

it('renaming into a taken name is refused before any write (probe excludes self)', async () => {
  const t = build({
    row: componentRow({ id: 'comp-2', name: 'HRA', is_basic: false }),
    probeRow: { id: 'comp-x' },
  });
  const err = await httpError(
    t.service.update(companyAdmin, 'comp-2', { name: 'Basic' }),
  );
  expect(err.status).toBe(409);
  expect(err.body['error_code']).toBe('DUPLICATE_RESOURCE');
  expect(t.updatePayloads).toHaveLength(0);
});

it('an insert racing the one-basic index answers BASIC_COMPONENT_EXISTS', async () => {
  const t = build({
    basicRow: componentRow({ name: 'Basic' }),
    insertError: {
      code: '23505',
      message:
        'duplicate key value violates unique constraint "salary_components_tenant_basic_uq"',
    },
  });
  const err = await httpError(
    t.service.create(companyAdmin, { name: 'Other', isBasic: true }),
  );
  expect(err.status).toBe(409);
  expect(err.body['error_code']).toBe('BASIC_COMPONENT_EXISTS');
  expect(err.body['message']).toContain('"Basic"');
});

it('an update racing the one-basic index answers BASIC_COMPONENT_EXISTS', async () => {
  const t = build({
    row: componentRow({ id: 'comp-2', name: 'HRA', is_basic: false }),
    basicRow: componentRow({ name: 'Basic' }),
    updateError: {
      code: '23505',
      message:
        'duplicate key value violates unique constraint "salary_components_tenant_basic_uq"',
    },
  });
  const err = await httpError(
    t.service.update(companyAdmin, 'comp-2', { isBasic: true }),
  );
  expect(err.status).toBe(409);
  expect(err.body['error_code']).toBe('BASIC_COMPONENT_EXISTS');
  expect(err.body['message']).toContain('"Basic"');
});

it('a name-duplicate 23505 still answers DUPLICATE_RESOURCE (branch discipline)', async () => {
  const t = build({
    insertError: {
      code: '23505',
      message:
        'duplicate key value violates unique constraint "salary_components_tenant_name_uq"',
    },
  });
  const err = await httpError(t.service.create(companyAdmin, { name: 'HRA' }));
  expect(err.status).toBe(409);
  expect(err.body['error_code']).toBe('DUPLICATE_RESOURCE');
});

describe('employeeNameList — the five-name cap', () => {
  it('lists up to five names plainly', () => {
    expect(employeeNameList(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C, D, E');
  });
  it('caps at five and says how many more', () => {
    expect(employeeNameList(['A', 'B', 'C', 'D', 'E', 'F', 'G'])).toBe(
      'A, B, C, D, E and 2 more',
    );
  });
  it('uses the exact total when the read was range-truncated', () => {
    expect(employeeNameList(['A', 'B'], 7)).toBe('A, B and 5 more');
  });
});
