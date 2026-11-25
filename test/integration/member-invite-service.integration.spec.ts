/**
 * Invite EMP-code collision real-DB probe (prod incident 2026-11-25).
 *
 * Drives the SHIPPED AuthService.inviteMember — the TypeScript rewrite of the
 * invite_member PL/pgSQL function (pgPool.withTransaction, the setActive
 * pattern) — against a REAL database. The unit/e2e specs pin the decisions on
 * fakes; this proves the SQL behind them: the drifted-counter step-over mint,
 * the typed duplicate refusals, the removed-membership reactivation and the
 * serialized concurrent mints, with real constraints, real savepoints and the
 * real set_employee_code trigger in the loop.
 *
 * Requires real credentials: gated on DATABASE_URL being set and not the
 * jest.env.setup.ts dummy (15-7 harness convention). Fixtures are
 * self-contained (throwaway tenant keyed by unique probe phones) and removed
 * in afterAll.
 */
import { Pool } from 'pg';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PgPoolFactory } from '../../src/common/pg/pg-pool.factory';
import { SupabaseClientFactory } from '../../src/common/factories/supabase-client.factory';
import { OtpSessionStore } from '../../src/auth/otp-session-store';
import { SmsDeliveryProvider } from '../../src/auth/sms-delivery.provider';
import { InviteSmsService } from '../../src/auth/invite-sms/invite-sms.service';
import { AuthService } from '../../src/auth/auth.service';
import { ErrorCode } from '../../src/common/enums/error-code.enum';
import { Role } from '../../src/common/enums/role.enum';
import type { RequestUser } from '../../src/common/interfaces/request-user.interface';

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const SUPABASE_URL = process.env['SUPABASE_URL'] ?? '';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const IS_REAL_DB =
  DATABASE_URL !== '' &&
  !DATABASE_URL.includes('test:test') &&
  SUPABASE_URL !== '' &&
  !SUPABASE_URL.includes('test.supabase.co');

const TENANT = randomUUID();
const TENANT_B = randomUUID();
const OWNER = randomUUID();
/** Holds hand-set EMP-002 (active) — the same-team duplicate target. */
const HAND1 = randomUUID();
/** Holds hand-set EMP-003 (active) — the second drifted code. */
const HAND2 = randomUUID();
/** Holds EMP-009 with a removed membership — the reactivation target. */
const REMOVED = randomUUID();
/** Active in TENANT_B — the "belongs to another company" duplicate target. */
const ELSEWHERE = randomUUID();

const P_OWNER = '9399990201';
const P_HAND1 = '9399990202';
const P_HAND2 = '9399990203';
const P_REMOVED = '9399990204';
const P_ELSEWHERE = '9399990205';
/** Fresh numbers the invites create; from the dedicated test block. */
const P_FRESH_A = '9399990211';
const P_FRESH_B = '9399990212';
const P_FRESH_C = '9399990213';

