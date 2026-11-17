import { HttpException } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import {
  DeductionHeadsService,
  resolveHeadsForMonth,
} from './deduction-heads.service';
import { moneyText } from './formula';

/**
 * The heads service follows the calendar idiom (same name+date replace,
 * identical no-op, audit) and the validation refuses the shape mismatches:
 * a percentage without a basis, a basis on a flat head, an out-of-range
 * percentage. resolveHeadsForMonth is the run engine's read — month-start
 * resolution per name, deactivations drop out.
 */
function build(
  opts: {
    listRows?: Array<Record<string, unknown>>;
    listError?: { code?: string; message: string } | null;
    existingRow?: Record<string, unknown> | null;
    existingError?: { code?: string; message: string } | null;
    saveResult?: Record<string, unknown> | null;
    saveError?: { code?: string; message: string } | null;
    deactivateResult?: Record<string, unknown> | null;
    deactivateError?: { code?: string; message: string } | null;
    rpcRejects?: unknown;
  } = {},
) {
  const upsertPayloads: Array<Record<string, unknown>> = [];
  const updatePayloads: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<Record<string, unknown>> = [];

  const mkBuilder = () => {
    const b: Record<string, unknown> = {};
    let upsertPayload: Record<string, unknown> | undefined;
    let updatePayload: Record<string, unknown> | undefined;
    let ordered = false;
    for (const name of ['eq']) {
      b[name] = jest.fn(() => b);
    }
    b['order'] = jest.fn(() => {
      ordered = true;
      return b;
    });
    b['select'] = jest.fn(() => b);
    b['maybeSingle'] = jest.fn(() => b);
    b['single'] = jest.fn(() => b);
    b['upsert'] = jest.fn((payload: Record<string, unknown>) => {
      upsertPayload = payload;
      upsertPayloads.push(payload);
      return b;
    });
    b['update'] = jest.fn((payload: Record<string, unknown>) => {
      updatePayload = payload;
      updatePayloads.push(payload);
      return b;
    });
    b['then'] = (resolve: (v: unknown) => void) => {
      if (upsertPayload !== undefined) {
        resolve({
          data: opts.saveResult ?? null,
          error: opts.saveError ?? null,
        });
        return;
      }
      if (updatePayload !== undefined) {
        resolve({
          data: opts.deactivateResult ?? null,
          error: opts.deactivateError ?? null,
        });
        return;
      }
      if (ordered) {
        resolve({ data: opts.listRows ?? [], error: opts.listError ?? null });
        return;
      }
      resolve({
        data: opts.existingRow ?? null,
        error: opts.existingError ?? null,
      });
    };
    return b;
  };

  const from = jest.fn(() => mkBuilder());
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
  const service = new DeductionHeadsService(factory);
  return { service, from, rpc, rpcCalls, upsertPayloads, updatePayloads };
}

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

const headRow = (overrides: Record<string, unknown> = {}) => ({
  name: 'Professional Tax',
  kind: 'flat',
  amount: '200.00',
  basis: null,
  effective_from: '2026-09-01',
  active: true,
  updated_at: '2026-11-17T00:00:00Z',
  ...overrides,
});

