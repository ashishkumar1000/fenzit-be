import { HttpException } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { PayrollCalendarService } from './payroll-calendar.service';

/**
 * The calendar service talks to one table plus the audit rpc. The stand-in
 * routes by call shape — an upsert payload means the write, an order() call
 * means the list read, anything else is the same-date existence probe — so
 * a routing change in the service fails loudly here. Every rejection the
 * CAP-4/8 validation names gets a case proving the refusal AND that nothing
 * was written.
 */
function build(
  opts: {
    listRows?: Array<Record<string, unknown>>;
    listError?: { code?: string; message: string } | null;
    existingRow?: Record<string, unknown> | null;
    existingError?: { code?: string; message: string } | null;
    upsertResult?: Record<string, unknown> | null;
    upsertError?: { code?: string; message: string } | null;
    rpcRejects?: unknown;
  } = {},
) {
  const upsertPayloads: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<Record<string, unknown>> = [];

  const mkBuilder = () => {
    const b: Record<string, unknown> = {};
    let ordered = false;
    let upsertPayload: Record<string, unknown> | undefined;
    for (const name of ['neq', 'limit']) {
      b[name] = jest.fn(() => b);
    }
    b['eq'] = jest.fn(() => b);
    b['order'] = jest.fn(() => {
      ordered = true;
      return b;
    });
    b['select'] = jest.fn(() => b);
    b['upsert'] = jest.fn((payload: Record<string, unknown>) => {
      upsertPayload = payload;
      upsertPayloads.push(payload);
      return b;
    });
    b['maybeSingle'] = jest.fn(() => b);
    b['single'] = jest.fn(() => b);
    b['then'] = (resolve: (v: unknown) => void) => {
      if (upsertPayload !== undefined) {
        resolve({
          data: opts.upsertResult ?? null,
          error: opts.upsertError ?? null,
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
  const service = new PayrollCalendarService(factory);
  return { service, from, rpc, rpcCalls, upsertPayloads };
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

const calendarRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'cal-1',
  tenant_id: 'tenant-A',
  effective_from: '2026-10-01',
  divisor_convention: 'fixed-30',
  cutoff_day: 20,
  pay_date: 5,
  created_at: '2026-11-17T00:00:00Z',
  updated_at: '2026-11-17T00:00:00Z',
  ...overrides,
});

const putDto = (
  overrides: Partial<{
    effectiveFrom: string;
    divisorConvention?: string;
    cutoffDay?: number;
    payDate?: number;
  }> = {},
) => ({
  effectiveFrom: '2026-10-01',
  ...overrides,
});

describe('PayrollCalendarService — validation (CAP-4/8)', () => {
  it.each([
    ['cutoff 29 (February reason)', putDto({ cutoffDay: 29 }), 'skip February'],
    ['cutoff 31', putDto({ cutoffDay: 31 }), 'between 1 and 28'],
    ['cutoff 0', putDto({ cutoffDay: 0 }), 'between 1 and 28'],
    [
      'pay date 8 (CoW reason)',
      putDto({ payDate: 8 }),
      'expiry of the 7th day',
    ],
    ['pay date 12', putDto({ payDate: 12 }), 'between 1 and 7'],
    ['pay date 0', putDto({ payDate: 0 }), 'between 1 and 7'],
    [
      'a bad divisor',
      putDto({ divisorConvention: 'weekly' }),
      'calendar, fixed-30, fixed-26',
    ],
    [
      'a cleared cutoff',
      putDto({ cutoffDay: null as unknown as number }),
      'cannot be cleared',
    ],
    [
      'a cleared pay date',
      putDto({ payDate: null as unknown as number }),
      'cannot be cleared',
    ],
    [
      'a cleared divisor',
      putDto({ divisorConvention: null as unknown as string }),
      'cannot be cleared',
    ],
  ])('rejects %s with a 422 and writes nothing', async (_name, dto, text) => {
    const t = build();
    const err = await httpError(t.service.save(companyAdmin, dto));
    expect(err.status).toBe(422);
    expect(String(err.body['message'])).toContain(text);
    expect(t.upsertPayloads).toHaveLength(0);
    expect(t.rpcCalls).toHaveLength(0);
  });

  it('accepts the full valid envelope with defaults for absent fields', async () => {
    const t = build({ upsertResult: calendarRow() });
    const view = await t.service.save(companyAdmin, {
      effectiveFrom: '2026-10-01',
      cutoffDay: 20,
    });
    expect(view).toMatchObject({
      cutoffDay: 20,
      divisorConvention: 'fixed-30',
    });
    expect(t.upsertPayloads[0]).toMatchObject({
      tenant_id: 'tenant-A',
      effective_from: '2026-10-01',
      divisor_convention: 'fixed-26',
      cutoff_day: 20,
      pay_date: 1,
    });
    expect(t.rpcCalls[0]['p_action']).toBe('payroll.calendar_saved');
  });

  it('accepts the inclusive bounds — cutoff 28 and pay date 7 are legal', async () => {
    const t = build({
      upsertResult: calendarRow({ cutoff_day: 28, pay_date: 7 }),
    });
    const view = await t.service.save(
      companyAdmin,
      putDto({ cutoffDay: 28, payDate: 7 }),
    );
    expect(view).toMatchObject({ cutoffDay: 28, payDate: 7 });
    expect(t.upsertPayloads[0]).toMatchObject({
      cutoff_day: 28,
      pay_date: 7,
    });
    expect(t.rpcCalls).toHaveLength(1);
  });

  it('a failed existence probe is a 500, never a silent no-op bypass', async () => {
    const t = build({ existingError: { code: 'XX000', message: 'boom' } });
    const err = await httpError(t.service.save(companyAdmin, putDto()));
    expect(err.status).toBe(500);
    expect(String(err.body['message'])).not.toContain('boom');
    expect(t.upsertPayloads).toHaveLength(0);
    expect(t.rpcCalls).toHaveLength(0);
  });

  it('a failed write is a 500 without DB text', async () => {
    const t = build({ upsertError: { code: '23514', message: 'boom' } });
    const err = await httpError(t.service.save(companyAdmin, putDto()));
    expect(err.status).toBe(500);
    expect(String(err.body['message'])).not.toContain('boom');
  });

  it('an audit rpc that resolves with an error still returns the save', async () => {
    const t = build({ upsertResult: calendarRow() });
    t.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'rls' },
    });
    const view = await t.service.save(companyAdmin, putDto());
    expect(view.effectiveFrom).toBe('2026-10-01');
  });
});

describe('PayrollCalendarService — same-date semantics', () => {
  it('an identical re-save writes nothing and audits nothing', async () => {
    const t = build({ existingRow: calendarRow() });
    const view = await t.service.save(
      companyAdmin,
      putDto({ divisorConvention: 'fixed-30', cutoffDay: 20, payDate: 5 }),
    );
    expect(view.effectiveFrom).toBe('2026-10-01');
    expect(t.upsertPayloads).toHaveLength(0);
    expect(t.rpcCalls).toHaveLength(0);
  });

  it('a changed same-date save replaces the dated row and stamps updated_at', async () => {
    const t = build({
      existingRow: calendarRow(),
      upsertResult: calendarRow(),
    });
    await t.service.save(companyAdmin, putDto({ cutoffDay: 15 }));
    expect(t.upsertPayloads).toHaveLength(1);
    expect(typeof t.upsertPayloads[0]['updated_at']).toBe('string');
    expect(t.rpcCalls[0]['p_action']).toBe('payroll.calendar_saved');
  });

  it('a replace is a full envelope: absent fields take the defaults, not the old row', async () => {
    const t = build({
      existingRow: calendarRow(),
      upsertResult: calendarRow(),
    });
    await t.service.save(companyAdmin, putDto({ cutoffDay: 15 }));
    expect(t.upsertPayloads[0]).toMatchObject({
      effective_from: '2026-10-01',
      divisor_convention: 'fixed-26',
      cutoff_day: 15,
      pay_date: 1,
    });
  });

  it('lists dated revisions oldest-first', async () => {
    const t = build({
      listRows: [
        calendarRow({ effective_from: '2026-10-01' }),
        calendarRow({ effective_from: '2026-12-01', cutoff_day: 15 }),
      ],
    });
    const views = await t.service.list(companyAdmin);
    expect(views.map((v) => v.effectiveFrom)).toEqual([
      '2026-10-01',
      '2026-12-01',
    ]);
  });

  it('a list failure is a 500 without DB text', async () => {
    const t = build({ listError: { code: 'XX000', message: 'boom' } });
    const err = await httpError(t.service.list(companyAdmin));
    expect(err.status).toBe(500);
    expect(String(err.body['message'])).not.toContain('boom');
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
      upsertResult: calendarRow(),
      rpcRejects: new Error('network down'),
    });
    const view = await t.service.save(companyAdmin, putDto());
    expect(view.effectiveFrom).toBe('2026-10-01');
  });
});
