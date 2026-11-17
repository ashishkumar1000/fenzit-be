import { HttpException } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { PayrollStateRulesService } from './payroll-state-rules.service';

/**
 * The state-rules flag: absent row reads as false, a real change persists
 * and audits, an identical re-save writes nothing.
 */
function build(
  opts: {
    existingRow?: Record<string, unknown> | null;
    readError?: { code?: string; message: string } | null;
    upsertResult?: Record<string, unknown> | null;
    upsertError?: { code?: string; message: string } | null;
    rpcRejects?: unknown;
  } = {},
) {
  const upsertPayloads: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<Record<string, unknown>> = [];

  const mkBuilder = () => {
    const b: Record<string, unknown> = {};
    let upsertPayload: Record<string, unknown> | undefined;
    for (const name of ['eq', 'select']) {
      b[name] = jest.fn(() => b);
    }
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
      resolve({
        data: opts.readError ? null : (opts.existingRow ?? null),
        error: opts.readError ?? null,
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
  const service = new PayrollStateRulesService(factory);
  return { service, from, rpc, rpcCalls, upsertPayloads };
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

describe('PayrollStateRulesService', () => {
  it('an absent row reads as false (epoch timestamp)', async () => {
    const t = build({ existingRow: null });
    const view = await t.service.read(companyAdmin);
    expect(view).toMatchObject({ notified: false });
    expect(view.updatedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('a real change persists, stamps updated_at, and audits', async () => {
    const t = build({
      existingRow: {
        tenant_id: 'tenant-A',
        notified: false,
        updated_at: '2026-11-17T00:00:00Z',
      },
      upsertResult: {
        tenant_id: 'tenant-A',
        notified: true,
        updated_at: '2026-11-17T09:00:00Z',
      },
    });
    const view = await t.service.save(companyAdmin, true);
    expect(view).toMatchObject({ notified: true });
    expect(t.upsertPayloads[0]).toMatchObject({
      tenant_id: 'tenant-A',
      notified: true,
    });
    expect(typeof t.upsertPayloads[0]['updated_at']).toBe('string');
    expect(t.rpcCalls[0]['p_action']).toBe('payroll.state_rules_updated');
  });

  it('an identical re-save writes nothing and audits nothing', async () => {
    const t = build({
      existingRow: {
        tenant_id: 'tenant-A',
        notified: true,
        updated_at: '2026-11-17T00:00:00Z',
      },
    });
    const view = await t.service.save(companyAdmin, true);
    expect(view.notified).toBe(true);
    expect(t.upsertPayloads).toHaveLength(0);
    expect(t.rpcCalls).toHaveLength(0);
  });

  it('saving false with no row stores nothing — false is what absence already means', async () => {
    const t = build({ existingRow: null });
    const view = await t.service.save(companyAdmin, false);
    expect(view).toMatchObject({
      notified: false,
      updatedAt: '1970-01-01T00:00:00.000Z',
    });
    expect(t.upsertPayloads).toHaveLength(0);
    expect(t.rpcCalls).toHaveLength(0);
  });

  it('a read failure is a 500 without DB text', async () => {
    const t = build({ readError: { code: 'XX000', message: 'boom' } });
    const err = await httpError(t.service.read(companyAdmin));
    expect(err.status).toBe(500);
    expect(String(err.body['message'])).not.toContain('boom');
  });

  it('a failed existence probe on save is a 500, never a silent no-op bypass', async () => {
    const t = build({ readError: { code: 'XX000', message: 'boom' } });
    const err = await httpError(t.service.save(companyAdmin, true));
    expect(err.status).toBe(500);
    expect(String(err.body['message'])).not.toContain('boom');
    expect(t.upsertPayloads).toHaveLength(0);
    expect(t.rpcCalls).toHaveLength(0);
  });

  it('a write failure is a 500 without DB text', async () => {
    const t = build({
      existingRow: {
        tenant_id: 'tenant-A',
        notified: false,
        updated_at: '2026-11-17T00:00:00Z',
      },
      upsertError: { code: '23514', message: 'boom' },
    });
    const err = await httpError(t.service.save(companyAdmin, true));
    expect(err.status).toBe(500);
    expect(String(err.body['message'])).not.toContain('boom');
  });

  it('a caller with no company is a 400 before any query', async () => {
    const t = build();
    const err = await httpError(
      t.service.read({ ...companyAdmin, tenantId: null }),
    );
    expect(err.status).toBe(400);
    expect(t.from).not.toHaveBeenCalled();
  });

  it('an audit rpc rejection never undoes the save', async () => {
    const t = build({
      upsertResult: {
        tenant_id: 'tenant-A',
        notified: true,
        updated_at: '2026-11-17T09:00:00Z',
      },
      rpcRejects: new Error('network down'),
    });
    const view = await t.service.save(companyAdmin, true);
    expect(view.notified).toBe(true);
  });

  it('an audit rpc that resolves with an error still returns the save', async () => {
    const t = build({
      upsertResult: {
        tenant_id: 'tenant-A',
        notified: true,
        updated_at: '2026-11-17T09:00:00Z',
      },
    });
    t.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'rls' },
    });
    const view = await t.service.save(companyAdmin, true);
    expect(view.notified).toBe(true);
  });
});