describe('DeductionHeadsService — validation (CAP-6)', () => {
  it.each([
    [
      'a percentage without a basis',
      {
        name: 'Insurance',
        kind: 'percent',
        amount: '2.00',
        effectiveFrom: '2026-09-01',
      },
      'needs a basis',
    ],
    [
      'a basis on a flat head',
      {
        name: 'PT',
        kind: 'flat',
        amount: '200.00',
        basis: 'gross',
        effectiveFrom: '2026-09-01',
      },
      'only a percentage head carries a basis',
    ],
    [
      'a zero percentage',
      {
        name: 'Insurance',
        kind: 'percent',
        amount: '0',
        basis: 'gross',
        effectiveFrom: '2026-09-01',
      },
      'between 0 (exclusive)',
    ],
    [
      'a percentage over 100',
      {
        name: 'Insurance',
        kind: 'percent',
        amount: '101',
        basis: 'basic',
        effectiveFrom: '2026-09-01',
      },
      'between 0 (exclusive)',
    ],
    [
      'a fractional percent beyond 2 decimals',
      {
        name: 'Insurance',
        kind: 'percent',
        amount: '2.555',
        basis: 'gross',
        effectiveFrom: '2026-09-01',
      },
      'at most 2 decimals',
    ],
    [
      'a flat amount that is not money',
      { name: 'PT', kind: 'flat', amount: 'abc', effectiveFrom: '2026-09-01' },
      'money text',
    ],
    [
      'a flat amount with 3 decimals',
      {
        name: 'PT',
        kind: 'flat',
        amount: '200.000',
        effectiveFrom: '2026-09-01',
      },
      'money text',
    ],
    [
      'a zero flat amount',
      { name: 'PT', kind: 'flat', amount: '0.00', effectiveFrom: '2026-09-01' },
      'more than zero',
    ],
    [
      'a bad kind',
      {
        name: 'PT',
        kind: 'perquisite',
        amount: '200.00',
        effectiveFrom: '2026-09-01',
      },
      'flat or percent',
    ],
  ])('rejects %s with a 422 and writes nothing', async (_name, dto, text) => {
    const t = build();
    const err = await httpError(t.service.save(companyAdmin, dto as never));
    expect(err.status).toBe(422);
    expect(String(err.body['message'])).toContain(text);
    expect(t.upsertPayloads).toHaveLength(0);
    expect(t.rpcCalls).toHaveLength(0);
  });

  it('normalises amounts to money text and audits the save', async () => {
    const t = build({ saveResult: headRow() });
    await t.service.save(companyAdmin, {
      name: 'Insurance',
      kind: 'percent',
      amount: '2.5',
      basis: 'gross',
      effectiveFrom: '2026-09-01',
    });
    expect(t.upsertPayloads[0]).toMatchObject({
      tenant_id: 'tenant-A',
      name: 'Insurance',
      kind: 'percent',
      amount: '2.50',
      basis: 'gross',
      active: true,
    });
    expect(t.rpcCalls[0]['p_action']).toBe('payroll.head_saved');
  });

  it('a flat head normalises "200" to "200.00" with no basis', async () => {
    const t = build({ saveResult: headRow() });
    await t.service.save(companyAdmin, {
      name: 'PT',
      kind: 'flat',
      amount: '200',
      effectiveFrom: '2026-09-01',
    });
    expect(t.upsertPayloads[0]).toMatchObject({
      name: 'PT',
      kind: 'flat',
      amount: '200.00',
      basis: null,
    });
  });

  it.each(['100', '100.00', '0.01'])(
    'accepts the inclusive percent boundary %s',
    async (amount) => {
      const t = build({ saveResult: headRow() });
      await t.service.save(companyAdmin, {
        name: 'Full Pct',
        kind: 'percent',
        amount,
        basis: 'basic',
        effectiveFrom: '2026-09-01',
      });
      expect(t.upsertPayloads[0]['amount']).toBe(moneyText(Number(amount)));
    },
  );

  it('accepts a 12-digit flat amount and refuses a 13-digit one', async () => {
    const ok = build({ saveResult: headRow() });
    await ok.service.save(companyAdmin, {
      name: 'Big Levy',
      kind: 'flat',
      amount: '999999999999.99',
      effectiveFrom: '2026-09-01',
    });
    expect(ok.upsertPayloads[0]['amount']).toBe('999999999999.99');

    const t = build();
    const err = await httpError(
      t.service.save(companyAdmin, {
        name: 'Bigger Levy',
        kind: 'flat',
        amount: '9999999999999.00',
        effectiveFrom: '2026-09-01',
      }),
    );
    expect(err.status).toBe(422);
    expect(t.upsertPayloads).toHaveLength(0);
  });

  it('a whitespace-only name is refused by the service too', async () => {
    const t = build({ saveResult: headRow() });
    const err = await httpError(
      t.service.save(companyAdmin, {
        name: '   ',
        kind: 'flat',
        amount: '200.00',
        effectiveFrom: '2026-09-01',
      }),
    );
    expect(err.status).toBe(422);
    expect(t.upsertPayloads).toHaveLength(0);
  });
});

