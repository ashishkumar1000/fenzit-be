import { ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../src/common/validation-pipe-options';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { Pool } from 'pg';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { accessToken } from './helpers/auth-test-utils';
import { purgeCompanyChildren } from './helpers/attendance-company-fixture';
import { deleteAuditRows } from './helpers/rls-seed';

/**
 * The payroll module's real-DB JOURNEY suite, opened by story 23-1 (CAP-13,
 * employment data for payroll). The standing rule holds: each step is ONE real
 * API call + the database as referee. Later payroll stories append their legs
 * here in epic order.
 *
 * The tenant is seeded from canonical-fixture.md — Employee A's Form V fields
 * verbatim (code EMP-001, Field Technician, Field Operations, DOB 1995-04-12,
 * father Ramesh Sharma, PAN ABCPE1234F, UAN 101234567890, PF PY/ABC/12345/000,
 * bank account 1234567890, IFSC HDFC0001234, HDFC Bank, joined 2026-09-01).
 * The fixture's money rows arrive with the salary-structure stories.
 *
 * Requires real credentials (DATABASE_URL / SUPABASE_URL + service key, NOT
 * the jest.env.setup.ts dummies) — skipped otherwise. Throwaway tenants per
 * run, removed in cleanup() in FK-safe order.
 */

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const SUPABASE_URL = process.env['SUPABASE_URL'] ?? '';
const SUPABASE_SERVICE_KEY =
  process.env['SUPABASE_SERVICE_ROLE_KEY'] ??
  process.env['SUPABASE_SERVICE_KEY'] ??
  '';
const IS_REAL_DB =
  DATABASE_URL.includes('@') &&
  SUPABASE_URL.startsWith('https://') &&
  !SUPABASE_URL.startsWith('https://test.supabase.co') &&
  SUPABASE_SERVICE_KEY !== '';

jest.setTimeout(120_000);

const TZ = 'Asia/Kolkata';

/** Employee A (canonical fixture), verbatim — the payload the full save PATCHes. */
const EMPLOYEE_A_FORM_V = {
  employeeCode: 'EMP-001',
  joinDate: '2026-09-01',
  pan: 'ABCPE1234F',
  dateOfBirth: '1995-04-12',
  fatherName: 'Ramesh Sharma',
  pfAccountNumber: 'PY/ABC/12345/000',
  uanNumber: '101234567890',
  designation: 'Field Technician',
  department: 'Field Operations',
  bankAccountNumber: '1234567890',
  ifscCode: 'HDFC0001234',
  bankName: 'HDFC Bank',
};

/** Employee A as the memberships row must hold it after the full save. */
const EMPLOYEE_A_ROW = {
  employee_code: 'EMP-001',
  join_date: '2026-09-01',
  exit_date: null,
  pan: 'ABCPE1234F',
  date_of_birth: '1995-04-12',
  father_name: 'Ramesh Sharma',
  mother_name: null,
  spouse_name: null,
  pf_account_number: 'PY/ABC/12345/000',
  uan_number: '101234567890',
  designation: 'Field Technician',
  department: 'Field Operations',
  bank_account_number: '1234567890',
  ifsc_code: 'HDFC0001234',
  bank_name: 'HDFC Bank',
};

/** Unwrap a MUST-succeed supabase call. */
function must<T>(res: {
  data: T | null;
  error: { message: string } | null;
}): T {
  if (res.error) throw new Error(`fixture failed: ${res.error.message}`);
  return res.data as T;
}

describe('Payroll journey (real DB, real routes)', () => {
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let pool: Pool;
  let admin: SupabaseClient<any, any, 'public', any, any>;

  const tenant = randomUUID();
  const otherTenant = randomUUID();
  const owner = randomUUID();
  const employeeA = randomUUID();
  const memberC = randomUUID(); // removed by a leg; its exit is owner-fixable
  const memberD = randomUUID(); // remove audit predates the join — the clamp
  const memberE = randomUUID(); // remove audit after the join — the clean case
  const otherOwner = randomUUID();
  const platformAdmin = randomUUID(); // staff, no membership anywhere

  const crew = [
    owner,
    employeeA,
    memberC,
    memberD,
    memberE,
    otherOwner,
    platformAdmin,
  ];
  const phones = Array.from({ length: crew.length }, (_, i) =>
    `7${Date.now()}${i}`.slice(-12).replace(/[^0-9]/g, ''),
  );

  const bearerFor = (userId: string): string => accessToken(jwt, userId);
  const employmentUrl = (userId: string) =>
    `/api/v1/members/${userId}/employment`;
  // The bearer is minted per call: the JwtService only exists after beforeAll.
  const ownerHeaders = () => ({ authorization: `Bearer ${bearerFor(owner)}` });

  /** The employment columns of one membership row, straight from the DB. */
  async function employmentRowOf(
    userId: string,
    tenantId = tenant,
  ): Promise<Record<string, unknown>> {
    const { rows } = await pool.query<Record<string, unknown>>(
      `select employee_code, join_date::text as join_date, exit_date::text as exit_date,
              pan, date_of_birth::text as date_of_birth,
              father_name, mother_name, spouse_name,
              pf_account_number, uan_number, designation, department,
              bank_account_number, ifsc_code, bank_name
         from public.memberships
        where tenant_id = $1 and user_id = $2`,
      [tenantId, userId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(
        `employment row missing for user ${userId} in tenant ${tenantId}`,
      );
    }
    return row;
  }

  async function auditEmploymentCount(targetUserId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.audit_log
        where tenant_id = $1 and action = 'member.employment_update'
          and target_user_id = $2`,
      [tenant, targetUserId],
    );
    return rows[0].n;
  }

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
    admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    jwt = moduleFixture.get(JwtService);

    must(
      await admin.from('users').insert(
        crew.map((id, i) => ({
          id,
          country_code: '+91',
          phone_number: phones[i],
          name: `payroll journey ${i}`,
          platform_admin: id === platformAdmin,
        })),
      ),
    );
    must(
      await admin.from('tenants').insert([
        {
          id: tenant,
          created_by: owner,
          company_name: `payroll journey ${tenant.slice(0, 8)}`,
          state_code: 'KA',
          timezone: TZ,
        },
        {
          id: otherTenant,
          created_by: otherOwner,
          company_name: `payroll stranger ${otherTenant.slice(0, 8)}`,
          state_code: 'KA',
          timezone: TZ,
        },
      ]),
    );
    // Codes are explicit so Employee A carries the fixture's EMP-001; the
    // insert trigger keeps a caller-supplied code untouched.
    must(
      await admin.from('memberships').insert([
        {
          user_id: employeeA,
          tenant_id: tenant,
          role: 'employee',
          status: 'active',
          employee_code: 'EMP-001',
        },
        {
          user_id: owner,
          tenant_id: tenant,
          role: 'company_admin',
          status: 'active',
          employee_code: 'EMP-002',
        },
        {
          user_id: memberC,
          tenant_id: tenant,
          role: 'employee',
          status: 'active',
          employee_code: 'EMP-003',
        },
        {
          user_id: otherOwner,
          tenant_id: otherTenant,
          role: 'company_admin',
          status: 'active',
          employee_code: 'EMP-001',
        },
      ]),
    );
  });

  afterAll(async () => {
    if (!IS_REAL_DB) return;
    await app.close();
    // The audit rows go first (append-only, so with the trigger off for one
    // transaction — rls-seed's idiom): they RESTRICT both tenants and users.
    await deleteAuditRows([tenant, otherTenant], crew);
    await purgeCompanyChildren(pool, [tenant, otherTenant]);
    const tenants = await admin
      .from('tenants')
      .delete()
      .in('id', [tenant, otherTenant]);
    if (tenants.error) {
      throw new Error(`tenants leak: ${tenants.error.message}`);
    }
    const del = await admin.from('users').delete().in('id', crew);
    if (del.error) throw new Error(`users leak: ${del.error.message}`);
    await pool.end();
  });

  maybeIt(
    '23-1 — the full Form V save persists every column, round-trips, and audits exactly once',
    async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: employmentUrl(employeeA),
        headers: ownerHeaders(),
        payload: EMPLOYEE_A_FORM_V,
      });
      expect(res.statusCode).toBe(200);

      // GET round-trips every field the fixture names.
      const read = await app.inject({
        method: 'GET',
        url: employmentUrl(employeeA),
        headers: ownerHeaders(),
      });
      expect(read.statusCode).toBe(200);
      expect(JSON.parse(read.body)).toMatchObject(EMPLOYEE_A_FORM_V);

      // The DB referee reads every column — mother/spouse never seeded, stay null.
      expect(await employmentRowOf(employeeA)).toMatchObject(EMPLOYEE_A_ROW);

      // One change, exactly one audit row — and an identical repeat save adds none.
      expect(await auditEmploymentCount(employeeA)).toBe(1);
      const repeat = await app.inject({
        method: 'PATCH',
        url: employmentUrl(employeeA),
        headers: ownerHeaders(),
        payload: EMPLOYEE_A_FORM_V,
      });
      expect(repeat.statusCode).toBe(200);
      expect(await auditEmploymentCount(employeeA)).toBe(1);
    },
  );

  maybeIt(
    '23-1 — an exit before the join is refused in plain English',
    async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: employmentUrl(employeeA),
        headers: ownerHeaders(),
        payload: { exitDate: '2026-08-31' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain('before');
      expect(await employmentRowOf(employeeA)).toMatchObject(EMPLOYEE_A_ROW);
    },
  );

  maybeIt(
    '23-1 — a malformed PAN and a malformed IFSC are refused',
    async () => {
      const pan = await app.inject({
        method: 'PATCH',
        url: employmentUrl(employeeA),
        headers: ownerHeaders(),
        payload: { pan: '12bcd345g' },
      });
      expect(pan.statusCode).toBe(422);
      expect(pan.body).toContain('pan');

      const ifsc = await app.inject({
        method: 'PATCH',
        url: employmentUrl(employeeA),
        headers: ownerHeaders(),
        payload: { ifscCode: 'HDFC12XY34' },
      });
      expect(ifsc.statusCode).toBe(422);
      expect(ifsc.body).toContain('ifscCode');
    },
  );

  maybeIt(
    '23-1 — another company admin gets 404 for our member, never the record',
    async () => {
      const res = await app.inject({
        method: 'GET',
        url: employmentUrl(employeeA),
        headers: { authorization: `Bearer ${bearerFor(otherOwner)}` },
      });
      expect(res.statusCode).toBe(404);
      expect((JSON.parse(res.body) as { error_code: string }).error_code).toBe(
        'RESOURCE_NOT_FOUND',
      );
    },
  );

  maybeIt(
    '23-1 — clearing the join date is allowed: the run skip path stays real',
    async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: employmentUrl(employeeA),
        headers: ownerHeaders(),
        payload: { joinDate: null },
      });
      expect(res.statusCode).toBe(200);
      expect((await employmentRowOf(employeeA))['join_date']).toBeNull();
    },
  );

  maybeIt(
    '23-1 — an exit without a join is refused, also when the join is cleared in the same request',
    async () => {
      // The join is null after the previous leg: an exit alone has nothing to end.
      const alone = await app.inject({
        method: 'PATCH',
        url: employmentUrl(employeeA),
        headers: ownerHeaders(),
        payload: { exitDate: '2026-10-10' },
      });
      expect(alone.statusCode).toBe(422);
      expect(alone.body).toContain('joining date');

      // Judged on the state AFTER the save: clearing the join while setting the
      // exit in one PATCH is the same refusal, not a loophole.
      const sameRequest = await app.inject({
        method: 'PATCH',
        url: employmentUrl(employeeA),
        headers: ownerHeaders(),
        payload: { joinDate: null, exitDate: '2026-10-10' },
      });
      expect(sameRequest.statusCode).toBe(422);
      expect((await employmentRowOf(employeeA))['exit_date']).toBeNull();

      // Restore the fixture state for the legs below.
      const restore = await app.inject({
        method: 'PATCH',
        url: employmentUrl(employeeA),
        headers: ownerHeaders(),
        payload: { joinDate: EMPLOYEE_A_FORM_V.joinDate },
      });
      expect(restore.statusCode).toBe(200);
    },
  );

  maybeIt(
    '23-1 — the employee code is permanent: clearing it is refused',
    async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: employmentUrl(employeeA),
        headers: ownerHeaders(),
        payload: { employeeCode: null },
      });
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain('permanent');
      expect((await employmentRowOf(employeeA))['employee_code']).toBe(
        'EMP-001',
      );
    },
  );

  maybeIt(
    '23-1 — an invented calendar date is refused (a real parse, not a regex)',
    async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: employmentUrl(employeeA),
        headers: ownerHeaders(),
        payload: { joinDate: '2026-02-30' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain('joinDate');
    },
  );

  maybeIt(
    '23-1 — an employee code another member already wears is a 409 naming it',
    async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: employmentUrl(employeeA),
        headers: ownerHeaders(),
        payload: { employeeCode: 'EMP-003' },
      });
      expect(res.statusCode).toBe(409);
      expect((JSON.parse(res.body) as { error_code: string }).error_code).toBe(
        'DUPLICATE_RESOURCE',
      );
      expect(res.body).toContain('EMP-003');
      expect((await employmentRowOf(employeeA))['employee_code']).toBe(
        'EMP-001',
      );
    },
  );

  maybeIt(
    "23-1 — the migration file's own backfill clamps, never inverts (replayed verbatim, rolled back)",
    async () => {
      // Two removed members in the world the backfill expects (rows start
      // exit-NULL, like every membership before the migration ran): D's
      // remove audit predates its join (unclampable — must stay NULL, never
      // inverted); E's follows it (must land).
      must(
        await admin.from('memberships').insert([
          {
            user_id: memberD,
            tenant_id: tenant,
            role: 'employee',
            status: 'removed',
            employee_code: 'EMP-004',
            created_at: '2026-09-01T04:30:00Z', // 09:30 IST on 2026-09-01
          },
          {
            user_id: memberE,
            tenant_id: tenant,
            role: 'employee',
            status: 'removed',
            employee_code: 'EMP-005',
            created_at: '2026-09-01T04:30:00Z',
          },
        ]),
      );
      must(
        await admin.from('audit_log').insert([
          {
            actor_user_id: owner,
            actor_is_platform_admin: false,
            tenant_id: tenant,
            action: 'member.remove',
            target_user_id: memberD,
            created_at: '2026-08-25T04:30:00Z', // BEFORE the join — the clamp case
            details: {},
          },
          {
            actor_user_id: owner,
            actor_is_platform_admin: false,
            tenant_id: tenant,
            action: 'member.remove',
            target_user_id: memberE,
            created_at: '2026-09-10T04:30:00Z', // after the join — the clean case
            details: {},
          },
        ]),
      );

      // The migration FILE is the oracle, not a hand copy: pull its two
      // backfill UPDATEs out verbatim, so editing the backfill breaks this
      // leg. They run UNSCOPED inside a transaction that always rolls back,
      // so the shared database is untouched; the leg runs before any other
      // leg sets an API exit, which is exactly the all-exit-NULL world the
      // migration itself ran in (a replay among API-set exits would trip the
      // exit >= join CHECK on those rows).
      const migrationSql = readFileSync(
        resolve(
          __dirname,
          '../supabase/migrations/20261117100000_membership_employment_data.sql',
        ),
        'utf8',
      );
      const backfillUpdates = migrationSql
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .split(';')
        .filter((chunk) => /update public\.memberships/.test(chunk));
      expect(backfillUpdates).toHaveLength(2);

      const client = await pool.connect();
      try {
        await client.query('begin');
        for (const statement of backfillUpdates) {
          await client.query(statement);
        }
        const clamped = await client.query<{
          join_date: string | null;
          exit_date: string | null;
        }>(
          `select join_date::text as join_date, exit_date::text as exit_date
             from public.memberships
            where tenant_id = $1 and user_id = $2`,
          [tenant, memberD],
        );
        expect(clamped.rows[0]).toMatchObject({
          join_date: '2026-09-01',
          exit_date: null, // dropped — never stored inverted
        });
        const clean = await client.query<{
          join_date: string | null;
          exit_date: string | null;
        }>(
          `select join_date::text as join_date, exit_date::text as exit_date
             from public.memberships
            where tenant_id = $1 and user_id = $2`,
          [tenant, memberE],
        );
        expect(clean.rows[0]).toMatchObject({
          join_date: '2026-09-01',
          exit_date: '2026-09-10',
        });
        await client.query('rollback');
      } catch (e) {
        await client.query('rollback').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
  );

  maybeIt(
    '23-1 — a removed membership stays editable: the owner fixes its exit date',
    async () => {
      // The remove flow's DB facts: status flip + the member.remove audit row.
      must(
        await admin
          .from('memberships')
          .update({ status: 'removed' })
          .eq('user_id', memberC)
          .eq('tenant_id', tenant),
      );
      must(
        await admin.from('audit_log').insert({
          actor_user_id: owner,
          actor_is_platform_admin: false,
          tenant_id: tenant,
          action: 'member.remove',
          target_user_id: memberC,
          details: { old_role: 'employee', old_status: 'active' },
        }),
      );

      // C joined backfill-free (suite rows carry no join), so the fix is one
      // save of both dates: the window 2026-09-01 → 2026-10-10.
      const res = await app.inject({
        method: 'PATCH',
        url: employmentUrl(memberC),
        headers: ownerHeaders(),
        payload: { joinDate: '2026-09-01', exitDate: '2026-10-10' },
      });
      expect(res.statusCode).toBe(200);
      const row = await employmentRowOf(memberC);
      expect(row['join_date']).toBe('2026-09-01');
      expect(row['exit_date']).toBe('2026-10-10');
    },
  );

  maybeIt(
    '23-1 — an employee token is forbidden on the employment record',
    async () => {
      const employeeHeaders = {
        authorization: `Bearer ${bearerFor(employeeA)}`,
      };
      const read = await app.inject({
        method: 'GET',
        url: employmentUrl(employeeA),
        headers: employeeHeaders,
      });
      expect(read.statusCode).toBe(403);

      const write = await app.inject({
        method: 'PATCH',
        url: employmentUrl(employeeA),
        headers: employeeHeaders,
        payload: { designation: 'Senior Technician' },
      });
      expect(write.statusCode).toBe(403);
      expect((await employmentRowOf(employeeA))['designation']).toBe(
        'Field Technician',
      );
    },
  );

  maybeIt(
    '23-1 — the new fields never reach the member list or /me',
    async () => {
      // Key-aware, not substring: "company_admin" contains "pan", and a raw
      // body grep would cry wolf. Every key of every nested object is checked.
      const BANNED_KEYS = [
        'pan',
        'joinDate',
        'exitDate',
        'dateOfBirth',
        'fatherName',
        'motherName',
        'spouseName',
        'pfAccountNumber',
        'uanNumber',
        'designation',
        'department',
        'bankAccountNumber',
        'ifscCode',
        'bankName',
      ];
      const keysOf = (
        value: unknown,
        seen = new Set<string>(),
      ): Set<string> => {
        if (Array.isArray(value)) {
          for (const item of value) keysOf(item, seen);
        } else if (value !== null && typeof value === 'object') {
          for (const [k, v] of Object.entries(value)) {
            seen.add(k);
            keysOf(v, seen);
          }
        }
        return seen;
      };

      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/members',
        headers: ownerHeaders(),
      });
      expect(list.statusCode).toBe(200);
      expect([...keysOf(JSON.parse(list.body))]).toEqual(
        expect.not.arrayContaining(BANNED_KEYS),
      );
      expect(list.body).not.toContain('ABCPE1234F');

      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: { authorization: `Bearer ${bearerFor(employeeA)}` },
      });
      expect(me.statusCode).toBe(200);
      expect([...keysOf(JSON.parse(me.body))]).toEqual(
        expect.not.arrayContaining(BANNED_KEYS),
      );
      expect(me.body).not.toContain('ABCPE1234F');
      expect(me.body).not.toContain('101234567890');
      expect(me.body).not.toContain('Ramesh Sharma');
    },
  );

  // ------------------------------------------------------------- 23-2 legs
  // The leave-type catalog (CAP-12): config CRUD + the typing the payroll
  // run's LOP read will join on. The JOIN under test mirrors the day-status
  // grid reader exactly: leave_request_days ⋈ leave_requests (approved
  // states) ⋈ leave_types for the paid marking.

  const casualLeave: { id: string } = { id: '' };
  const unpaidLeave: { id: string } = { id: '' };

  /** Catalog rows of the throwaway tenant, by name. */
  async function leaveTypeRowByName(
    name: string,
  ): Promise<Record<string, unknown>> {
    const { rows } = await pool.query<{
      id: string;
      name: string;
      paid: boolean;
    }>(
      `select id::text, name, paid
         from public.leave_types
        where tenant_id = $1 and name = $2`,
      [tenant, name],
    );
    if (!rows[0]) {
      throw new Error(`leave type "${name}" missing in tenant ${tenant}`);
    }
    return rows[0];
  }

  /**
   * The JOIN shape the payroll run mirrors (grid-reader.ts): day rows in the
   * approved states ⋈ their request ⋈ the type's paid flag — with NULL
   * reading as paid (`coalesce`), which is the run's contract for untyped
   * requests. The raw link itself is asserted separately by leaveTypingOf.
   */
  async function typedLeaveJoin(
    employeeId: string,
    states: string[] = ['approved'],
  ): Promise<Array<{ leave_date: string; paid: boolean }>> {
    const { rows } = await pool.query<{
      leave_date: string;
      paid: boolean;
    }>(
      `select d.leave_date::text as leave_date, coalesce(t.paid, true) as paid
         from public.leave_request_days d
         join public.leave_requests r on r.id = d.leave_request_id
         left join public.leave_types t on t.id = r.leave_type_id
        where r.tenant_id = $1 and d.employee_id = $2
          and d.state = any($3::text[])
        order by d.leave_date`,
      [tenant, employeeId, states],
    );
    return rows;
  }

  /** A request's typing link, straight from the row. */
  async function leaveTypingOf(
    requestId: string,
  ): Promise<{ leave_type_id: string | null; paid: boolean | null }> {
    const { rows } = await pool.query<{
      leave_type_id: string | null;
      paid: boolean | null;
    }>(
      `select r.leave_type_id::text as leave_type_id, t.paid
         from public.leave_requests r
         left join public.leave_types t on t.id = r.leave_type_id
        where r.tenant_id = $1 and r.id = $2`,
      [tenant, requestId],
    );
    if (!rows[0]) {
      throw new Error(`leave request ${requestId} missing in tenant ${tenant}`);
    }
    return rows[0];
  }

  /** Seed one request + its day rows directly (the admin-client idiom). */
  async function seedLeaveRequest(input: {
    dates: string[];
    state: 'pending' | 'approved';
    leaveTypeId?: string | null;
    employeeId?: string;
  }): Promise<string> {
    const employeeId = input.employeeId ?? employeeA;
    const created = must(
      (await admin
        .from('leave_requests')
        .insert({
          tenant_id: tenant,
          employee_id: employeeId,
          request_id: randomUUID(),
          start_date: input.dates[0],
          end_date: input.dates[input.dates.length - 1],
          part: 'full_day',
          reason: 'journey leave',
          created_by: owner,
          leave_type_id: input.leaveTypeId ?? null,
        })
        .select('id')
        .single()) as {
        data: { id: string } | null;
        error: { message: string } | null;
      },
    ).id;
    must(
      (await admin.from('leave_request_days').insert(
        input.dates.map((d) => ({
          tenant_id: tenant,
          leave_request_id: created,
          employee_id: employeeId,
          leave_date: d,
          state: input.state,
        })),
      )) as { data: unknown; error: { message: string } | null },
    );
    return created;
  }

  maybeIt(
    '23-2 — the owner creates the catalog: keyword defaults apply and say so',
    async () => {
      const casual = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/leave/types',
        headers: ownerHeaders(),
        payload: { name: 'Casual Leave' },
      });
      expect(casual.statusCode).toBe(201);
      const casualBody = JSON.parse(casual.body) as {
        id: string;
        paid: boolean;
        appliedDefault?: string;
      };
      expect(casualBody.paid).toBe(true);
      expect(casualBody.appliedDefault).toBe('paid');
      casualLeave.id = casualBody.id;

      const unpaid = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/leave/types',
        headers: ownerHeaders(),
        payload: { name: 'Unpaid Leave' },
      });
      expect(unpaid.statusCode).toBe(201);
      const unpaidBody = JSON.parse(unpaid.body) as {
        id: string;
        paid: boolean;
        appliedDefault?: string;
      };
      expect(unpaidBody.paid).toBe(false);
      expect(unpaidBody.appliedDefault).toBe('unpaid');
      unpaidLeave.id = unpaidBody.id;

      expect(await leaveTypeRowByName('Casual Leave')).toMatchObject({
        paid: true,
      });
      expect(await leaveTypeRowByName('Unpaid Leave')).toMatchObject({
        paid: false,
      });
    },
  );

  maybeIt(
    '23-2 — a duplicate catalog name is a 409 naming it; the catalog does not grow',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/leave/types',
        headers: ownerHeaders(),
        payload: { name: 'Casual Leave' },
      });
      expect(res.statusCode).toBe(409);
      expect((JSON.parse(res.body) as { error_code: string }).error_code).toBe(
        'DUPLICATE_RESOURCE',
      );
      expect(res.body).toContain('Casual Leave');
      const { rows } = await pool.query<{ n: number }>(
        'select count(*)::int as n from public.leave_types where tenant_id = $1',
        [tenant],
      );
      expect(rows[0].n).toBe(2);
    },
  );

  maybeIt(
    '23-2 — typing an approved leave writes the link and the run JOIN reads it',
    async () => {
      // Oct 13-15 — the canonical fixture's unpaid-leave dates.
      const requestId = await seedLeaveRequest({
        dates: ['2026-10-13', '2026-10-14', '2026-10-15'],
        state: 'approved',
      });

      // Untyped first: NULL reads paid, so the JOIN shows paid even before typing.
      const before = await typedLeaveJoin(employeeA);
      expect(before.map((r) => r.leave_date)).toEqual([
        '2026-10-13',
        '2026-10-14',
        '2026-10-15',
      ]);
      expect(before.every((r) => r.paid === true)).toBe(true);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/attendance/leave/${requestId}/type`,
        headers: ownerHeaders(),
        payload: { leaveTypeId: casualLeave.id },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        requestId,
        leaveTypeId: casualLeave.id,
        paid: true,
      });
      const typing = await leaveTypingOf(requestId);
      expect(typing.leave_type_id).toBe(casualLeave.id);

      const join = await typedLeaveJoin(employeeA);
      expect(join).toHaveLength(3);
      expect(join.every((r) => r.paid === true)).toBe(true);
    },
  );

  maybeIt(
    '23-2 — reclassifying a type flips what the run JOIN reads (mutable config, no snapshot)',
    async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/attendance/leave/types/${casualLeave.id}`,
        headers: ownerHeaders(),
        payload: { paid: false },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ paid: false });

      const join = await typedLeaveJoin(employeeA);
      expect(join).toHaveLength(3);
      expect(join.every((r) => r.paid === false)).toBe(true);
    },
  );

  maybeIt(
    '23-2 — rejected day rows drop out of the approved-only JOIN',
    async () => {
      // A typed PENDING request (Oct 20-21, typed at insert): the approved-only
      // JOIN must not read it yet.
      const pendingId = await seedLeaveRequest({
        dates: ['2026-10-20', '2026-10-21'],
        state: 'pending',
        leaveTypeId: unpaidLeave.id,
      });
      expect(await typedLeaveJoin(employeeA)).toHaveLength(3); // Oct 13-15 only

      // The rejection is seeded at SQL level (bypassing the API — the
      // owner-reject route is Epic 17's own suite): the day rows flip
      // pending → rejected, the legal transition, while the request row
      // itself stays pending. What this leg exercises is the JOIN, not the
      // reject endpoint.
      const { rowCount } = await pool.query(
        `update public.leave_request_days
            set state = 'rejected'
          where leave_request_id = $1 and state = 'pending'`,
        [pendingId],
      );
      expect(rowCount).toBe(2);

      // Rejected (and any non-approved state) never reaches the LOP join.
      const join = await typedLeaveJoin(employeeA);
      expect(join).toHaveLength(3);
      const rejected = await typedLeaveJoin(employeeA, [
        'pending',
        'approved',
        'rejected',
        'cancelled',
        'revoked',
      ]);
      expect(rejected.map((r) => r.leave_date)).toEqual([
        '2026-10-13',
        '2026-10-14',
        '2026-10-15',
        '2026-10-20',
        '2026-10-21',
      ]);
    },
  );

  maybeIt(
    '23-2 — a type referenced by leave requests cannot be deleted',
    async () => {
      // A SECOND request referencing the type: the in-use probe must stay
      // multi-row-safe (limit(1)), not a single-row read that would error
      // the moment a second reference exists.
      await seedLeaveRequest({
        dates: ['2026-10-06', '2026-10-07'],
        state: 'approved',
        leaveTypeId: unpaidLeave.id,
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/attendance/leave/types/${unpaidLeave.id}`,
        headers: ownerHeaders(),
      });
      expect(res.statusCode).toBe(409);
      expect((JSON.parse(res.body) as { error_code: string }).error_code).toBe(
        'LEAVE_TYPE_IN_USE',
      );
      expect(await leaveTypeRowByName('Unpaid Leave')).toMatchObject({
        paid: false,
      });
    },
  );

  maybeIt(
    '23-2 — an employee token is 403 on the catalog, and apply names an unknown type 404 without leaving a request',
    async () => {
      const employeeHeaders = () => ({
        authorization: `Bearer ${bearerFor(employeeA)}`,
      });
      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/leave/types',
        headers: employeeHeaders(),
      });
      expect(list.statusCode).toBe(403);

      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/v1/attendance/leave/types/${casualLeave.id}`,
        headers: employeeHeaders(),
        payload: { paid: true },
      });
      expect(patch.statusCode).toBe(403);

      const applyRequestId = randomUUID();
      const apply = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/me/leave',
        headers: {
          ...employeeHeaders(),
          'x-idempotency-key': applyRequestId,
        },
        payload: {
          startDate: '2026-11-20',
          endDate: '2026-11-20',
          reason: 'journey apply',
          leaveTypeId: randomUUID(), // no such type in this company
        },
      });
      expect(apply.statusCode).toBe(404);
      expect(
        (JSON.parse(apply.body) as { error_code: string }).error_code,
      ).toBe('RESOURCE_NOT_FOUND');

      const { rows } = await pool.query<{ n: number }>(
        'select count(*)::int as n from public.leave_requests where tenant_id = $1 and request_id = $2',
        [tenant, applyRequestId],
      );
      expect(rows[0].n).toBe(0); // the refused apply left nothing behind
    },
  );
  // ------------------------------------------------------------- 23-3 legs
  // The component library and per-employee salary structures (CAP-1, CAP-2).
  // Component ids are captured from the API answers; every structure line
  // references them, mirroring how the run engine will resolve config.

  const basicComp: { id: string } = { id: '' };
  const hraComp: { id: string } = { id: '' };
  const specialComp: { id: string } = { id: '' };
  const unusedComp: { id: string } = { id: '' };

  const structuresUrl = (userId: string) =>
    `/api/v1/members/${userId}/salary-structures`;
  const componentsUrl = '/api/v1/payroll/components';

  /** The employee's stored structure rows, straight from the DB. */
  async function structureRowsOf(
    userId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query<{
      effective_from: string;
      lines: unknown;
      created_at: Date;
    }>(
      `select s.effective_from::text as effective_from, s.lines, s.created_at
         from public.salary_structures s
         join public.memberships m on m.id = s.membership_id
        where s.tenant_id = $1 and m.user_id = $2
        order by s.effective_from`,
      [tenant, userId],
    );
    return rows;
  }

  async function structureAuditCount(targetUserId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.audit_log
        where tenant_id = $1 and action = 'payroll.structure_saved'
          and target_user_id = $2`,
      [tenant, targetUserId],
    );
    return rows[0].n;
  }

  maybeIt(
    '23-3 — the owner builds the fixture library: Basic designated, HRA beside it',
    async () => {
      const basic = await app.inject({
        method: 'POST',
        url: componentsUrl,
        headers: ownerHeaders(),
        payload: { name: 'Basic', isBasic: true },
      });
      expect(basic.statusCode).toBe(201);
      const basicBody = JSON.parse(basic.body) as {
        id: string;
        isBasic: boolean;
      };
      expect(basicBody.isBasic).toBe(true);
      basicComp.id = basicBody.id;

      const hra = await app.inject({
        method: 'POST',
        url: componentsUrl,
        headers: ownerHeaders(),
        payload: { name: 'HRA' },
      });
      expect(hra.statusCode).toBe(201);
      const hraBody = JSON.parse(hra.body) as { id: string; isBasic: boolean };
      expect(hraBody.isBasic).toBe(false);
      hraComp.id = hraBody.id;

      const { rows } = await pool.query(
        `select name, is_basic, active from public.salary_components
          where tenant_id = $1 order by name`,
        [tenant],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        name: 'Basic',
        is_basic: true,
        active: true,
      });
      expect(rows[1]).toMatchObject({
        name: 'HRA',
        is_basic: false,
        active: true,
      });
    },
  );

  maybeIt(
    '23-3 — exactly one basic: a second designation is refused naming the current one',
    async () => {
      const second = await app.inject({
        method: 'POST',
        url: componentsUrl,
        headers: ownerHeaders(),
        payload: { name: 'Other', isBasic: true },
      });
      expect(second.statusCode).toBe(409);
      expect(
        (JSON.parse(second.body) as { error_code: string }).error_code,
      ).toBe('BASIC_COMPONENT_EXISTS');
      expect(
        (JSON.parse(second.body) as { message: string }).message,
      ).toContain('"Basic"');

      const { rows } = await pool.query<{ n: number }>(
        'select count(*)::int as n from public.salary_components where tenant_id = $1',
        [tenant],
      );
      expect(rows[0].n).toBe(2); // the refused create left nothing behind
    },
  );

  maybeIt(
    '23-3 — variant A: basic 20,000 + HRA 40% saves with computed 8,000.00, and an identical re-save touches nothing',
    async () => {
      const lines = [
        { componentId: basicComp.id, amount: '20000.00' },
        {
          componentId: hraComp.id,
          formula: {
            kind: 'percent-of',
            percent: 40,
            of: { kind: 'component', componentId: basicComp.id },
          },
        },
      ];
      const res = await app.inject({
        method: 'PUT',
        url: structuresUrl(employeeA),
        headers: ownerHeaders(),
        payload: { effectiveFrom: '2026-09-01', lines },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        effectiveFrom: string;
        lines: Array<{ componentName: string; computedAmount?: string }>;
      };
      expect(body.effectiveFrom).toBe('2026-09-01');
      expect(body.lines.map((l) => l.computedAmount)).toEqual([
        '20000.00',
        '8000.00',
      ]);
      expect(body.lines.map((l) => l.componentName)).toEqual(['Basic', 'HRA']);

      const rows = await structureRowsOf(employeeA);
      expect(rows).toHaveLength(1);
      const stored = rows[0]['lines'] as Array<Record<string, unknown>>;
      expect(stored[0]).toEqual({
        componentId: basicComp.id,
        amount: '20000.00',
      });
      expect(stored[1]['componentId']).toBe(hraComp.id);
      expect(stored[1]['formula']).toMatchObject({
        kind: 'percent-of',
        percent: 40,
      });

      // The identical re-save: still one row, one audit entry, row untouched.
      const repeat = await app.inject({
        method: 'PUT',
        url: structuresUrl(employeeA),
        headers: ownerHeaders(),
        payload: { effectiveFrom: '2026-09-01', lines },
      });
      expect(repeat.statusCode).toBe(200);
      expect(await structureRowsOf(employeeA)).toHaveLength(1);
      expect(await structureAuditCount(employeeA)).toBe(1);
      expect(String((await structureRowsOf(employeeA))[0]['created_at'])).toBe(
        String(rows[0]['created_at']),
      );
    },
  );

  maybeIt(
    '23-3 — a structure without the basic component is refused in plain English',
    async () => {
      const res = await app.inject({
        method: 'PUT',
        url: structuresUrl(employeeA),
        headers: ownerHeaders(),
        payload: {
          effectiveFrom: '2026-09-01',
          lines: [
            {
              componentId: hraComp.id,
              formula: {
                kind: 'percent-of',
                percent: 40,
                of: { kind: 'component', componentId: basicComp.id },
              },
            },
          ],
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain('basic');
      expect(await structureRowsOf(employeeA)).toHaveLength(1);
    },
  );

  maybeIt(
    '23-3 — an invented calendar date is refused (a real parse, not a regex)',
    async () => {
      const res = await app.inject({
        method: 'PUT',
        url: structuresUrl(employeeA),
        headers: ownerHeaders(),
        payload: {
          effectiveFrom: '2026-02-30',
          lines: [{ componentId: basicComp.id, amount: '20000.00' }],
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain('effectiveFrom');
    },
  );

  maybeIt(
    '23-3 — a formula cycle is refused naming the chain; the last valid save survives the failed edit',
    async () => {
      const special = await app.inject({
        method: 'POST',
        url: componentsUrl,
        headers: ownerHeaders(),
        payload: { name: 'Special' },
      });
      expect(special.statusCode).toBe(201);
      specialComp.id = (JSON.parse(special.body) as { id: string }).id;

      // A valid three-line set first: Special is a flat amount. Dated
      // December so the fixture months (September = variant A, later
      // November) stay untouched by this leg's config.
      const valid = await app.inject({
        method: 'PUT',
        url: structuresUrl(employeeA),
        headers: ownerHeaders(),
        payload: {
          effectiveFrom: '2026-12-01',
          lines: [
            { componentId: basicComp.id, amount: '20000.00' },
            {
              componentId: hraComp.id,
              formula: {
                kind: 'percent-of',
                percent: 40,
                of: { kind: 'component', componentId: basicComp.id },
              },
            },
            { componentId: specialComp.id, amount: '5000.00' },
          ],
        },
      });
      expect(valid.statusCode).toBe(200);

      // The edit that would close the loop: HRA from Special, Special from
      // HRA. The whole set is re-checked and the chain is named.
      const cycle = await app.inject({
        method: 'PUT',
        url: structuresUrl(employeeA),
        headers: ownerHeaders(),
        payload: {
          effectiveFrom: '2026-12-01',
          lines: [
            { componentId: basicComp.id, amount: '20000.00' },
            {
              componentId: hraComp.id,
              formula: {
                kind: 'percent-of',
                percent: 40,
                of: { kind: 'component', componentId: specialComp.id },
              },
            },
            {
              componentId: specialComp.id,
              formula: { kind: 'component', componentId: hraComp.id },
            },
          ],
        },
      });
      expect(cycle.statusCode).toBe(422);
      expect((JSON.parse(cycle.body) as { message: string }).message).toContain(
        '"HRA" → "Special" → "HRA"',
      );

      // The failed edit left the last valid save standing (the September
      // fixture row plus this leg's December revision — nothing else).
      const rows = await structureRowsOf(employeeA);
      expect(rows.map((r) => r['effective_from'])).toEqual([
        '2026-09-01',
        '2026-12-01',
      ]);
      const stored = rows[1]['lines'] as Array<Record<string, unknown>>;
      expect(stored[2]).toEqual({
        componentId: specialComp.id,
        amount: '5000.00',
      });

      // A CHANGED same-date save replaces the dated row in place: still one
      // December row, and the service stamped updated_at (no trigger exists).
      const changed = await app.inject({
        method: 'PUT',
        url: structuresUrl(employeeA),
        headers: ownerHeaders(),
        payload: {
          effectiveFrom: '2026-12-01',
          lines: [
            { componentId: basicComp.id, amount: '20000.00' },
            {
              componentId: hraComp.id,
              formula: {
                kind: 'percent-of',
                percent: 40,
                of: { kind: 'component', componentId: basicComp.id },
              },
            },
            { componentId: specialComp.id, amount: '6000.00' },
          ],
        },
      });
      expect(changed.statusCode).toBe(200);
      expect(
        (
          JSON.parse(changed.body) as {
            lines: Array<{ computedAmount?: string }>;
          }
        ).lines[2].computedAmount,
      ).toBe('6000.00');
      const afterChange = await structureRowsOf(employeeA);
      expect(afterChange.map((r) => r['effective_from'])).toEqual([
        '2026-09-01',
        '2026-12-01',
      ]);
      const decRow = afterChange[1] as unknown as {
        created_at: string;
        updated_at: string;
      };
      expect(decRow.updated_at).not.toBe(decRow.created_at);
      const changedStored = afterChange[1]['lines'] as Array<
        Record<string, unknown>
      >;
      expect(changedStored[2]).toEqual({
        componentId: specialComp.id,
        amount: '6000.00',
      });
      // Three real changes: the Sep save, the Dec create, the Dec replace.
      expect(await structureAuditCount(employeeA)).toBe(3);
    },
  );

  maybeIt(
    '23-3 — division by a zero amount and a negative formula are refused',
    async () => {
      const zero = await app.inject({
        method: 'POST',
        url: componentsUrl,
        headers: ownerHeaders(),
        payload: { name: 'Zero Rate' },
      });
      expect(zero.statusCode).toBe(201);
      const zeroId = (JSON.parse(zero.body) as { id: string }).id;

      const divByZero = await app.inject({
        method: 'PUT',
        url: structuresUrl(employeeA),
        headers: ownerHeaders(),
        payload: {
          effectiveFrom: '2026-09-01',
          lines: [
            { componentId: basicComp.id, amount: '20000.00' },
            { componentId: zeroId, amount: '0.00' },
            {
              componentId: hraComp.id,
              formula: {
                kind: 'binary',
                op: '/',
                left: { kind: 'const', value: 100 },
                right: { kind: 'component', componentId: zeroId },
              },
            },
          ],
        },
      });
      expect(divByZero.statusCode).toBe(422);
      expect(divByZero.body).toContain('divides by zero');

      const negative = await app.inject({
        method: 'PUT',
        url: structuresUrl(employeeA),
        headers: ownerHeaders(),
        payload: {
          effectiveFrom: '2026-09-01',
          lines: [
            { componentId: basicComp.id, amount: '20000.00' },
            {
              componentId: hraComp.id,
              formula: {
                kind: 'binary',
                op: '-',
                left: { kind: 'component', componentId: basicComp.id },
                right: { kind: 'const', value: 25000 },
              },
            },
          ],
        },
      });
      expect(negative.statusCode).toBe(422);
      expect(negative.body).toContain('negative');

      // Neither refusal left a row: the September fixture row and the
      // December revision stand, nothing else.
      expect(await structureRowsOf(employeeA)).toHaveLength(2);
    },
  );

  maybeIt(
    '23-3 — variant F: the 2026-11-01 revision coexists with 2026-09-01 (both rows, both readable)',
    async () => {
      const res = await app.inject({
        method: 'PUT',
        url: structuresUrl(employeeA),
        headers: ownerHeaders(),
        payload: {
          effectiveFrom: '2026-11-01',
          lines: [
            { componentId: basicComp.id, amount: '22000.00' },
            {
              componentId: hraComp.id,
              formula: {
                kind: 'percent-of',
                percent: 40,
                of: { kind: 'component', componentId: basicComp.id },
              },
            },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        lines: Array<{ computedAmount?: string }>;
      };
      expect(body.lines.map((l) => l.computedAmount)).toEqual([
        '22000.00',
        '8800.00',
      ]);

      const read = await app.inject({
        method: 'GET',
        url: structuresUrl(employeeA),
        headers: ownerHeaders(),
      });
      expect(read.statusCode).toBe(200);
      const revisions = JSON.parse(read.body) as Array<{
        effectiveFrom: string;
        lines: Array<{ computedAmount?: string }>;
      }>;
      expect(revisions.map((r) => r.effectiveFrom)).toEqual([
        '2026-09-01',
        '2026-11-01',
        '2026-12-01',
      ]);
      // September's revision still answers its own numbers (the whole-month
      // rule's anchor): the run resolves per month from these rows.
      expect(revisions[0].lines.map((l) => l.computedAmount)).toEqual([
        '20000.00',
        '8000.00',
      ]);
      expect(await structureRowsOf(employeeA)).toHaveLength(3);
    },
  );

  maybeIt(
    '23-3 — renames reach the read at once; deactivation is refused listing the employee; an unused component retires',
    async () => {
      const rename = await app.inject({
        method: 'PATCH',
        url: `${componentsUrl}/${hraComp.id}`,
        headers: ownerHeaders(),
        payload: { name: 'House Rent' },
      });
      expect(rename.statusCode).toBe(200);
      expect((JSON.parse(rename.body) as { name: string }).name).toBe(
        'House Rent',
      );

      const read = await app.inject({
        method: 'GET',
        url: structuresUrl(employeeA),
        headers: ownerHeaders(),
      });
      const revisions = JSON.parse(read.body) as Array<{
        lines: Array<{ componentName: string }>;
      }>;
      expect(revisions[0].lines[1].componentName).toBe('House Rent');

      // The owner-side library read closes the leg (after the retire below)
      // so every component created here is in the answer.
      const refuse = await app.inject({
        method: 'PATCH',
        url: `${componentsUrl}/${hraComp.id}`,
        headers: ownerHeaders(),
        payload: { active: false },
      });
      expect(refuse.statusCode).toBe(409);
      expect(
        (JSON.parse(refuse.body) as { error_code: string }).error_code,
      ).toBe('SALARY_COMPONENT_IN_USE');
      expect(refuse.body).toContain('payroll journey 1'); // Employee A's user name
      const after = await pool.query<{ active: boolean }>(
        'select active from public.salary_components where id = $1',
        [hraComp.id],
      );
      expect(after.rows[0]['active']).toBe(true);

      const unused = await app.inject({
        method: 'POST',
        url: componentsUrl,
        headers: ownerHeaders(),
        payload: { name: 'Unused Allowance' },
      });
      expect(unused.statusCode).toBe(201);
      unusedComp.id = (JSON.parse(unused.body) as { id: string }).id;
      const retire = await app.inject({
        method: 'PATCH',
        url: `${componentsUrl}/${unusedComp.id}`,
        headers: ownerHeaders(),
        payload: { active: false },
      });
      expect(retire.statusCode).toBe(200);
      expect((JSON.parse(retire.body) as { active: boolean }).active).toBe(
        false,
      );

      // The owner-side library read closes the leg: name-ascending with live
      // flags — the renamed HRA answers its new name, the retired one its
      // inactivity.
      const library = await app.inject({
        method: 'GET',
        url: componentsUrl,
        headers: ownerHeaders(),
      });
      expect(library.statusCode).toBe(200);
      const libraryBody = JSON.parse(library.body) as Array<{
        name: string;
        isBasic: boolean;
        active: boolean;
      }>;
      expect(libraryBody.map((c) => c.name)).toEqual([
        'Basic',
        'House Rent',
        'Special',
        'Unused Allowance',
        'Zero Rate',
      ]);
      expect(libraryBody[0]).toMatchObject({ isBasic: true, active: true });
      expect(libraryBody[3]).toMatchObject({ active: false });
    },
  );

  maybeIt(
    '23-3 — a deactivated component cannot re-enter a structure; unknown components are refused',
    async () => {
      const res = await app.inject({
        method: 'PUT',
        url: structuresUrl(employeeA),
        headers: ownerHeaders(),
        payload: {
          effectiveFrom: '2026-10-01',
          lines: [
            { componentId: basicComp.id, amount: '20000.00' },
            { componentId: unusedComp.id, amount: '1000.00' },
          ],
        },
      });
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain('deactivated');

      const unknown = await app.inject({
        method: 'PUT',
        url: structuresUrl(employeeA),
        headers: ownerHeaders(),
        payload: {
          effectiveFrom: '2026-10-01',
          lines: [
            { componentId: basicComp.id, amount: '20000.00' },
            {
              componentId: '99999999-9999-4999-8999-999999999999',
              amount: '1000.00',
            },
          ],
        },
      });
      expect(unknown.statusCode).toBe(422);
      expect(unknown.body).toContain('not in your company library');
      expect(await structureRowsOf(employeeA)).toHaveLength(3);
    },
  );

  maybeIt(
    '23-3 — another company admin gets 404 on our member; an employee token is 403 on the config surface',
    async () => {
      const foreign = await app.inject({
        method: 'PUT',
        url: structuresUrl(employeeA),
        headers: { authorization: `Bearer ${bearerFor(otherOwner)}` },
        payload: {
          effectiveFrom: '2026-10-01',
          lines: [{ componentId: basicComp.id, amount: '20000.00' }],
        },
      });
      expect(foreign.statusCode).toBe(404);
      expect(
        (JSON.parse(foreign.body) as { error_code: string }).error_code,
      ).toBe('RESOURCE_NOT_FOUND');
      expect(await structureRowsOf(employeeA)).toHaveLength(3);

      const employeeHeaders = () => ({
        authorization: `Bearer ${bearerFor(employeeA)}`,
      });
      const list = await app.inject({
        method: 'GET',
        url: componentsUrl,
        headers: employeeHeaders(),
      });
      expect(list.statusCode).toBe(403);

      const ownWrite = await app.inject({
        method: 'PUT',
        url: structuresUrl(employeeA),
        headers: employeeHeaders(),
        payload: {
          effectiveFrom: '2026-10-01',
          lines: [{ componentId: basicComp.id, amount: '20000.00' }],
        },
      });
      expect(ownWrite.statusCode).toBe(403);
      expect(await structureRowsOf(employeeA)).toHaveLength(3);

      // A platform admin (staff, no company) configures no tenant's payroll:
      // both surfaces answer 403, same as an employee's token.
      const staffHeaders = () => ({
        authorization: `Bearer ${bearerFor(platformAdmin)}`,
      });
      const staffList = await app.inject({
        method: 'GET',
        url: componentsUrl,
        headers: staffHeaders(),
      });
      expect(staffList.statusCode).toBe(403);

      const staffWrite = await app.inject({
        method: 'PUT',
        url: structuresUrl(employeeA),
        headers: staffHeaders(),
        payload: {
          effectiveFrom: '2026-10-01',
          lines: [{ componentId: basicComp.id, amount: '20000.00' }],
        },
      });
      expect(staffWrite.statusCode).toBe(403);
      expect(await structureRowsOf(employeeA)).toHaveLength(3);
    },
  );

  // ------------------------------------------------------------- 23-4 legs
  // The calendar, the month-status read, and the state-rules flag (CAP-4,
  // CAP-8). Fixture facts carried in from earlier legs: employee A joined
  // 2026-09-01 and is the only active employee with a join date (C is
  // removed, D/E have none), so the main tenant's first payroll month is
  // 2026-09 and the stranger tenant has no bound at all.

  /** The tenant's stored calendar revisions, oldest effective date first. */
  async function calendarRowsOf(
    tenantId = tenant,
  ): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query<Record<string, unknown>>(
      `select effective_from::text as effective_from, divisor_convention,
              cutoff_day, pay_date
         from public.payroll_calendar
        where tenant_id = $1
        order by effective_from`,
      [tenantId],
    );
    return rows;
  }

  async function payrollAuditCount(action: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.audit_log
        where tenant_id = $1 and action = $2`,
      [tenant, action],
    );
    return rows[0].n;
  }

  async function stateRulesRowOf(
    tenantId = tenant,
  ): Promise<Record<string, unknown>> {
    const { rows } = await pool.query<Record<string, unknown>>(
      `select notified, updated_at from public.payroll_state_rules
        where tenant_id = $1`,
      [tenantId],
    );
    return rows[0];
  }

  maybeIt(
    '23-4 — month status answers the defaults, the bound, and the month before the bound',
    async () => {
      // A counterexample for the bound's filters: the OWNER (a company_admin)
      // joins earlier than employee A. A regression that drops the role
      // filter would answer 2026-08 here instead of the fixture's 2026-09.
      must(
        await admin
          .from('memberships')
          .update({ join_date: '2026-08-01' })
          .eq('user_id', owner)
          .eq('tenant_id', tenant),
      );

      const status = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/months/2026-10',
        headers: ownerHeaders(),
      });
      expect(status.statusCode).toBe(200);
      expect(JSON.parse(status.body)).toMatchObject({
        month: '2026-10',
        divisorConvention: 'fixed-26',
        cutoffDay: 25,
        payDate: 1,
        effectiveFrom: null,
        locked: false,
        firstPayrollMonth: '2026-09',
        notRunnableReason: null,
      });
      expect(await calendarRowsOf()).toHaveLength(0);

      // A month before the bound is not runnable, naming the bound.
      const early = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/months/2026-08',
        headers: ownerHeaders(),
      });
      expect(early.statusCode).toBe(200);
      const earlyBody = JSON.parse(early.body) as { notRunnableReason: string };
      expect(earlyBody.notRunnableReason).toContain('2026-09');
      expect(earlyBody.notRunnableReason).toContain('no payroll history');
    },
  );

  maybeIt(
    '23-4 — a dated revision governs from its month; September stays on defaults',
    async () => {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/calendar',
        headers: ownerHeaders(),
        payload: {
          effectiveFrom: '2026-10-01',
          divisorConvention: 'fixed-30',
          cutoffDay: 20,
          payDate: 5,
        },
      });
      expect(put.statusCode).toBe(200);
      expect(JSON.parse(put.body)).toMatchObject({
        effectiveFrom: '2026-10-01',
        divisorConvention: 'fixed-30',
        cutoffDay: 20,
        payDate: 5,
      });

      const oct = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/months/2026-10',
        headers: ownerHeaders(),
      });
      expect(JSON.parse(oct.body)).toMatchObject({
        divisorConvention: 'fixed-30',
        cutoffDay: 20,
        payDate: 5,
        effectiveFrom: '2026-10-01',
        notRunnableReason: null,
      });

      // September's first day predates the row: the defaults still govern.
      // It is also the bound month itself — runnable, so no reason.
      const sep = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/months/2026-09',
        headers: ownerHeaders(),
      });
      expect(JSON.parse(sep.body)).toMatchObject({
        divisorConvention: 'fixed-26',
        cutoffDay: 25,
        payDate: 1,
        effectiveFrom: null,
        notRunnableReason: null,
      });
      expect(await payrollAuditCount('payroll.calendar_saved')).toBe(1);
    },
  );

  maybeIt(
    '23-4 — a mid-month-dated revision is invisible to its own month, governs the next',
    async () => {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/calendar',
        headers: ownerHeaders(),
        payload: { effectiveFrom: '2026-11-10', cutoffDay: 15 },
      });
      expect(put.statusCode).toBe(200);
      // Absent fields take the defaults, not the previous revision's values.
      expect(JSON.parse(put.body)).toMatchObject({
        effectiveFrom: '2026-11-10',
        divisorConvention: 'fixed-26',
        cutoffDay: 15,
        payDate: 1,
      });

      // November still resolves to the October row (month-start resolution).
      const nov = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/months/2026-11',
        headers: ownerHeaders(),
      });
      expect(JSON.parse(nov.body)).toMatchObject({
        divisorConvention: 'fixed-30',
        cutoffDay: 20,
        payDate: 5,
        effectiveFrom: '2026-10-01',
      });

      const dec = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/months/2026-12',
        headers: ownerHeaders(),
      });
      expect(JSON.parse(dec.body)).toMatchObject({
        divisorConvention: 'fixed-26',
        cutoffDay: 15,
        payDate: 1,
        effectiveFrom: '2026-11-10',
      });

      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/calendar',
        headers: ownerHeaders(),
      });
      expect(list.statusCode).toBe(200);
      const revisions = JSON.parse(list.body) as Array<{
        effectiveFrom: string;
      }>;
      expect(revisions.map((r) => r.effectiveFrom)).toEqual([
        '2026-10-01',
        '2026-11-10',
      ]);
    },
  );

  maybeIt(
    '23-4 — February and CoW rejections refuse to write; a same-date save replaces in place',
    async () => {
      const feb = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/calendar',
        headers: ownerHeaders(),
        payload: { effectiveFrom: '2026-12-01', cutoffDay: 29 },
      });
      expect(feb.statusCode).toBe(422);
      expect(feb.body).toContain('February');

      const cow = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/calendar',
        headers: ownerHeaders(),
        payload: { effectiveFrom: '2026-12-01', payDate: 8 },
      });
      expect(cow.statusCode).toBe(422);
      expect(cow.body).toContain('7th day');

      const cleared = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/calendar',
        headers: ownerHeaders(),
        payload: { effectiveFrom: '2026-12-01', cutoffDay: null },
      });
      expect(cleared.statusCode).toBe(422);
      expect(cleared.body).toContain('cannot be cleared');

      // An invented calendar date never reaches the service: the pipe
      // refuses it 422 (a 500 here would mean the constraint unwired).
      const invented = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/calendar',
        headers: ownerHeaders(),
        payload: { effectiveFrom: '2026-02-30', cutoffDay: 20 },
      });
      expect(invented.statusCode).toBe(422);
      expect(invented.body).toContain('effectiveFrom');
      expect(await calendarRowsOf()).toHaveLength(2);
      expect(await payrollAuditCount('payroll.calendar_saved')).toBe(2);

      // An identical same-date save writes nothing.
      const noop = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/calendar',
        headers: ownerHeaders(),
        payload: {
          effectiveFrom: '2026-10-01',
          divisorConvention: 'fixed-30',
          cutoffDay: 20,
          payDate: 5,
        },
      });
      expect(noop.statusCode).toBe(200);
      expect(await calendarRowsOf()).toHaveLength(2);
      expect(await payrollAuditCount('payroll.calendar_saved')).toBe(2);

      // A changed same-date save replaces the row — never a second one. The
      // save is a full envelope: absent fields take the DEFAULTS, not the
      // replaced revision's values.
      const replace = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/calendar',
        headers: ownerHeaders(),
        payload: { effectiveFrom: '2026-10-01', cutoffDay: 22 },
      });
      expect(replace.statusCode).toBe(200);
      const rows = await calendarRowsOf();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        effective_from: '2026-10-01',
        divisor_convention: 'fixed-26',
        cutoff_day: 22,
        pay_date: 1,
      });
      expect(await payrollAuditCount('payroll.calendar_saved')).toBe(3);

      // Naming every field restores them in the same dated slot.
      const full = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/calendar',
        headers: ownerHeaders(),
        payload: {
          effectiveFrom: '2026-10-01',
          divisorConvention: 'fixed-30',
          cutoffDay: 22,
          payDate: 5,
        },
      });
      expect(full.statusCode).toBe(200);
      expect((await calendarRowsOf())[0]).toMatchObject({
        effective_from: '2026-10-01',
        divisor_convention: 'fixed-30',
        cutoff_day: 22,
        pay_date: 5,
      });
      expect(await payrollAuditCount('payroll.calendar_saved')).toBe(4);
    },
  );

  maybeIt(
    '23-4 — the state-rules flag persists, no-ops identically, and audits each real change',
    async () => {
      const before = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/state-rules',
        headers: ownerHeaders(),
      });
      expect(before.statusCode).toBe(200);
      expect(JSON.parse(before.body)).toMatchObject({
        notified: false,
        updatedAt: '1970-01-01T00:00:00.000Z',
      });

      const set = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/state-rules',
        headers: ownerHeaders(),
        payload: { notified: true },
      });
      expect(set.statusCode).toBe(200);
      const setBody = JSON.parse(set.body) as { updatedAt: string };
      expect(setBody).toMatchObject({ notified: true });
      expect(await stateRulesRowOf()).toMatchObject({ notified: true });
      expect(await payrollAuditCount('payroll.state_rules_updated')).toBe(1);

      const again = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/state-rules',
        headers: ownerHeaders(),
        payload: { notified: true },
      });
      expect(again.statusCode).toBe(200);
      const againBody = JSON.parse(again.body) as { updatedAt: string };
      expect(againBody.updatedAt).toBe(setBody.updatedAt);
      expect(await payrollAuditCount('payroll.state_rules_updated')).toBe(1);

      // The other direction is a real change and audits again.
      const unset = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/state-rules',
        headers: ownerHeaders(),
        payload: { notified: false },
      });
      expect(unset.statusCode).toBe(200);
      expect(await stateRulesRowOf()).toMatchObject({ notified: false });
      expect(await payrollAuditCount('payroll.state_rules_updated')).toBe(2);
    },
  );

  maybeIt(
    '23-4 — another company sees only its own calendar, has no bound, and a bad month key is a 400',
    async () => {
      const strangerHeaders = () => ({
        authorization: `Bearer ${bearerFor(otherOwner)}`,
      });

      const empty = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/calendar',
        headers: strangerHeaders(),
      });
      expect(JSON.parse(empty.body)).toEqual([]);

      const status = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/months/2026-10',
        headers: strangerHeaders(),
      });
      expect(JSON.parse(status.body)).toMatchObject({
        divisorConvention: 'fixed-26',
        cutoffDay: 25,
        effectiveFrom: null,
        firstPayrollMonth: null,
      });
      expect(
        (JSON.parse(status.body) as { notRunnableReason: string })
          .notRunnableReason,
      ).toContain('joining date');

      // The stranger saves their own revision; ours is untouched.
      const put = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/calendar',
        headers: strangerHeaders(),
        payload: { effectiveFrom: '2026-10-01', cutoffDay: 20 },
      });
      expect(put.statusCode).toBe(200);
      expect(await calendarRowsOf(tenant)).toHaveLength(2);

      // A second, EARLIER revision saved after the first — the inclusive
      // bounds (cutoff 28, pay date 7) are legal, and the list must order by
      // effective date, not save order.
      const earlier = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/calendar',
        headers: strangerHeaders(),
        payload: { effectiveFrom: '2026-09-01', cutoffDay: 28, payDate: 7 },
      });
      expect(earlier.statusCode).toBe(200);
      expect(await calendarRowsOf(otherTenant)).toHaveLength(2);

      const strangerList = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/calendar',
        headers: strangerHeaders(),
      });
      const strangerRevisions = JSON.parse(strangerList.body) as Array<{
        effectiveFrom: string;
      }>;
      expect(strangerRevisions.map((r) => r.effectiveFrom)).toEqual([
        '2026-09-01',
        '2026-10-01',
      ]);

      const strangerSep = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/months/2026-09',
        headers: strangerHeaders(),
      });
      expect(JSON.parse(strangerSep.body)).toMatchObject({
        cutoffDay: 28,
        payDate: 7,
        effectiveFrom: '2026-09-01',
      });

      const theirs = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/months/2026-10',
        headers: strangerHeaders(),
      });
      expect(JSON.parse(theirs.body)).toMatchObject({ cutoffDay: 20 });
      const ours = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/months/2026-10',
        headers: ownerHeaders(),
      });
      expect(JSON.parse(ours.body)).toMatchObject({ cutoffDay: 22 });

      const badMonth = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/months/october',
        headers: ownerHeaders(),
      });
      expect(badMonth.statusCode).toBe(400);
      expect(badMonth.body).toContain('YYYY-MM');

      // An employee token is forbidden on the whole config surface.
      const employeeHeaders = () => ({
        authorization: `Bearer ${bearerFor(employeeA)}`,
      });
      const employee = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/calendar',
        headers: employeeHeaders(),
      });
      expect(employee.statusCode).toBe(403);
      const employeeMonths = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/months/2026-10',
        headers: employeeHeaders(),
      });
      expect(employeeMonths.statusCode).toBe(403);
      const employeeRules = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/state-rules',
        headers: employeeHeaders(),
        payload: { notified: true },
      });
      expect(employeeRules.statusCode).toBe(403);
      expect(await stateRulesRowOf()).toMatchObject({ notified: false });
    },
  );

  // ------------------------------------------------------------- 23-5 legs
  // Deduction heads, the PF-covered switch, and the never-member exclusion
  // rule (CAP-6). The statutory MATH is pinned by the pure-module unit tests
  // (statutory.spec.ts quotes the fixture verbatim); these legs pin the
  // config surfaces and the DB rows.

  const headsUrl = '/api/v1/payroll/deduction-heads';

  /** The tenant's stored head rows, straight from the DB. */
  async function headRowsOf(): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query<Record<string, unknown>>(
      `select name, kind, amount, basis, effective_from::text as effective_from, active
         from public.payroll_deduction_heads
        where tenant_id = $1
        order by name, effective_from`,
      [tenant],
    );
    return rows;
  }

  maybeIt(
    '23-5 — the owner builds the fixture heads: flat PT ₹200 and an insurance 2.5% of gross',
    async () => {
      const pt = await app.inject({
        method: 'POST',
        url: headsUrl,
        headers: ownerHeaders(),
        payload: {
          name: 'Professional Tax',
          kind: 'flat',
          amount: '200',
          effectiveFrom: '2026-09-01',
        },
      });
      expect(pt.statusCode).toBe(201);
      expect(JSON.parse(pt.body)).toMatchObject({
        name: 'Professional Tax',
        kind: 'flat',
        amount: '200.00', // normalised to money text
        basis: null,
        active: true,
      });

      // Variant B: 2% of the post-LOP gross — the earned basis amount.
      const insurance = await app.inject({
        method: 'POST',
        url: headsUrl,
        headers: ownerHeaders(),
        payload: {
          name: 'Insurance',
          kind: 'percent',
          amount: '2.5',
          basis: 'gross',
          effectiveFrom: '2026-09-01',
        },
      });
      expect(insurance.statusCode).toBe(201);
      expect(JSON.parse(insurance.body)).toMatchObject({
        name: 'Insurance',
        kind: 'percent',
        amount: '2.50',
        basis: 'gross',
      });

      const rows = await headRowsOf();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        name: 'Insurance',
        kind: 'percent',
        amount: '2.50',
        basis: 'gross',
        active: true,
      });
      expect(rows[1]).toMatchObject({
        name: 'Professional Tax',
        kind: 'flat',
        amount: '200.00',
        basis: null,
      });
    },
  );

  maybeIt(
    '23-5 — head shape mismatches are refused naming the rule, and nothing is written',
    async () => {
      const reject = async (payload: Record<string, unknown>, text: string) => {
        const res = await app.inject({
          method: 'POST',
          url: headsUrl,
          headers: ownerHeaders(),
          payload,
        });
        expect(res.statusCode).toBe(422);
        expect(res.body).toContain(text);
      };
      await reject(
        {
          name: 'Bad Pct',
          kind: 'percent',
          amount: '2.00',
          effectiveFrom: '2026-09-01',
        },
        'needs a basis',
      );
      await reject(
        {
          name: 'Bad Flat',
          kind: 'flat',
          amount: '200.00',
          basis: 'gross',
          effectiveFrom: '2026-09-01',
        },
        'only a percentage head carries a basis',
      );
      await reject(
        {
          name: 'Zero Pct',
          kind: 'percent',
          amount: '0',
          basis: 'basic',
          effectiveFrom: '2026-09-01',
        },
        'between 0 (exclusive)',
      );
      await reject(
        {
          name: 'Invented',
          kind: 'flat',
          amount: '200.00',
          effectiveFrom: '2026-02-30',
        },
        'effectiveFrom',
      );
      // Wire-shape refusals answer the pipe's 422 (the house pipe maps every
      // validation failure to 422): a wrongly-cased basis, a whitespace name.
      const badBasis = await app.inject({
        method: 'POST',
        url: headsUrl,
        headers: ownerHeaders(),
        payload: {
          name: 'Cased Basis',
          kind: 'percent',
          amount: '2.00',
          basis: 'Basic',
          effectiveFrom: '2026-09-01',
        },
      });
      expect(badBasis.statusCode).toBe(422);
      expect(badBasis.body).toContain('basis must be basic or gross');
      const blankName = await app.inject({
        method: 'POST',
        url: headsUrl,
        headers: ownerHeaders(),
        payload: {
          name: '   ',
          kind: 'flat',
          amount: '200.00',
          effectiveFrom: '2026-09-01',
        },
      });
      expect(blankName.statusCode).toBe(422);
      expect(blankName.body).toContain('name must not be empty');
      expect(await headRowsOf()).toHaveLength(2);
    },
  );

  maybeIt(
    '23-5 — a same-date head save replaces in place; an identical one writes nothing; deactivation retires',
    async () => {
      // Identical (after normalisation): "200" == "200.00" → no-op.
      const noop = await app.inject({
        method: 'POST',
        url: headsUrl,
        headers: ownerHeaders(),
        payload: {
          name: 'Professional Tax',
          kind: 'flat',
          amount: '200',
          effectiveFrom: '2026-09-01',
        },
      });
      expect(noop.statusCode).toBe(201);
      expect(await headRowsOf()).toHaveLength(2);

      // A changed same-date save replaces the row — never a second one.
      const replace = await app.inject({
        method: 'POST',
        url: headsUrl,
        headers: ownerHeaders(),
        payload: {
          name: 'Professional Tax',
          kind: 'flat',
          amount: '250.00',
          effectiveFrom: '2026-09-01',
        },
      });
      expect(replace.statusCode).toBe(201);
      let rows = await headRowsOf();
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ amount: '250.00' });

      // The list endpoint answers the stored revisions, name-then-date
      // order, with the id the deactivate route needs.
      const listRes = await app.inject({
        method: 'GET',
        url: headsUrl,
        headers: ownerHeaders(),
      });
      expect(listRes.statusCode).toBe(200);
      const listed = JSON.parse(listRes.body) as Array<{
        id: string;
        name: string;
        amount: string;
        basis: string | null;
        active: boolean;
      }>;
      expect(listed.map((h) => [h.name, h.amount])).toEqual([
        ['Insurance', '2.50'],
        ['Professional Tax', '250.00'],
      ]);
      expect(listed[0]).toMatchObject({ basis: 'gross', active: true });
      expect(typeof listed[0].id).toBe('string');

      // Deactivate the insurance head through the API-visible id.
      const insuranceId = listed[0].id;
      const deactivate = await app.inject({
        method: 'PUT',
        url: `${headsUrl}/${insuranceId}/deactivate`,
        headers: ownerHeaders(),
        payload: { confirm: true },
      });
      expect(deactivate.statusCode).toBe(200);
      expect(JSON.parse(deactivate.body)).toMatchObject({
        name: 'Insurance',
        active: false,
      });
      rows = await headRowsOf();
      expect(rows[0]).toMatchObject({ name: 'Insurance', active: false });
      expect(rows[1]).toMatchObject({
        name: 'Professional Tax',
        amount: '250.00',
      });

      // Deactivating again (already retired) is a 404, and the audit trail
      // carries exactly the real mutations: 2 saves + 1 replacement + 1
      // retirement + the no-op wrote nothing.
      const again = await app.inject({
        method: 'PUT',
        url: `${headsUrl}/${insuranceId}/deactivate`,
        headers: ownerHeaders(),
        payload: { confirm: true },
      });
      expect(again.statusCode).toBe(404);
      const { rows: auditRows } = await pool.query<{ n: number }>(
        `select count(*)::int as n from public.audit_log
          where tenant_id = $1 and action in
            ('payroll.head_saved', 'payroll.head_deactivated')`,
        [tenant],
      );
      expect(auditRows[0].n).toBe(4);
    },
  );

  maybeIt(
    '23-5 — the PF switch persists effective-dated, and the never-member rule refuses ever-members',
    async () => {
      // Fixture: PF-covered ON from the first payroll month.
      const on = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/pf-config',
        headers: ownerHeaders(),
        payload: { effectiveFrom: '2026-09-01', covered: true },
      });
      expect(on.statusCode).toBe(200);
      const onBody = JSON.parse(on.body) as {
        effectiveFrom: string;
        covered: boolean;
        updatedAt: string;
      };
      expect(onBody).toMatchObject({
        effectiveFrom: '2026-09-01',
        covered: true,
      });

      // Identical re-save: no second revision.
      const noop = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/pf-config',
        headers: ownerHeaders(),
        payload: { effectiveFrom: '2026-09-01', covered: true },
      });
      expect(noop.statusCode).toBe(200);
      const { rows } = await pool.query<Record<string, unknown>>(
        `select effective_from::text as effective_from, covered
           from public.payroll_pf_config
          where tenant_id = $1`,
        [tenant],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        effective_from: '2026-09-01',
        covered: true,
      });

      // Employee A carries UAN 101234567890 (the Form V seed): exclusion
      // refused — an ever-member is covered at any wage.
      const everMember = await app.inject({
        method: 'PUT',
        url: `/api/v1/payroll/employees/${employeeA}/pf-exclusion`,
        headers: ownerHeaders(),
        payload: { excluded: true },
      });
      expect(everMember.statusCode).toBe(422);
      expect(everMember.body).toContain('never a member');

      // A never-member can be excluded; the row lands and reads back.
      const never = await app.inject({
        method: 'PUT',
        url: `/api/v1/payroll/employees/${memberE}/pf-exclusion`,
        headers: ownerHeaders(),
        payload: { excluded: true },
      });
      expect(never.statusCode).toBe(200);
      expect(JSON.parse(never.body)).toMatchObject({ excluded: true });
      const readBack = await app.inject({
        method: 'GET',
        url: `/api/v1/payroll/employees/${memberE}/pf-exclusion`,
        headers: ownerHeaders(),
      });
      expect(JSON.parse(readBack.body)).toMatchObject({ excluded: true });

      // Clearing it writes false; a no-row employee reads false + epoch.
      const clear = await app.inject({
        method: 'PUT',
        url: `/api/v1/payroll/employees/${memberE}/pf-exclusion`,
        headers: ownerHeaders(),
        payload: { excluded: false },
      });
      expect(clear.statusCode).toBe(200);
      expect(JSON.parse(clear.body)).toMatchObject({ excluded: false });

      const absent = await app.inject({
        method: 'GET',
        url: `/api/v1/payroll/employees/${memberD}/pf-exclusion`,
        headers: ownerHeaders(),
      });
      expect(JSON.parse(absent.body)).toMatchObject({
        excluded: false,
        updatedAt: '1970-01-01T00:00:00.000Z',
      });

      // The list endpoints answer what was stored, oldest first.
      const pfList = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/pf-config',
        headers: ownerHeaders(),
      });
      const pfRevisions = JSON.parse(pfList.body) as Array<{
        effectiveFrom: string;
        covered: boolean;
        updatedAt: string;
      }>;
      // The list answers exactly the revision the PUT returned.
      expect(pfRevisions).toEqual([
        {
          effectiveFrom: onBody.effectiveFrom,
          covered: onBody.covered,
          updatedAt: onBody.updatedAt,
        },
      ]);

      // The real audit trail: one switch save + one exclusion set + one
      // clear — the no-ops and refusals wrote nothing.
      const { rows: pfAudit } = await pool.query<{
        action: string;
        n: number;
      }>(
        `select action, count(*)::int as n from public.audit_log
          where tenant_id = $1 and action in
            ('payroll.pf_config_saved', 'payroll.pf_exclusion_set')
          group by action`,
        [tenant],
      );
      const auditByAction: Record<string, number> = {};
      for (const row of pfAudit) {
        auditByAction[row.action] = row.n;
      }
      expect(auditByAction['payroll.pf_config_saved']).toBe(1);
      expect(auditByAction['payroll.pf_exclusion_set']).toBe(2);

      // An unknown member is a 404; an employee token is 403.
      const unknown = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/employees/99999999-9999-4999-8999-999999999999/pf-exclusion',
        headers: ownerHeaders(),
        payload: { excluded: true },
      });
      expect(unknown.statusCode).toBe(404);
      const forbidden = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/tds-config',
        headers: { authorization: `Bearer ${bearerFor(employeeA)}` },
      });
      expect(forbidden.statusCode).toBe(403);
    },
  );

  maybeIt(
    '23-5 — the TDS config read returns the exact FY 2026-27 constants',
    async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/tds-config',
        headers: ownerHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        taxYear: string;
        regime: string;
        standardDeduction: string;
        slabs: Array<{ upto: number | null; ratePercent: number }>;
        rebate: { section: string; threshold: number; residentOnly: boolean };
        cessRatePercent: number;
      };
      expect(body).toMatchObject({
        taxYear: 'FY 2026-27',
        regime: 'new',
        standardDeduction: '75000.00',
        cessRatePercent: 4,
        rebate: { section: 's.157', threshold: 1200000, residentOnly: true },
      });
      expect(body.slabs.map((s) => s.ratePercent)).toEqual([
        0, 5, 10, 15, 20, 25, 30,
      ]);
      expect(body.slabs[6].upto).toBeNull();

      // Both non-admin tokens are 403 on every 23-5 WRITE route — dropping
      // @Can from any of them would leave the whole payroll config open.
      const { rows: activeBefore } = await pool.query<{ n: number }>(
        `select count(*)::int as n from public.payroll_deduction_heads
          where tenant_id = $1 and active = true`,
        [tenant],
      );
      const employeeHeaders = () => ({
        authorization: `Bearer ${bearerFor(employeeA)}`,
      });
      const staffHeaders = () => ({
        authorization: `Bearer ${bearerFor(platformAdmin)}`,
      });
      for (const headers of [employeeHeaders(), staffHeaders()]) {
        const head = await app.inject({
          method: 'POST',
          url: headsUrl,
          headers,
          payload: {
            name: 'Smuggled',
            kind: 'flat',
            amount: '1.00',
            effectiveFrom: '2026-09-01',
          },
        });
        expect(head.statusCode).toBe(403);
        const pf = await app.inject({
          method: 'PUT',
          url: '/api/v1/payroll/pf-config',
          headers,
          payload: { effectiveFrom: '2026-09-01', covered: false },
        });
        expect(pf.statusCode).toBe(403);
        const exclusion = await app.inject({
          method: 'PUT',
          url: `/api/v1/payroll/employees/${employeeA}/pf-exclusion`,
          headers,
          payload: { excluded: false },
        });
        expect(exclusion.statusCode).toBe(403);
        const headsList = await app.inject({
          method: 'GET',
          url: headsUrl,
          headers,
        });
        expect(headsList.statusCode).toBe(403);
        const pfList403 = await app.inject({
          method: 'GET',
          url: '/api/v1/payroll/pf-config',
          headers,
        });
        expect(pfList403.statusCode).toBe(403);
        const exclusionRead = await app.inject({
          method: 'GET',
          url: `/api/v1/payroll/employees/${employeeA}/pf-exclusion`,
          headers,
        });
        expect(exclusionRead.statusCode).toBe(403);
      }
      // The deactivate write route is inside the same permission: a
      // non-admin can neither retire a head nor read the config lists.
      const { rows: anyHead } = await pool.query<{ id: string }>(
        `select id from public.payroll_deduction_heads
          where tenant_id = $1 limit 1`,
        [tenant],
      );
      const staffDeactivate = await app.inject({
        method: 'PUT',
        url: `${headsUrl}/${anyHead[0].id}/deactivate`,
        headers: staffHeaders(),
        payload: { confirm: true },
      });
      expect(staffDeactivate.statusCode).toBe(403);
      const { rows: activeAfter } = await pool.query<{ n: number }>(
        `select count(*)::int as n from public.payroll_deduction_heads
          where tenant_id = $1 and active = true`,
        [tenant],
      );
      expect(activeAfter[0].n).toBe(activeBefore[0].n);
    },
  );
});
