import { HttpException } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import {
  employeePfCovered,
  PayrollPfConfigService,
  resolvePfCovered,
} from './pf-config.service';

/**
 * The PF-covered switch: calendar idiom (same-date replace, identical
 * no-op, audit), month-start resolution with absent rows meaning OFF, and
 * the covered decision's truth table — an ever-member is covered regardless
 * of everything; a never-member follows the switch unless excluded.
 */
function build(
  opts: {
    listRows?: Array<Record<string, unknown>>;
    listError?: { code?: string; message: string } | null;
    existingRow?: Record<string, unknown> | null;
    existingError?: { code?: string; message: string } | null;
    saveResult?: Record<string, unknown> | null;
    saveError?: { code?: string; message: string } | null;
    rpcRejects?: unknown;
  } = {},
) {
  const upsertPayloads: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<Record<string, unknown>> = [];

  const mkBuilder = () => {
    const b: Record<string, unknown> = {};
    let upsertPayload: Record<string, unknown> | undefined;
    const ordered = false;
    for (const name of ['eq', 'order']) {
      b[name] = jest.fn(() => b);
    }
    b['select'] = jest.fn(() => b);
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
  const service = new PayrollPfConfigService(factory);
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

describe('PayrollPfConfigService', () => {
  it('saves a covered-on revision, normalises nothing, audits', async () => {
    const t = build({
      saveResult: {
        effective_from: '2026-09-01',
        covered: true,
        updated_at: '2026-11-17T09:00:00Z',
      },
    });
    const view = await t.service.save(companyAdmin, {
      effectiveFrom: '2026-09-01',
      covered: true,
    });
    expect(view).toMatchObject({ effectiveFrom: '2026-09-01', covered: true });
    expect(t.upsertPayloads[0]).toMatchObject({
      tenant_id: 'tenant-A',
      effective_from: '2026-09-01',
      covered: true,
    });
    expect(t.rpcCalls[0]['p_action']).toBe('payroll.pf_config_saved');
  });

  it('an identical re-save writes nothing and audits nothing', async () => {
    const t = build({
      existingRow: {
        effective_from: '2026-09-01',
        covered: true,
        updated_at: '2026-11-17T00:00:00Z',
      },
    });
    const view = await t.service.save(companyAdmin, {
      effectiveFrom: '2026-09-01',
      covered: true,
    });
    expect(view.updatedAt).toBe('2026-11-17T00:00:00Z');
    expect(t.upsertPayloads).toHaveLength(0);
    expect(t.rpcCalls).toHaveLength(0);
  });

  it('a changed same-date save replaces the switch and audits', async () => {
    const t = build({
      existingRow: {
        effective_from: '2026-09-01',
        covered: true,
        updated_at: '2026-11-17T00:00:00Z',
      },
      saveResult: {
        effective_from: '2026-09-01',
        covered: false,
        updated_at: '2026-11-17T09:00:00Z',
      },
    });
    const view = await t.service.save(companyAdmin, {
      effectiveFrom: '2026-09-01',
      covered: false,
    });
    expect(view.covered).toBe(false);
    expect(t.upsertPayloads).toHaveLength(1);
    expect(t.upsertPayloads[0]['covered']).toBe(false);
    expect(t.rpcCalls[0]['p_details']).toMatchObject({
      previous: { covered: true },
    });
  });

  it('a save write failure is a 500 without DB text', async () => {
    const t = build({ saveError: { code: '23514', message: 'boom' } });
    const err = await httpError(
      t.service.save(companyAdmin, {
        effectiveFrom: '2026-09-01',
        covered: true,
      }),
    );
    expect(err.status).toBe(500);
    expect(String(err.body['message'])).not.toContain('boom');
  });

  it('a failed existence probe is a 500, never a silent no-op bypass', async () => {
    const t = build({ existingError: { code: 'XX000', message: 'boom' } });
    const err = await httpError(
      t.service.save(companyAdmin, {
        effectiveFrom: '2026-09-01',
        covered: true,
      }),
    );
    expect(err.status).toBe(500);
    expect(String(err.body['message'])).not.toContain('boom');
    expect(t.upsertPayloads).toHaveLength(0);
    expect(t.rpcCalls).toHaveLength(0);
  });

  it('an audit rpc rejection never undoes the save', async () => {
    const t = build({
      saveResult: {
        effective_from: '2026-09-01',
        covered: true,
        updated_at: '2026-11-17T09:00:00Z',
      },
      rpcRejects: new Error('down'),
    });
    const view = await t.service.save(companyAdmin, {
      effectiveFrom: '2026-09-01',
      covered: true,
    });
    expect(view.covered).toBe(true);
  });

  it('a caller with no company is a 400 before any query', async () => {
    const t = build();
    const err = await httpError(
      t.service.list({ ...companyAdmin, tenantId: null }),
    );
    expect(err.status).toBe(400);
    expect(t.from).not.toHaveBeenCalled();
  });
});

describe('resolvePfCovered — month-start resolution', () => {
  const rows = [
    { effectiveFrom: '2026-09-01', covered: true },
    { effectiveFrom: '2026-12-01', covered: false },
  ];

  it('absent rows mean the switch is off', () => {
    expect(resolvePfCovered([], '2026-10')).toBe(false);
  });

  it('a covered-on row governs from its month', () => {
    expect(resolvePfCovered(rows, '2026-09')).toBe(true);
    expect(resolvePfCovered(rows, '2026-11')).toBe(true);
  });

  it('a mid-month-dated revision is invisible to its own month', () => {
    const mid = [{ effectiveFrom: '2026-09-20', covered: true }];
    expect(resolvePfCovered(mid, '2026-09')).toBe(false);
    expect(resolvePfCovered(mid, '2026-10')).toBe(true);
  });

  it('a later switch-off row governs its months (an unlocked re-run of an earlier month still resolves covered)', () => {
    expect(resolvePfCovered(rows, '2026-12')).toBe(false);
    // September's re-run resolves September's rows, not today's switch.
    expect(resolvePfCovered(rows, '2026-09')).toBe(true);
  });

  it('a malformed month is refused loudly, never lexically mis-resolved', () => {
    expect(() => resolvePfCovered(rows, '2026-9')).toThrow('YYYY-MM');
  });
});

describe('employeePfCovered — the covered decision (CAP-6 truth table)', () => {
  it.each([
    { everMember: true, switchCovered: false, excluded: false, want: true },
    { everMember: true, switchCovered: false, excluded: true, want: true },
    { everMember: true, switchCovered: true, excluded: true, want: true },
    { everMember: false, switchCovered: true, excluded: false, want: true },
    { everMember: false, switchCovered: true, excluded: true, want: false },
    { everMember: false, switchCovered: false, excluded: false, want: false },
    { everMember: false, switchCovered: false, excluded: true, want: false },
    { everMember: true, switchCovered: true, excluded: false, want: true },
  ])(
    'ever=%p switch=%p excluded=%p → %p',
    ({ everMember, switchCovered, excluded, want }) => {
      expect(employeePfCovered({ everMember, switchCovered, excluded })).toBe(
        want,
      );
    },
  );
});