describe('DeductionHeadsService — same-date semantics and deactivation', () => {
  it('an identical re-save writes nothing and audits nothing', async () => {
    const t = build({ existingRow: headRow() });
    const view = await t.service.save(companyAdmin, {
      name: 'Professional Tax',
      kind: 'flat',
      amount: '200.00',
      effectiveFrom: '2026-09-01',
    });
    expect(view.name).toBe('Professional Tax');
    expect(t.upsertPayloads).toHaveLength(0);
    expect(t.rpcCalls).toHaveLength(0);
  });

  it('a changed same-date save replaces the revision', async () => {
    const t = build({ existingRow: headRow(), saveResult: headRow() });
    await t.service.save(companyAdmin, {
      name: 'Professional Tax',
      kind: 'flat',
      amount: '250.00',
      effectiveFrom: '2026-09-01',
    });
    expect(t.upsertPayloads).toHaveLength(1);
    expect(t.rpcCalls[0]['p_details']).toMatchObject({
      previous: { amount: '200.00' },
    });
  });

  it('an identical re-save over a RETIRED revision re-enacts it and audits', async () => {
    const t = build({
      existingRow: headRow({ active: false }),
      saveResult: headRow(),
    });
    const view = await t.service.save(companyAdmin, {
      name: 'Professional Tax',
      kind: 'flat',
      amount: '200.00',
      effectiveFrom: '2026-09-01',
    });
    expect(view.active).toBe(true);
    expect(t.upsertPayloads).toHaveLength(1);
    expect(t.upsertPayloads[0]['active']).toBe(true);
    expect(t.rpcCalls).toHaveLength(1);
  });

  it('a same-name save with a NEW date creates a second dated revision', async () => {
    const t = build({ existingRow: headRow(), saveResult: headRow() });
    await t.service.save(companyAdmin, {
      name: 'Professional Tax',
      kind: 'flat',
      amount: '250.00',
      effectiveFrom: '2026-11-01',
    });
    expect(t.upsertPayloads).toHaveLength(1);
    expect(t.upsertPayloads[0]['effective_from']).toBe('2026-11-01');
  });

  it('a save write failure is a 500 without DB text', async () => {
    const t = build({ saveError: { code: '23514', message: 'boom' } });
    const err = await httpError(
      t.service.save(companyAdmin, {
        name: 'PT',
        kind: 'flat',
        amount: '200.00',
        effectiveFrom: '2026-09-01',
      }),
    );
    expect(err.status).toBe(500);
    expect(String(err.body['message'])).not.toContain('boom');
  });

  it('deactivation with confirm=false is refused before any query', async () => {
    const t = build({ deactivateResult: headRow() });
    const err = await httpError(
      t.service.deactivate(companyAdmin, 'head-1', false),
    );
    expect(err.status).toBe(422);
    expect(String(err.body['message'])).toContain('confirm must be true');
    expect(t.updatePayloads).toHaveLength(0);
  });

  it('deactivation retires the head and audits', async () => {
    const t = build({ deactivateResult: headRow({ active: false }) });
    const view = await t.service.deactivate(companyAdmin, 'head-1', true);
    expect(view.active).toBe(false);
    expect(t.updatePayloads[0]).toMatchObject({ active: false });
    expect(t.rpcCalls[0]['p_action']).toBe('payroll.head_deactivated');
  });

  it('deactivating an unknown (or already retired) head is a 404', async () => {
    const t = build({ deactivateResult: null });
    const err = await httpError(t.service.deactivate(companyAdmin, 'x', true));
    expect(err.status).toBe(404);
    expect(t.rpcCalls).toHaveLength(0);
  });

  it('a caller with no company is a 400 before any query', async () => {
    const t = build();
    const err = await httpError(
      t.service.list({ ...companyAdmin, tenantId: null }),
    );
    expect(err.status).toBe(400);
    expect(t.from).not.toHaveBeenCalled();
  });

  it('a list failure is a 500 without DB text', async () => {
    const t = build({ listError: { code: 'XX000', message: 'boom' } });
    const err = await httpError(t.service.list(companyAdmin));
    expect(err.status).toBe(500);
    expect(String(err.body['message'])).not.toContain('boom');
  });

  it('an audit rpc rejection never undoes the save', async () => {
    const t = build({ saveResult: headRow(), rpcRejects: new Error('down') });
    const view = await t.service.save(companyAdmin, {
      name: 'PT',
      kind: 'flat',
      amount: '200.00',
      effectiveFrom: '2026-09-01',
    });
    expect(view.amount).toBe('200.00');
  });
});

