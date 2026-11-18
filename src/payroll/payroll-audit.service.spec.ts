import { HttpException } from '@nestjs/common';
import { SupabaseClientFactory } from '../common/factories/supabase-client.factory';
import { RequestUser } from '../common/interfaces/request-user.interface';
import { Role } from '../common/enums/role.enum';
import { PayrollAuditService } from './payroll-audit.service';

/**
 * The audit read is one guarded query over audit_log. The stand-in records
 * the query chain so the spec pins the tenant filter, the `payroll.%` action
 * scope, the newest-first order and the 100 cap — the trail's contract —
 * plus the row→view mapping (a null details jsonb reads as an empty object).
 */
function build(
  opts: {
    rows?: Array<Record<string, unknown>>;
    error?: { message: string } | null;
  } = {},
) {
  const calls: Array<[string, ...unknown[]]> = [];
  const b: Record<string, unknown> = {};
  for (const name of ['eq', 'like', 'order', 'limit', 'select']) {
    b[name] = jest.fn((...args: unknown[]) => {
      calls.push([name, ...args]);
      return b;
    });
  }
  b['then'] = (resolve: (v: unknown) => void) => {
    resolve({ data: opts.rows ?? [], error: opts.error ?? null });
  };
  const from = jest.fn(() => b);
  const factory = {
    createAdmin: jest.fn(() => ({ from })),
  } as unknown as jest.Mocked<SupabaseClientFactory>;
  return { service: new PayrollAuditService(factory), from, calls };
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

describe('PayrollAuditService — the trail read (CAP-11)', () => {
  it('reads the tenant’s payroll actions, newest first, capped at 100', async () => {
    const t = build({
      rows: [
        {
          id: 'a1',
          created_at: '2026-11-18T10:00:00Z',
          actor_user_id: 'admin-1',
          action: 'payroll.month_locked',
          target_user_id: null,
          details: { month: '2026-10' },
        },
        {
          id: 'a0',
          created_at: '2026-11-17T09:00:00Z',
          actor_user_id: 'admin-1',
          action: 'payroll.structure_saved',
          target_user_id: 'emp-1',
          details: null,
        },
      ],
    });
    const view = await t.service.list(companyAdmin);
    expect(t.from).toHaveBeenCalledWith('audit_log');
    const byName = Object.fromEntries(t.calls.map((c) => [c[0], c.slice(1)]));
    expect(byName['eq']).toEqual(['tenant_id', 'tenant-A']);
    expect(byName['like']).toEqual(['action', 'payroll.%']);
    // Newest first, with the id tiebreaker the plan's idiom names — equal
    // timestamps keep a deterministic order.
    const orders = t.calls.filter((c) => c[0] === 'order');
    expect(orders.map((c) => c.slice(1))).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(byName['limit']).toEqual([100]);
    // Mapped: snake_case → view, a null details reads as an empty object.
    expect(view[0]).toEqual({
      id: 'a1',
      createdAt: '2026-11-18T10:00:00Z',
      actorId: 'admin-1',
      action: 'payroll.month_locked',
      targetUserId: null,
      details: { month: '2026-10' },
    });
    expect(view[1].details).toEqual({});
    expect(view[1].targetUserId).toBe('emp-1');
  });

  it('a read failure is the 500, never a silent empty trail', async () => {
    const t = build({ error: { message: 'boom' } });
    const err = await httpError(t.service.list(companyAdmin));
    expect(err.status).toBe(500);
  });

  it('no company on the token is the 400 setup answer', async () => {
    const t = build();
    const err = await httpError(
      t.service.list({ ...companyAdmin, tenantId: null }),
    );
    expect(err.status).toBe(400);
    expect(t.from).not.toHaveBeenCalled();
  });
});
