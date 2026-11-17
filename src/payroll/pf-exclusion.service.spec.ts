import { HttpException } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { PayrollPfExclusionService } from './pf-exclusion.service';

/**
 * The never-member rule: an employee carrying a UAN or PF account number
 * can never be excluded (ever-members are covered at any wage). Absence
 * means false — saving false with no row stores nothing (the state-rules
 * lesson), and an identical re-save writes nothing.
 */
function build(
  opts: {
    membership?: Record<string, unknown> | null;
    membershipError?: { code?: string; message: string } | null;
    existingRow?: Record<string, unknown> | null;
    existingError?: { code?: string; message: string } | null;
    saveResult?: Record<string, unknown> | null;
    saveError?: { code?: string; message: string } | null;
    rpcRejects?: unknown;
  } = {},
) {
  const upsertPayloads: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<Record<string, unknown>> = [];

  const mkBuilder = (table: string) => {
    const b: Record<string, unknown> = {};
    let upsertPayload: Record<string, unknown> | undefined;
    for (const name of ['eq', 'select']) {
      b[name] = jest.fn(() => b);
    }
    b['maybeSingle'] = jest.fn(() => b);
    b['single'] = jest.fn(() => b);
    b['upsert'] = jest.fn((payload: Record<string, unknown>) => {
      upsertPayload = payload;
      upsertPayloads.push(payload);
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
      if (table === 'memberships') {
        resolve({
          data: opts.membershipError ? null : (opts.membership ?? null),
          error: opts.membershipError ?? null,
        });
        return;
      }
      // payroll_pf_exclusions — the existing-row probe
      resolve({
        data: opts.existingRow ?? null,
        error: opts.existingError ?? null,
      });
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
  const service = new PayrollPfExclusionService(factory);
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

const TARGET = '11111111-1111-4111-8111-111111111111';

const neverMember = {
  id: 'mem-1',
  uan_number: null,
  pf_account_number: null,
};

describe('PayrollPfExclusionService — the never-member rule', () => {
  it('an ever-member (UAN populated) is refused exclusion with the rule named', async () => {
    const t = build({
      membership: { ...neverMember, uan_number: '101234567890' },
    });
    const err = await httpError(
      t.service.save(companyAdmin, TARGET, { excluded: true }),
    );
    expect(err.status).toBe(422);
    expect(String(err.body['message'])).toContain('never a member');
    expect(t.upsertPayloads).toHaveLength(0);
    expect(t.rpcCalls).toHaveLength(0);
  });

  it('an ever-member via PF account number is refused too', async () => {
    const t = build({
      membership: { ...neverMember, pf_account_number: 'PY/ABC/12345/000' },
    });
    const err = await httpError(
      t.service.save(companyAdmin, TARGET, { excluded: true }),
    );
    expect(err.status).toBe(422);
    expect(t.upsertPayloads).toHaveLength(0);
  });

  it('a never-member exclusion persists and audits with the member as target', async () => {
    const t = build({
      membership: neverMember,
      saveResult: { excluded: true, updated_at: '2026-11-17T09:00:00Z' },
    });
    const view = await t.service.save(companyAdmin, TARGET, { excluded: true });
    expect(view.excluded).toBe(true);
    expect(t.upsertPayloads[0]).toMatchObject({
      tenant_id: 'tenant-A',
      membership_id: 'mem-1',
      excluded: true,
    });
    expect(t.rpcCalls[0]['p_action']).toBe('payroll.pf_exclusion_set');
    expect(t.rpcCalls[0]['p_target_user']).toBe(TARGET);
  });

  it('saving false with no row stores nothing — false is what absence means', async () => {
    const t = build({ membership: neverMember, existingRow: null });
    const view = await t.service.save(companyAdmin, TARGET, {
      excluded: false,
    });
    expect(view).toMatchObject({
      excluded: false,
      updatedAt: '1970-01-01T00:00:00.000Z',
    });
    expect(t.upsertPayloads).toHaveLength(0);
    expect(t.rpcCalls).toHaveLength(0);
  });

  it('an identical re-save writes nothing and audits nothing', async () => {
    const t = build({
      membership: neverMember,
      existingRow: { excluded: true, updated_at: '2026-11-17T00:00:00Z' },
    });
    const view = await t.service.save(companyAdmin, TARGET, { excluded: true });
    expect(view.updatedAt).toBe('2026-11-17T00:00:00Z');
    expect(t.upsertPayloads).toHaveLength(0);
    expect(t.rpcCalls).toHaveLength(0);
  });

  it('clearing an exclusion writes false and audits', async () => {
    const t = build({
      membership: neverMember,
      existingRow: { excluded: true, updated_at: '2026-11-17T00:00:00Z' },
      saveResult: { excluded: false, updated_at: '2026-11-17T09:00:00Z' },
    });
    const view = await t.service.save(companyAdmin, TARGET, {
      excluded: false,
    });
    expect(view.excluded).toBe(false);
    expect(t.upsertPayloads[0]['excluded']).toBe(false);
    expect(t.rpcCalls).toHaveLength(1);
  });

  it('a save write failure is a 500 without DB text', async () => {
    const t = build({
      membership: neverMember,
      saveError: { code: '23514', message: 'boom' },
    });
    const err = await httpError(
      t.service.save(companyAdmin, TARGET, { excluded: true }),
    );
    expect(err.status).toBe(500);
    expect(String(err.body['message'])).not.toContain('boom');
  });

  it('a failed exclusion probe is a 500, never a silent no-op bypass', async () => {
    const t = build({
      membership: neverMember,
      existingError: { code: 'XX000', message: 'boom' },
    });
    const err = await httpError(
      t.service.save(companyAdmin, TARGET, { excluded: true }),
    );
    expect(err.status).toBe(500);
    expect(String(err.body['message'])).not.toContain('boom');
    expect(t.upsertPayloads).toHaveLength(0);
    expect(t.rpcCalls).toHaveLength(0);
  });

  it('an unknown member is a 404 before anything else', async () => {
    const t = build({ membership: null });
    const err = await httpError(t.service.read(companyAdmin, TARGET));
    expect(err.status).toBe(404);
    expect(t.upsertPayloads).toHaveLength(0);
  });

  it('an absent exclusion row reads as false with the epoch timestamp', async () => {
    const t = build({ membership: neverMember, existingRow: null });
    const view = await t.service.read(companyAdmin, TARGET);
    expect(view).toMatchObject({
      excluded: false,
      updatedAt: '1970-01-01T00:00:00.000Z',
    });
  });

  it('an audit rpc rejection never undoes the save', async () => {
    const t = build({
      membership: neverMember,
      saveResult: { excluded: true, updated_at: '2026-11-17T09:00:00Z' },
      rpcRejects: new Error('down'),
    });
    const view = await t.service.save(companyAdmin, TARGET, { excluded: true });
    expect(view.excluded).toBe(true);
  });

  it('a caller with no company is a 400 before any query', async () => {
    const t = build();
    const err = await httpError(
      t.service.read({ ...companyAdmin, tenantId: null }, TARGET),
    );
    expect(err.status).toBe(400);
    expect(t.from).not.toHaveBeenCalled();
  });
});