describe('resolveHeadsForMonth — the run engine read', () => {
  const rows = [
    headRow({
      name: 'Professional Tax',
      amount: '200.00',
      effective_from: '2026-09-01',
    }),
    headRow({
      name: 'Professional Tax',
      amount: '250.00',
      effective_from: '2026-11-01',
    }),
    headRow({
      name: 'Insurance',
      kind: 'percent',
      amount: '2.00',
      basis: 'gross',
      effective_from: '2026-09-01',
    }),
    headRow({
      name: 'Retired Levy',
      amount: '50.00',
      effective_from: '2026-09-01',
      active: false,
    }),
  ];

  it('October resolves the September-dated revisions', () => {
    const heads = resolveHeadsForMonth(rows, '2026-10');
    expect(heads).toEqual([
      { name: 'Insurance', kind: 'percent', amount: '2.00', basis: 'gross' },
      { name: 'Professional Tax', kind: 'flat', amount: '200.00', basis: null },
    ]);
  });

  it('November resolves the November-dated PT revision', () => {
    const pt = resolveHeadsForMonth(rows, '2026-11').find(
      (h) => h.name === 'Professional Tax',
    );
    expect(pt?.amount).toBe('250.00');
  });

  it('a mid-month-dated revision is invisible to its own month', () => {
    const mid = [headRow({ amount: '200.00', effective_from: '2026-10-15' })];
    expect(resolveHeadsForMonth(mid, '2026-10')).toEqual([]);
    expect(resolveHeadsForMonth(mid, '2026-11')).toEqual([
      { name: 'Professional Tax', kind: 'flat', amount: '200.00', basis: null },
    ]);
  });

  it('a deactivated head drops out even when it is the governing revision', () => {
    const heads = resolveHeadsForMonth(rows, '2026-10');
    expect(heads.find((h) => h.name === 'Retired Levy')).toBeUndefined();
  });

  it('an inactive governing revision drops the head even when an earlier active revision exists (no fallback)', () => {
    const multi = [
      headRow({
        name: 'Professional Tax',
        amount: '200.00',
        effective_from: '2026-09-01',
      }),
      headRow({
        name: 'Professional Tax',
        amount: '250.00',
        effective_from: '2026-11-01',
        active: false,
      }),
    ];
    // September still reads the active 200 row; November's governing
    // revision is retired, so the head is gone for November — resolution
    // never falls back to the earlier active revision.
    expect(
      resolveHeadsForMonth(multi, '2026-10').find(
        (h) => h.name === 'Professional Tax',
      ),
    ).toMatchObject({ amount: '200.00' });
    expect(resolveHeadsForMonth(multi, '2026-11')).toEqual([]);
  });

  it('no rows resolve to no heads', () => {
    expect(resolveHeadsForMonth([], '2026-10')).toEqual([]);
  });

  it('a malformed month is refused loudly, never lexically mis-resolved', () => {
    expect(() => resolveHeadsForMonth(rows, '2026-9')).toThrow('YYYY-MM');
  });

  it('a row that does not positively say active is dropped (fail closed)', () => {
    const partial = [headRow({ active: undefined as unknown as boolean })];
    expect(resolveHeadsForMonth(partial, '2026-10')).toEqual([]);
  });
});
