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

  const crew = [owner, employeeA, memberC, memberD, memberE, otherOwner];
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
});