describe('AuthService.inviteMember (real DB — the EMP-code collision rewrite)', () => {
  const maybeIt = IS_REAL_DB ? it : it.skip;
  beforeEach(() => {
    auditAdmin.rpc.mockClear();
  });
  let pool: Pool;
  let admin: SupabaseClient;
  let service: AuthService;
  /**
   * The service's admin client is used for two REST calls: skills-catalog
   * validation (not exercised here — every probe invite carries no skills)
   * and the post-commit audit rpc. The audit MUST be stubbed: audit_log is
   * append-only (a before-delete trigger stops even postgres), so a real
   * audit row would permanently pin the probe users and tenants against
   * cleanup. The call shape it would make is asserted below and pinned in
   * the unit suite.
   */
  const auditAdmin = {
    rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
  };

  const must = <T>(res: {
    data: T | null;
    error: { message: string } | null;
  }): T => {
    if (res.error) {
      throw new Error(`fixture insert failed: ${res.error.message}`);
    }
    return res.data as T;
  };

  const caller: RequestUser = {
    userId: OWNER,
    tenantId: TENANT,
    role: Role.COMPANY_ADMIN,
    platformAdmin: false,
    rawJwt: 'probe',
  };

  const invite = (phoneNumber: string) =>
    service.inviteMember(caller, {
      countryCode: '+91',
      phoneNumber,
      name: 'invite-svc probe member',
    });

  const counterFor = async (tenantId: string): Promise<number> => {
    const r = await pool.query(
      'select last_seq from public.employee_sequences where tenant_id = $1',
      [tenantId],
    );
    return r.rows[0]?.last_seq ?? 0;
  };

  /** Deletes everything a probe run left behind, keyed on the probe users'
   *  ids, then the tenants reachable from their memberships/creations. Runs
   *  through the pg pool — postgres deletes there and pool errors throw,
   *  unlike supabase-js where a failed delete resolves silently and would
   *  poison the next run's fixtures. Order matters: invite_sms_audit
   *  restricts the membership deletes behind it. (No audit_log handling: the
   *  probe world never writes audit rows — see the auditAdmin stub — and the
   *  table is append-only by design anyway.) */
  const purgeProbeRows = async (userIds: string[]): Promise<void> => {
    if (userIds.length === 0) return;
    const tenants = (
      await pool.query(
        `select distinct tenant_id from (
           select tenant_id from public.memberships where user_id = any($1::uuid[])
           union select id from public.tenants where created_by = any($1::uuid[])
         ) t where tenant_id is not null`,
        [userIds],
      )
    ).rows.map((r: { tenant_id: string }) => r.tenant_id);
    await pool.query(
      'delete from public.invite_sms_audit where tenant_id = any($1::uuid[])',
      [tenants],
    );
    await pool.query(
      'delete from public.memberships where tenant_id = any($1::uuid[])',
      [tenants],
    );
    await pool.query(
      'delete from public.employee_sequences where tenant_id = any($1::uuid[])',
      [tenants],
    );
    await pool.query(
      'delete from public.tenants where id = any($1::uuid[])',
      [tenants],
    );
    await pool.query(
      'delete from public.users where id = any($1::uuid[])',
      [userIds],
    );
  };

  /** The probe world's users, by the name prefix every fixture user and
   *  every invited member carries — covers an aborted run's leftovers too
   *  (jest may die before afterAll ever fires). */
  const probeUserIds = async (): Promise<string[]> =>
    (
      await pool.query(
        "select id from public.users where name like 'invite-svc probe%'",
      )
    ).rows.map((r: { id: string }) => r.id);

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
    admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const servicePool = new PgPoolFactory({
      getOrThrow: (key: string) => {
        if (key === 'DATABASE_URL') return DATABASE_URL;
        throw new Error(`Unexpected config key ${key}`);
      },
    } as unknown as ConfigService);
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: OtpSessionStore,
          useValue: {
            set: jest.fn(),
            get: jest.fn(),
            delete: jest.fn(),
            increment: jest.fn(),
          },
        },
        { provide: SmsDeliveryProvider, useValue: { send: jest.fn() } },
        {
          provide: SupabaseClientFactory,
          useValue: { create: jest.fn(), createAdmin: () => auditAdmin },
        },
        { provide: JwtService, useValue: { signAsync: jest.fn() } },
        {
          provide: InviteSmsService,
          useValue: { sendInviteSms: jest.fn().mockResolvedValue('not_configured') },
        },
        { provide: PgPoolFactory, useValue: servicePool },
      ],
    }).compile();
    service = moduleRef.get(AuthService);

    // Pre-clean leftovers from an aborted earlier run (same probe names).
    await purgeProbeRows(await probeUserIds());

    // Identity first, then the companies, then who belongs where.
    must(
      await admin.from('users').insert([
        {
          id: OWNER,
          country_code: '+91',
          phone_number: P_OWNER,
          name: 'invite-svc probe owner',
        },
        {
          id: HAND1,
          country_code: '+91',
          phone_number: P_HAND1,
          name: 'invite-svc probe hand1',
        },
        {
          id: HAND2,
          country_code: '+91',
          phone_number: P_HAND2,
          name: 'invite-svc probe hand2',
        },
        {
          id: REMOVED,
          country_code: '+91',
          phone_number: P_REMOVED,
          name: 'invite-svc probe removed',
        },
        {
          id: ELSEWHERE,
          country_code: '+91',
          phone_number: P_ELSEWHERE,
          name: 'invite-svc probe elsewhere',
        },
      ]),
    );
    must(
      await admin.from('tenants').insert([
        {
          id: TENANT,
          created_by: OWNER,
          company_name: 'invite-svc probe',
          state_code: 'KA',
        },
        {
          id: TENANT_B,
          created_by: OWNER,
          company_name: 'invite-svc probe B',
          state_code: 'KA',
        },
      ]),
    );
    must(
      await admin.from('memberships').insert([
        {
          user_id: OWNER,
          tenant_id: TENANT,
          role: 'company_admin',
          status: 'active',
          employee_code: 'EMP-001',
        },
        // The drift, as it shipped: hand-set codes ABOVE the counter — the
        // counter never saw them, exactly the QA-fixture/CAP-13 pattern.
        {
          user_id: HAND1,
          tenant_id: TENANT,
          role: 'employee',
          status: 'active',
          employee_code: 'EMP-002',
        },
        {
          user_id: HAND2,
          tenant_id: TENANT,
          role: 'employee',
          status: 'active',
          employee_code: 'EMP-003',
        },
        {
          user_id: REMOVED,
          tenant_id: TENANT,
          role: 'employee',
          status: 'removed',
          employee_code: 'EMP-009',
        },
        {
          user_id: ELSEWHERE,
          tenant_id: TENANT_B,
          role: 'employee',
          status: 'active',
          employee_code: 'EMP-001',
        },
      ]),
    );
    // Explicit codes above no-op the set_employee_code trigger, so the
    // counter row does not exist yet — insert the DRIFTED value directly.
    must(
      await pool.query(
        `insert into public.employee_sequences (tenant_id, last_seq)
         values ($1, 1), ($2, 1)`,
        [TENANT, TENANT_B],
      ),
    );
  });

  afterAll(async () => {
    if (!IS_REAL_DB) return;
    await purgeProbeRows(await probeUserIds());
    await pool.end();
  });

  // THE INCIDENT, AS A REAL QUERY: counter at 1, codes EMP-002/EMP-003 already
  // hand-set. The old function minted EMP-002, crashed on the unique
  // constraint, and the API blamed the phone number — forever. The mint loop
  // steps over the taken codes and lands on the first FREE one.
  maybeIt('mints the next FREE code, stepping over the drifted hand-set codes', async () => {
    const result = await invite(P_FRESH_A);

    expect(result.employee_code).toBe('EMP-004');
    const freshId = (
      await admin.from('users').select('id').eq('phone_number', P_FRESH_A)
    ).data?.[0]?.id as string;
    const { data: rows } = await admin
      .from('memberships')
      .select('status, employee_code')
      .eq('tenant_id', TENANT)
      .eq('user_id', freshId);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toEqual({ status: 'invited', employee_code: 'EMP-004' });
    // The counter healed itself to the minted code in the same transaction.
    expect(await counterFor(TENANT)).toBe(4);
    // The post-commit audit call carried the minted code (stubbed — see the
    // auditAdmin note; audit_log itself is append-only).
    expect(auditAdmin.rpc).toHaveBeenCalledWith(
      'write_audit_row',
      expect.objectContaining({
        p_action: 'member.invite',
        p_tenant_id: TENANT,
        p_target_user: freshId,
        p_details: {
          role: 'employee',
          reactivated: false,
          employee_code: 'EMP-004',
        },
      }),
    );
  });

  maybeIt('refuses a same-team member with the typed 409, touching no counter', async () => {
    await expect(invite(P_HAND1)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        error_code: ErrorCode.ALREADY_IN_TEAM,
      }),
    });
    expect(await counterFor(TENANT)).toBe(4);
  });

  maybeIt('refuses a person who belongs to another company with the typed 409', async () => {
    await expect(invite(P_ELSEWHERE)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        error_code: ErrorCode.DUPLICATE_RESOURCE,
      }),
    });
    expect(await counterFor(TENANT)).toBe(4);
  });

  maybeIt('reactivates a removed membership: same code kept, counter untouched', async () => {
    const result = await invite(P_REMOVED);

    expect(result.employee_code).toBe('EMP-009');
    const removedId = (
      await admin.from('users').select('id').eq('phone_number', P_REMOVED)
    ).data?.[0]?.id as string;
    const { data: rows } = await admin
      .from('memberships')
      .select('status, employee_code, role')
      .eq('tenant_id', TENANT)
      .eq('user_id', removedId);
    expect(rows).toEqual([
      { status: 'invited', employee_code: 'EMP-009', role: 'employee' },
    ]);
    // The reactivation path skips the mint entirely — no counter burn.
    expect(await counterFor(TENANT)).toBe(4);
  });

  // Two invites for two fresh numbers run concurrently; the counter upsert's
  // row lock (and the tenant advisory lock) must hand out distinct codes with
  // no unique-violation retry visible from the outside.
  maybeIt('hands distinct codes to two concurrent fresh invites', async () => {
    const [a, b] = await Promise.all([invite(P_FRESH_B), invite(P_FRESH_C)]);

    const nums = [a.employee_code, b.employee_code].map((c) =>
      Number(c.replace(/\D/g, '')),
    );
    expect(new Set(nums).size).toBe(2);
    expect(nums.sort((x, y) => x - y)).toEqual([5, 6]);
    expect(await counterFor(TENANT)).toBe(6);
    const { count } = await admin
      .from('memberships')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', TENANT);
    // owner + hand1 + hand2 + reactivated removed + fresh A + fresh B + fresh C.
    expect(count).toBe(7);
  });
});
