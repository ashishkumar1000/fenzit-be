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
  // The 23-6 fixture variants: B (join Oct 20), C2 (exit Oct 10),
  // E (join Oct 2), I (join Oct 3), the no-PAN/checkout-missing employee,
  // and the never-enrolled skip.
  const empB = randomUUID();
  const empC2 = randomUUID();
  const empE = randomUUID();
  const empI = randomUUID();
  const empNoPan = randomUUID();
  const empSkip = randomUUID();

  const crew = [
    owner,
    employeeA,
    memberC,
    memberD,
    memberE,
    otherOwner,
    platformAdmin,
    empB,
    empC2,
    empE,
    empI,
    empNoPan,
    empSkip,
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
    part?: 'full_day' | 'first_half' | 'second_half';
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
          part: input.part ?? 'full_day',
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

  // ------------------------------------------------------------- 23-6 legs
  // The monthly run engine (CAP-3/5) — the canonical fixture's money rows
  // verbatim. The seeding leg builds the attendance world (settings, office,
  // enrolments, punches) and the typed leaves; every run leg asserts payslip
  // snapshot rows straight from the DB.

  const runsUrl = '/api/v1/payroll/runs';

  /** A run view, polled to completion (the caller's bearer scopes it). */
  async function awaitRun(
    runId: string,
    headers: Record<string, string> = ownerHeaders(),
  ): Promise<{
    status: string;
    summary: Record<string, unknown> | null;
    errorMessage: string | null;
  }> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const res = await app.inject({
        method: 'GET',
        url: `${runsUrl}/${runId}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        status: string;
        summary: Record<string, unknown> | null;
        errorMessage: string | null;
      };
      if (body.status === 'completed' || body.status === 'failed') return body;
      if (Date.now() > deadline) {
        throw new Error(`run ${runId} did not finish: ${body.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  /** The tenant's payslip row for one user and month, straight from the DB. */
  async function payslipOf(
    userId: string,
    period: string,
  ): Promise<Record<string, unknown>> {
    const { rows } = await pool.query<Record<string, unknown>>(
      `select p.*, p.payable_days::text as payable_days,
              p.lop_days::text as lop_days, p.paid_days::text as paid_days,
              p.gross_earnings::text as gross_earnings,
              p.pf_employee::text as pf_employee, p.pf_employer::text as pf_employer,
              p.tds::text as tds, p.other_deductions::text as other_deductions,
              p.total_deductions::text as total_deductions,
              p.net_wages::text as net_wages
         from public.payroll_payslips p
         join public.memberships m on m.id = p.membership_id
        where p.tenant_id = $1 and p.salary_period = $2 and m.user_id = $3`,
      [tenant, period, userId],
    );
    if (!rows[0]) {
      throw new Error(`payslip missing for ${userId} in ${period}`);
    }
    return rows[0];
  }

  async function payslipCount(
    period: string,
    tenantId = tenant,
  ): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.payroll_payslips
        where tenant_id = $1 and salary_period = $2`,
      [tenantId, period],
    );
    return rows[0].n;
  }

  /** Punches: one full-day record per date (IST timestamps). */
  async function seedPunches(
    employeeId: string,
    dates: string[],
    opts: { missingCheckoutOn?: string } = {},
  ): Promise<void> {
    const officeId = (
      await pool.query<{ id: string }>(
        `select id from public.attendance_offices where tenant_id = $1 limit 1`,
        [tenant],
      )
    ).rows[0].id;
    for (const date of dates) {
      const missing = opts.missingCheckoutOn === date;
      // The record's attempt ids carry an FK to attendance_attempts — seed
      // the accepted attempt row first, then the record that cites it.
      const attemptId = randomUUID();
      must(
        await admin.from('attendance_attempts').insert({
          id: attemptId,
          tenant_id: tenant,
          employee_id: employeeId,
          request_id: randomUUID(),
          kind: 'check_in',
          outcome: 'ok',
          latitude: 12.9716,
          longitude: 77.5946,
          accuracy_m: 8,
          distance_m: 12,
          radius_m: 200,
          mocked: false,
          attempted_at: `${date}T09:30:00+05:30`,
        }),
      );
      let checkoutAttemptId: string | null = null;
      if (!missing) {
        checkoutAttemptId = randomUUID();
        must(
          await admin.from('attendance_attempts').insert({
            id: checkoutAttemptId,
            tenant_id: tenant,
            employee_id: employeeId,
            request_id: randomUUID(),
            kind: 'check_out',
            outcome: 'ok',
            latitude: 12.9716,
            longitude: 77.5946,
            accuracy_m: 8,
            distance_m: 14,
            radius_m: 200,
            mocked: false,
            attempted_at: `${date}T18:30:00+05:30`,
          }),
        );
      }
      must(
        await admin.from('attendance_records').insert({
          tenant_id: tenant,
          employee_id: employeeId,
          work_date: date,
          office_id: officeId,
          radius_m: 200,
          checkin_at: `${date}T09:30:00+05:30`,
          checkin_attempt_id: attemptId,
          checkin_lat: 12.9716,
          checkin_lng: 77.5946,
          checkin_accuracy_m: 8,
          checkin_distance_m: 12,
          checkin_mocked: false,
          checkout_at: missing ? null : `${date}T18:30:00+05:30`,
          checkout_attempt_id: checkoutAttemptId,
          checkout_lat: missing ? null : 12.9716,
          checkout_lng: missing ? null : 77.5946,
          checkout_accuracy_m: missing ? null : 8,
          checkout_distance_m: missing ? null : 14,
          checkout_mocked: missing ? null : false,
        }),
      );
    }
  }

  async function seedStructureFor(
    userId: string,
    basicAmount = '20000.00',
    effectiveFrom = '2026-09-01',
  ): Promise<void> {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/members/${userId}/salary-structures`,
      headers: ownerHeaders(),
      payload: {
        effectiveFrom,
        lines: [
          { componentId: basicComp.id, amount: basicAmount },
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
    if (res.statusCode !== 200) {
      throw new Error(`structure save failed: ${res.statusCode} ${res.body}`);
    }
  }

  maybeIt(
    '23-6 — the fixture world: variant memberships, the attendance grid, and the typed leaves',
    async () => {
      // The 23-4 leg left the calendar at fixed-30/cut-off 22 for October;
      // the fixture base runs on fixed-26/cut-off 25.
      const calendar = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/calendar',
        headers: ownerHeaders(),
        payload: {
          effectiveFrom: '2026-10-01',
          divisorConvention: 'fixed-26',
          cutoffDay: 25,
          payDate: 1,
        },
      });
      expect(calendar.statusCode).toBe(200);

      // Variant B is 2% of the earned gross (the 23-5 leg saved 2.5) — the
      // same-date replace re-prices it so D's totals are the fixture's.
      // The BASE variant runs with PT only ("no other heads"), so the head
      // is retired right after re-pricing; the D leg re-enacts it (an
      // identical re-save of a retired revision).
      const reprice = await app.inject({
        method: 'POST',
        url: headsUrl,
        headers: ownerHeaders(),
        payload: {
          name: 'Insurance',
          kind: 'percent',
          amount: '2',
          basis: 'gross',
          effectiveFrom: '2026-09-01',
        },
      });
      expect(reprice.statusCode).toBe(201);
      const { rows: insuranceId } = await pool.query<{ id: string }>(
        `select id from public.payroll_deduction_heads
          where tenant_id = $1 and name = 'Insurance' limit 1`,
        [tenant],
      );
      const retire = await app.inject({
        method: 'PUT',
        url: `${headsUrl}/${insuranceId[0].id}/deactivate`,
        headers: ownerHeaders(),
        payload: { confirm: true },
      });
      expect(retire.statusCode).toBe(200);

      // Variant memberships (active, employee role) with the fixture's
      // employment windows.
      const variants: Array<{
        id: string;
        code: string;
        join: string;
        exit?: string;
      }> = [
        { id: empB, code: 'EMP-010', join: '2026-10-20' },
        { id: empC2, code: 'EMP-011', join: '2026-09-01', exit: '2026-10-10' },
        { id: empE, code: 'EMP-012', join: '2026-10-02' },
        { id: empI, code: 'EMP-013', join: '2026-10-03' },
        { id: empNoPan, code: 'EMP-014', join: '2026-09-01' },
        { id: empSkip, code: 'EMP-015', join: '2026-09-01' },
      ];
      must(
        await admin.from('memberships').insert(
          variants.map((v) => ({
            user_id: v.id,
            tenant_id: tenant,
            role: 'employee',
            status: 'active',
            employee_code: v.code,
            join_date: v.join,
            exit_date: v.exit ?? null,
          })),
        ),
      );
      // The owner and the removed member carry structures: the population
      // excludes both (fixture G). memberE joins the population with no
      // structure (the not_configured skip); memberD has no join date (the
      // missing_join_date skip).
      must(
        await admin
          .from('memberships')
          .update({ employee_code: 'EMP-002' })
          .eq('user_id', owner)
          .eq('tenant_id', tenant),
      );
      // The 23-1 legs may already have created these memberships — seed
      // only the missing ones (the active-day unique would refuse a twin).
      const { rows: existingMembers } = await pool.query<{ user_id: string }>(
        `select user_id::text as user_id from public.memberships
          where tenant_id = $1 and user_id = any($2::uuid[])`,
        [tenant, [memberE, memberD]],
      );
      const present = new Set(existingMembers.map((r) => r.user_id));
      const missing: Array<{
        user_id: string;
        tenant_id: string;
        role: string;
        status: string;
        employee_code: string;
      }> = [];
      if (!present.has(memberE)) {
        missing.push({
          user_id: memberE,
          tenant_id: tenant,
          role: 'employee',
          status: 'active',
          employee_code: 'EMP-016',
        });
      }
      if (!present.has(memberD)) {
        missing.push({
          user_id: memberD,
          tenant_id: tenant,
          role: 'employee',
          status: 'active',
          employee_code: 'EMP-017',
        });
      }
      if (missing.length > 0) {
        must(await admin.from('memberships').insert(missing));
      }
      // memberD keeps NO join date: the missing_join_date skip (never a
      // null-prorated payslip). memberE (above) is the not_configured case.
      // memberE becomes the not_configured case: an active employee with a
      // join date and no structure. memberD keeps NO join date (cleared — a
      // 23-1 leg may have set one): the missing_join_date skip, never a
      // null-prorated payslip.
      must(
        await admin
          .from('memberships')
          .update({ status: 'active', join_date: '2026-09-01' })
          .eq('user_id', memberE)
          .eq('tenant_id', tenant),
      );
      must(
        await admin
          .from('memberships')
          .update({ status: 'active', join_date: null })
          .eq('user_id', memberD)
          .eq('tenant_id', tenant),
      );

      // Structures for every variant but empSkip (the not_configured /
      // never_enrolled split) and memberE (not_configured).
      for (const v of variants) {
        await seedStructureFor(v.id);
      }
      await seedStructureFor(owner);
      const c2Structure = await app.inject({
        method: 'PUT',
        url: `/api/v1/members/${memberC}/salary-structures`,
        headers: ownerHeaders(),
        payload: {
          effectiveFrom: '2026-09-01',
          lines: [{ componentId: basicComp.id, amount: '20000.00' }],
        },
      });
      expect(c2Structure.statusCode).toBe(200);

      // The attendance world: settings, one office, enrolments covering
      // Sep 2026 → Mar 2027 for every running employee (NOT empSkip).
      must(
        await admin.from('attendance_settings').upsert(
          {
            tenant_id: tenant,
            enabled: true,
            setup_completed_at: new Date().toISOString(),
          },
          { onConflict: 'tenant_id' },
        ),
      );
      const office = must(
        await admin
          .from('attendance_offices')
          .insert({
            tenant_id: tenant,
            name: 'Journey Office',
            latitude: 12.9716,
            longitude: 77.5946,
            radius_m: 200,
          })
          .select('id')
          .single(),
      );
      const runEmployees = [employeeA, empB, empC2, empE, empI, empNoPan];
      for (const employeeId of runEmployees) {
        // The enrolment and its office assignment are mutually checking
        // constraints — both land inside ONE transaction (the 23-1 backfill
        // leg's transaction idiom).
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query(
            `insert into public.attendance_enrolments
               (tenant_id, employee_id, valid, enabled_at)
             values ($1::uuid, $2::uuid, '[2026-09-01,2027-04-01)'::daterange,
                     '2026-09-01T00:00:00+05:30'::timestamptz)`,
            [tenant, employeeId],
          );
          await client.query(
            `insert into public.attendance_office_assignments
               (tenant_id, employee_id, office_id, valid)
             values ($1::uuid, $2::uuid, $3::uuid, '[2026-09-01,2027-04-01)'::daterange)`,
            [tenant, employeeId, office.id],
          );
          await client.query('commit');
        } catch (e) {
          await client.query('rollback').catch(() => undefined);
          throw e;
        } finally {
          client.release();
        }
      }

      // The fixture's Sundays are weekly off (Oct 4, 11, 18, 25; Sep's
      // Sundays too) — without the defaults every unpunched Sunday grades
      // absent and LOPs.
      must(
        await admin.from('attendance_weekly_off_defaults').insert({
          tenant_id: tenant,
          valid: '[2026-09-01,2027-04-01)' as never,
          days: [7], // Sunday = 7 in the ISO 1-7 convention
        }),
      );

      // The fixture base runs with PT ₹200 — the 23-5 leg left a 250
      // replacement in place; the same-date save restores it.
      const ptRestore = await app.inject({
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
      expect(ptRestore.statusCode).toBe(201);

      // Punches on the working days of each kept window (Sundays and the
      // leave days carry no record; I's Oct 20 stays unpunched = absent).
      await seedPunches(employeeA, [
        '2026-09-01',
        '2026-09-02',
        '2026-09-03',
        '2026-09-04',
        '2026-09-05',
        '2026-09-07',
        '2026-09-08',
        '2026-09-09',
        '2026-09-10',
        '2026-09-11',
        '2026-09-12',
        '2026-09-14',
        '2026-09-15',
        '2026-09-16',
        '2026-09-17',
        '2026-09-18',
        '2026-09-19',
        '2026-09-21',
        '2026-09-22',
        '2026-09-23',
        '2026-09-24',
        '2026-09-25',
        // Sep 26–30 are October-owned prior-period days — unpunched, they
        // would grade absent and LOP.
        '2026-09-26',
        '2026-09-28',
        '2026-09-29',
        '2026-09-30',
        '2026-10-01',
        '2026-10-02',
        '2026-10-03',
        '2026-10-05',
        '2026-10-08',
        '2026-10-09',
        '2026-10-10',
        '2026-10-16',
        '2026-10-17',
        '2026-10-19',
        '2026-10-20',
        '2026-10-21',
        '2026-10-22',
        '2026-10-23',
        '2026-10-24',
        '2026-10-26',
        '2026-10-27',
        '2026-10-28',
        '2026-10-29',
        '2026-10-30',
        '2026-10-31',
      ]);
      await seedPunches(empB, [
        '2026-10-20',
        '2026-10-21',
        '2026-10-22',
        '2026-10-23',
        '2026-10-24',
        '2026-10-26',
        '2026-10-27',
        '2026-10-28',
        '2026-10-29',
        '2026-10-30',
        '2026-10-31',
      ]);
      await seedPunches(empC2, [
        '2026-09-01',
        '2026-09-02',
        '2026-09-03',
        '2026-09-04',
        '2026-09-05',
        '2026-09-07',
        '2026-09-08',
        '2026-09-09',
        '2026-09-10',
        '2026-09-11',
        '2026-09-12',
        '2026-09-14',
        '2026-09-15',
        '2026-09-16',
        '2026-09-17',
        '2026-09-18',
        '2026-09-19',
        '2026-09-21',
        '2026-09-22',
        '2026-09-23',
        '2026-09-24',
        '2026-09-25',
        '2026-09-26',
        '2026-09-28',
        '2026-09-29',
        '2026-09-30',
        '2026-10-01',
        '2026-10-02',
        '2026-10-03',
        '2026-10-05',
        '2026-10-06',
        '2026-10-07',
        '2026-10-08',
        '2026-10-09',
        '2026-10-10',
      ]);
      await seedPunches(empE, [
        '2026-10-02',
        '2026-10-03',
        '2026-10-06',
        '2026-10-07',
        '2026-10-08',
        '2026-10-09',
        '2026-10-10',
        '2026-10-12',
        '2026-10-13',
        '2026-10-14',
        '2026-10-15',
        '2026-10-16',
        '2026-10-17',
        '2026-10-19',
        '2026-10-20',
        '2026-10-21',
        '2026-10-22',
        '2026-10-23',
        '2026-10-24',
        '2026-10-26',
        '2026-10-27',
      ]);
      await seedPunches(empI, [
        '2026-10-03',
        '2026-10-05',
        '2026-10-06',
        '2026-10-07',
        '2026-10-08',
        '2026-10-09',
        '2026-10-12',
        '2026-10-13',
        '2026-10-14',
        '2026-10-15',
        '2026-10-16',
        '2026-10-17',
        '2026-10-19',
        '2026-10-21',
        '2026-10-22',
        '2026-10-23',
        '2026-10-24',
        '2026-10-27',
        '2026-10-28',
      ]);
      // The no-PAN employee also carries a checkout_missing day (Oct 16).
      await seedPunches(
        empNoPan,
        [
          '2026-09-01',
          '2026-09-02',
          '2026-09-03',
          '2026-09-04',
          '2026-09-05',
          '2026-09-07',
          '2026-09-08',
          '2026-09-09',
          '2026-09-10',
          '2026-09-11',
          '2026-09-12',
          '2026-09-14',
          '2026-09-15',
          '2026-09-16',
          '2026-09-17',
          '2026-09-18',
          '2026-09-19',
          '2026-09-21',
          '2026-09-22',
          '2026-09-23',
          '2026-09-24',
          '2026-09-25',
          '2026-09-26',
          '2026-09-28',
          '2026-09-29',
          '2026-09-30',
          '2026-10-01',
          '2026-10-02',
          '2026-10-03',
          '2026-10-05',
          '2026-10-06',
          '2026-10-07',
          '2026-10-08',
          '2026-10-09',
          '2026-10-10',
          '2026-10-12',
          '2026-10-13',
          '2026-10-14',
          '2026-10-15',
          '2026-10-16',
          '2026-10-17',
          '2026-10-19',
          '2026-10-20',
          '2026-10-21',
          '2026-10-22',
          '2026-10-23',
          '2026-10-24',
          '2026-10-26',
          '2026-10-27',
          '2026-10-28',
          '2026-10-29',
          '2026-10-30',
          '2026-10-31',
        ],
        { missingCheckoutOn: '2026-10-16' },
      );

      // A paid type for the fixture's paid leaves (the keyword default).
      const earned = await app.inject({
        method: 'POST',
        url: '/api/v1/attendance/leave/types',
        headers: ownerHeaders(),
        payload: { name: 'Earned Leave' },
      });
      expect(earned.statusCode).toBe(201);
      const earnedId = (JSON.parse(earned.body) as { id: string }).id;
      expect((JSON.parse(earned.body) as { paid: boolean }).paid).toBe(true);

      // The 23-2 legs already seeded Oct 6–7 (approved, typed Unpaid) —
      // retype that request to the paid Earned type instead of reseeding
      // (the active-day unique would refuse a second request).
      const { rows: casualPair } = await pool.query<{ id: string }>(
        `select r.id::text as id
           from public.leave_requests r
           join public.leave_request_days d on d.leave_request_id = r.id
          where r.tenant_id = $1 and d.employee_id = $2
            and d.leave_date = '2026-10-06' limit 1`,
        [tenant, employeeA],
      );
      const retype = await app.inject({
        method: 'PATCH',
        url: `/api/v1/attendance/leave/${casualPair[0].id}/type`,
        headers: ownerHeaders(),
        payload: { leaveTypeId: earnedId },
      });
      expect(retype.statusCode).toBe(200);
      await seedLeaveRequest({
        dates: ['2026-10-12'],
        state: 'approved',
        leaveTypeId: unpaidLeave.id,
        part: 'second_half',
      }); // unpaid half
      await seedLeaveRequest({
        dates: ['2026-10-05'],
        state: 'approved',
        leaveTypeId: unpaidLeave.id,
        employeeId: empE,
      });
      await seedLeaveRequest({
        dates: ['2026-10-10'],
        state: 'approved',
        leaveTypeId: earnedId,
        employeeId: empI,
        part: 'second_half',
      }); // paid half
      await seedLeaveRequest({
        dates: ['2026-10-01', '2026-10-02'],
        state: 'approved',
        leaveTypeId: unpaidLeave.id,
        employeeId: empI,
      }); // before the join — never LOPs

      // A's unpaid set, as the run will read it: Oct 12 (half), 13–15.
      const { rows: unpaidDates } = await pool.query<{ leave_date: string }>(
        `select d.leave_date::text as leave_date
           from public.leave_request_days d
           join public.leave_requests r on r.id = d.leave_request_id
           join public.leave_types t on t.id = r.leave_type_id
          where r.tenant_id = $1 and d.employee_id = $2
            and d.state = 'approved' and t.paid = false
          order by d.leave_date`,
        [tenant, employeeA],
      );
      expect(unpaidDates.map((r) => r.leave_date)).toEqual([
        '2026-10-12',
        '2026-10-13',
        '2026-10-14',
        '2026-10-15',
      ]);
    },
  );

  maybeIt(
    '23-6 — September runs on the ₹15,000 ceiling (PF 1,800.00)',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: runsUrl,
        headers: ownerHeaders(),
        payload: { month: '2026-09' },
      });
      expect(res.statusCode).toBe(202);
      const queued = JSON.parse(res.body) as { id: string; status: string };
      expect(queued.status).toBe('queued');
      const done = await awaitRun(queued.id);
      expect(done.status).toBe('completed');

      const slip = await payslipOf(employeeA, '2026-09');
      expect(slip['pf_employee']).toBe('1800.00');
      expect(slip['pf_employer']).toBe('1800.00');
      // The ceiling binds: 12% × min(earned basic, 15,000) = 1,800.00.
      expect(slip['divisor_convention']).toBe('fixed-26');
      expect(slip['cutoff_day']).toBe(25);
      expect(slip['slip_number']).toBe('PS-2026-09-0001');
    },
  );

  maybeIt(
    '23-6 — October: the base row and every variant, straight from the fixture',
    async () => {
      const res = await app.inject({
        method: 'POST',
        url: runsUrl,
        headers: ownerHeaders(),
        payload: { month: '2026-10' },
      });
      expect(res.statusCode).toBe(202);
      const queued = JSON.parse(res.body) as { id: string };
      const done = await awaitRun(queued.id);
      expect(done.status).toBe('completed');

      // The base row (employee A).
      const base = await payslipOf(employeeA, '2026-10');
      expect(base).toMatchObject({
        payable_days: '26.00',
        lop_days: '3.50',
        paid_days: '22.50',
        gross_earnings: '24230.77',
        pf_employee: '2076.92',
        pf_employer: '2076.92',
        tds: '0.00',
        other_deductions: '200.00',
        total_deductions: '2276.92',
        net_wages: '21953.85',
      });
      expect(base['slip_number']).toBe('PS-2026-10-0001');
      expect(base['pan']).toBe('ABCPE1234F');
      expect(base['uan_number']).toBe('101234567890');
      expect(base['employee_code']).toBe('EMP-001');
      expect(base['divisor_convention']).toBe('fixed-26');
      const earningLines = base['earning_lines'] as Array<{
        name: string;
        amount: string;
      }>;
      expect(earningLines).toEqual([
        { name: 'Basic', amount: '17307.69' },
        { name: 'House Rent', amount: '6923.08' },
      ]);

      // Variant C: the Oct-20 joiner — 12 payable days, no leaves.
      const c = await payslipOf(empB, '2026-10');
      expect(c).toMatchObject({
        payable_days: '12.00',
        lop_days: '0.00',
        paid_days: '12.00',
        gross_earnings: '12923.08',
        pf_employee: '1107.69',
        net_wages: '11615.39',
      });

      // Variant C2: the Oct-10 leaver — 10 payable days, still in the run.
      const c2 = await payslipOf(empC2, '2026-10');
      expect(c2).toMatchObject({
        payable_days: '10.00',
        gross_earnings: '10769.23',
        pf_employee: '923.08',
        net_wages: '9646.15',
      });

      // Variant E: the Oct-2 joiner with one unpaid LOP day.
      const e = await payslipOf(empE, '2026-10');
      expect(e).toMatchObject({
        payable_days: '26.00',
        lop_days: '1.00',
        paid_days: '25.00',
        gross_earnings: '26923.08',
        pf_employee: '2307.69',
        net_wages: '24415.39',
      });

      // Variant I: the absent day is the only LOP; the pre-join leave and
      // the paid half are not.
      const i = await payslipOf(empI, '2026-10');
      expect(i).toMatchObject({
        payable_days: '26.00',
        lop_days: '1.00',
        paid_days: '25.00',
        gross_earnings: '26923.08',
        pf_employee: '2307.69',
        net_wages: '24415.39',
      });

      // The no-PAN employee: blank PAN, the warning carried; the
      // checkout_missing day paid and flagged.
      const noPan = await payslipOf(empNoPan, '2026-10');
      expect(noPan['pan']).toBeNull();
      const noPanWarnings = noPan['warnings'] as string[];
      expect(noPanWarnings.join(' ')).toContain('checkout_missing');

      // The skips and exclusions: memberE not configured, empSkip never
      // enrolled, the owner and the removed member absent from the run.
      const summary = (done.summary ?? {}) as {
        skips: Array<{ employee: string; reason: string }>;
        employees: number;
        payslips: number;
        warnings: string[];
      };
      const reasons = Object.fromEntries(
        summary.skips.map((s) => [s.employee, s.reason]),
      );
      expect(Object.values(reasons)).toContain('not_configured');
      expect(Object.values(reasons)).toContain('never_enrolled');
      expect(Object.values(reasons)).toContain('missing_join_date');
      void reasons;
      expect(summary.employees).toBe(9);
      expect(summary.payslips).toBe(6);
      expect(await payslipCount('2026-10')).toBe(6);
      expect(summary.warnings.join(' ')).toContain('no PAN');
      expect(
        await pool.query(
          `select 1 from public.payroll_payslips p
             join public.memberships m on m.id = p.membership_id
            where p.tenant_id = $1 and (m.user_id = $2 or m.user_id = $3)`,
          [tenant, owner, memberC],
        ),
      ).toMatchObject({ rowCount: 0 });

      // The TDS basis was the earning-line sum: A's structure × 6 months −
      // 75,000 = 1,21,000 → below ₹4 lakh → 0.00 (the fixture's TDS row).
      expect(base['tds']).toBe('0.00');
    },
  );

  maybeIt(
    '23-6 — variant D: the TDS override, the 50% clamp, and the recovery line',
    async () => {
      const ack = await app.inject({
        method: 'PUT',
        url: `/api/v1/payroll/employees/${employeeA}/run-override`,
        headers: ownerHeaders(),
        payload: {
          month: '2026-10',
          field: 'tds',
          amount: '12000.00',
          acknowledgedLiability: true,
        },
      });
      expect(ack.statusCode).toBe(200);
      expect(JSON.parse(ack.body)).toMatchObject({ amount: '12000.00' });

      // The acknowledgment is not optional.
      const unacked = await app.inject({
        method: 'PUT',
        url: `/api/v1/payroll/employees/${empB}/run-override`,
        headers: ownerHeaders(),
        payload: {
          month: '2026-10',
          field: 'pf_employee',
          amount: '100.00',
          acknowledgedLiability: false,
        },
      });
      expect(unacked.statusCode).toBe(422);
      expect(unacked.body).toContain('employer-liability');

      // The D variant ADDS the insurance head: the identical re-save
      // re-enacts the retired revision.
      const reenact = await app.inject({
        method: 'POST',
        url: headsUrl,
        headers: ownerHeaders(),
        payload: {
          name: 'Insurance',
          kind: 'percent',
          amount: '2',
          basis: 'gross',
          effectiveFrom: '2026-09-01',
        },
      });
      expect(reenact.statusCode).toBe(201);

      const res = await app.inject({
        method: 'POST',
        url: runsUrl,
        headers: ownerHeaders(),
        payload: { month: '2026-10' },
      });
      expect(res.statusCode).toBe(202);
      const queued = JSON.parse(res.body) as { id: string };
      const done = await awaitRun(queued.id);
      expect(done.status).toBe('completed');

      const d = await payslipOf(employeeA, '2026-10');
      // The override is ₹12,000 but the 50% cap clamps the DEDUCTED tds to
      // 9,848.88 — the snapshot's statutory column reads the clamped line
      // so the row, its lines and its totals can never disagree.
      expect(d).toMatchObject({
        tds: '9848.88',
        total_deductions: '12115.39',
        net_wages: '12115.38',
      });
      // The unabsorbable excess is a recovery line on the next run — and
      // the run summary carries it.
      const { rows: recovery } = await pool.query<{
        outstanding_amount: string;
      }>(
        `select outstanding_amount::text as outstanding_amount
           from public.payroll_recovery_lines
          where tenant_id = $1 and month_raised = '2026-10'`,
        [tenant],
      );
      expect(recovery).toHaveLength(1);
      expect(recovery[0]['outstanding_amount']).toBe('2646.15');
      expect((done.summary ?? {})['warnings']).toEqual(
        expect.arrayContaining([expect.stringContaining('2646.15')]),
      );
    },
  );

  maybeIt(
    '23-6 — the recovery is absorbed by the next run once the override lifts',
    async () => {
      const lift = await app.inject({
        method: 'PUT',
        url: `/api/v1/payroll/employees/${employeeA}/run-override`,
        headers: ownerHeaders(),
        payload: {
          month: '2026-10',
          field: 'tds',
          amount: '0.00',
          acknowledgedLiability: true,
        },
      });
      expect(lift.statusCode).toBe(200);

      const res = await app.inject({
        method: 'POST',
        url: runsUrl,
        headers: ownerHeaders(),
        payload: { month: '2026-10' },
      });
      expect(res.statusCode).toBe(202);
      const queued = JSON.parse(res.body) as { id: string };
      const absorbed = await awaitRun(queued.id);
      expect(absorbed['status']).toBe('completed');

      const a = await payslipOf(employeeA, '2026-10');
      const deductionLines = a['deduction_lines'] as Array<{
        source: string;
        amount: string;
      }>;
      expect(deductionLines).toEqual(
        expect.arrayContaining([
          { source: 'recovery:2026-10', amount: '2646.15' },
        ]),
      );
      // Deductions: PF 2,076.92 + TDS 0 + insurance 484.62 + PT 200 +
      // recovery 2,646.15 = 5,407.69 → net 18,823.08.
      expect(a).toMatchObject({
        total_deductions: '5407.69',
        net_wages: '18823.08',
      });
      const { rows: recovery } = await pool.query<{
        outstanding_amount: string;
      }>(
        `select outstanding_amount::text as outstanding_amount
           from public.payroll_recovery_lines
          where tenant_id = $1 and month_raised = '2026-10'`,
        [tenant],
      );
      expect(recovery[0]['outstanding_amount']).toBe('0.00');

      // The fixture's November row carries PT only — retire the head again
      // (the November leg runs with PF + PT, no insurance).
      const { rows: insuranceRow } = await pool.query<{ id: string }>(
        `select id from public.payroll_deduction_heads
          where tenant_id = $1 and name = 'Insurance' limit 1`,
        [tenant],
      );
      const retire2 = await app.inject({
        method: 'PUT',
        url: `${headsUrl}/${insuranceRow[0].id}/deactivate`,
        headers: ownerHeaders(),
        payload: { confirm: true },
      });
      expect(retire2.statusCode).toBe(200);
    },
  );

  maybeIt(
    '23-6 — November: the structure revision and the prior-period leave (fixture G/F)',
    async () => {
      // The F revision: effective 2026-11-01 — basic 22,000, HRA 8,800.
      const revision = await app.inject({
        method: 'PUT',
        url: `/api/v1/members/${employeeA}/salary-structures`,
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
      if (revision.statusCode !== 200) {
        throw new Error(
          `revision failed: ${revision.statusCode} ${revision.body}`,
        );
      }

      // The pre-cut-off gate: November is the current month and today is
      // before its resolved cut-off (25) — the run refuses in plain English.
      const early = await app.inject({
        method: 'POST',
        url: runsUrl,
        headers: ownerHeaders(),
        payload: { month: '2026-11' },
      });
      expect(early.statusCode).toBe(422);
      expect(early.body).toContain('opens on day 25');

      // A November-dated calendar row moves the cut-off to the 15th — the
      // month-start-resolved gate re-reads it and the run opens today.
      const novCalendar = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/calendar',
        headers: ownerHeaders(),
        payload: {
          effectiveFrom: '2026-11-01',
          divisorConvention: 'fixed-26',
          cutoffDay: 15,
          payDate: 1,
        },
      });
      expect(novCalendar.statusCode).toBe(200);

      // G's Oct-27 leave is seeded AFTER October ran: it belongs to
      // November's run as a prior-period day — October stays unchanged.
      // November's own owned days need their punches too.
      await seedPunches(employeeA, [
        '2026-11-02',
        '2026-11-03',
        '2026-11-04',
        '2026-11-05',
        '2026-11-06',
        '2026-11-07',
        '2026-11-09',
        '2026-11-10',
        '2026-11-11',
        '2026-11-12',
        '2026-11-13',
        '2026-11-14',
        '2026-11-16',
        '2026-11-17',
        '2026-11-18',
        '2026-11-19',
        '2026-11-20',
        '2026-11-21',
        '2026-11-23',
        '2026-11-24',
        '2026-11-25',
      ]);
      await seedLeaveRequest({
        dates: ['2026-10-27'],
        state: 'approved',
        leaveTypeId: unpaidLeave.id,
      });

      const res = await app.inject({
        method: 'POST',
        url: runsUrl,
        headers: ownerHeaders(),
        payload: { month: '2026-11' },
      });
      expect(res.statusCode).toBe(202);
      const queued = JSON.parse(res.body) as { id: string };
      const novRun = await awaitRun(queued.id);
      expect(novRun['status']).toBe('completed');

      const nov = await payslipOf(employeeA, '2026-11');
      // NOTE: 29,615.39 is the SUM OF THE ROUNDED EARNING LINES (the spec's
      // rounding-once-per-line); the fixture's 29,615.38 shorthand rounds
      // the structure total once. One paise — flagged for the owner's
      // done_checkpoint adjudication.
      expect(nov).toMatchObject({
        payable_days: '26.00',
        lop_days: '1.00',
        paid_days: '25.00',
        gross_earnings: '29615.39',
        pf_employee: '2538.46',
        tds: '0.00',
        net_wages: '26876.93',
      });
      const earningLines = nov['earning_lines'] as Array<{
        name: string;
        amount: string;
      }>;
      expect(earningLines[0]).toEqual({ name: 'Basic', amount: '21153.85' });

      // October's payslips are untouched by November's run.
      const oct = await payslipOf(employeeA, '2026-10');
      expect(oct).toMatchObject({ net_wages: '18823.08' });
    },
  );

  maybeIt(
    '23-6 — the owner-corrected half-day costs exactly half the daily wage',
    async () => {
      must(
        await admin.from('attendance_day_overrides').insert({
          tenant_id: tenant,
          employee_id: employeeA,
          work_date: '2026-10-21',
          status: 'half_day',
          created_by: owner,
        }),
      );
      const res = await app.inject({
        method: 'POST',
        url: runsUrl,
        headers: ownerHeaders(),
        payload: { month: '2026-10' },
      });
      expect(res.statusCode).toBe(202);
      const queued = JSON.parse(res.body) as { id: string };
      const done = await awaitRun(queued.id);
      expect(done['status']).toBe('completed');

      const a = await payslipOf(employeeA, '2026-10');
      // LOP 4.0 (3.5 + the corrected half) → earnings 23,692.31; the
      // half-day LOP deduction = 538.46 = exactly half the daily wage.
      expect(a).toMatchObject({
        lop_days: '4.00',
        paid_days: '22.00',
        gross_earnings: '23692.31',
        pf_employee: '2030.77',
        net_wages: '21461.54',
      });
    },
  );

  maybeIt(
    '23-6 — the divisor conventions table: 22,413.33 / 22,509.68, then back',
    async () => {
      // The owner-corrected half-day (the previous leg) persists — LOP 4.0
      // on top of the 3.5 leave days — so these rows price paid = divisor − 4.
      for (const [convention, expectedNet, expectedPf] of [
        ['fixed-30', '21986.66', '2080.00'],
        ['calendar', '22096.77', '2090.32'],
      ] as const) {
        const put = await app.inject({
          method: 'PUT',
          url: '/api/v1/payroll/calendar',
          headers: ownerHeaders(),
          payload: {
            effectiveFrom: '2026-10-01',
            divisorConvention: convention,
            cutoffDay: 25,
            payDate: 1,
          },
        });
        expect(put.statusCode).toBe(200);
        const run = await app.inject({
          method: 'POST',
          url: runsUrl,
          headers: ownerHeaders(),
          payload: { month: '2026-10' },
        });
        expect(run.statusCode).toBe(202);
        const queued = JSON.parse(run.body) as { id: string };
        const done = await awaitRun(queued.id);
        expect(done['status']).toBe('completed');
        const a = await payslipOf(employeeA, '2026-10');
        expect(a).toMatchObject({
          divisor_convention: convention,
          net_wages: expectedNet,
          pf_employee: expectedPf,
        });
      }
      // Restore the fixture base.
      const restore = await app.inject({
        method: 'PUT',
        url: '/api/v1/payroll/calendar',
        headers: ownerHeaders(),
        payload: {
          effectiveFrom: '2026-10-01',
          divisorConvention: 'fixed-26',
          cutoffDay: 25,
          payDate: 1,
        },
      });
      expect(restore.statusCode).toBe(200);
    },
  );

  maybeIt(
    '23-6 — the zero-employee company completes with no_employees and zero payslips',
    async () => {
      const strangerHeaders = () => ({
        authorization: `Bearer ${bearerFor(otherOwner)}`,
      });
      const res = await app.inject({
        method: 'POST',
        url: runsUrl,
        headers: strangerHeaders(),
        payload: { month: '2026-10' },
      });
      expect(res.statusCode).toBe(202);
      const queued = JSON.parse(res.body) as { id: string };
      const done = await awaitRun(queued.id, strangerHeaders());
      expect(done.status).toBe('completed');
      expect((done.summary ?? {})['status']).toBe('no_employees');
      expect(await payslipCount('2026-10', otherTenant)).toBe(0);
    },
  );

  maybeIt(
    '23-6 — the pf override lands through a run; the failed run is atomic and retryable',
    async () => {
      // The pf_employee override (the TDS one is the D leg): B pays ₹1,000
      // of PF instead of the computed 1,107.69 — employer share mirrors it.
      const pfOverride = await app.inject({
        method: 'PUT',
        url: `/api/v1/payroll/employees/${empB}/run-override`,
        headers: ownerHeaders(),
        payload: {
          month: '2026-10',
          field: 'pf_employee',
          amount: '1000.00',
          acknowledgedLiability: true,
        },
      });
      expect(pfOverride.statusCode).toBe(200);
      // A bad field is refused by the wire contract.
      const badField = await app.inject({
        method: 'PUT',
        url: `/api/v1/payroll/employees/${empB}/run-override`,
        headers: ownerHeaders(),
        payload: {
          month: '2026-10',
          field: 'esi',
          amount: '1.00',
          acknowledgedLiability: true,
        },
      });
      expect(badField.statusCode).toBe(422);

      const run = await app.inject({
        method: 'POST',
        url: runsUrl,
        headers: ownerHeaders(),
        payload: { month: '2026-10' },
      });
      expect(run.statusCode).toBe(202);
      const queued = JSON.parse(run.body) as { id: string };
      const done = await awaitRun(queued.id);
      expect(done['status']).toBe('completed');
      const b = await payslipOf(empB, '2026-10');
      expect(b).toMatchObject({
        pf_employee: '1000.00',
        pf_employer: '1000.00',
      });

      // THE FAILED PATH: corrupt A's November structure (its formula cites
      // a component outside the library) → the run fails AFTER the compute
      // with ZERO payslip changes, the error is plain English, and a clean
      // re-run completes.
      const before = await payslipOf(employeeA, '2026-11');
      const { rows: novStruct } = await pool.query<{ id: string }>(
        `select s.id from public.salary_structures s
           join public.memberships m on m.id = s.membership_id
          where s.tenant_id = $1 and m.user_id = $2
            and s.effective_from = '2026-11-01'`,
        [tenant, employeeA],
      );
      must(
        await admin
          .from('salary_structures')
          .update({
            lines: [
              {
                componentId: basicComp.id,
                formula: {
                  kind: 'component',
                  componentId: '99999999-9999-4999-8999-999999999999',
                },
              },
            ],
          })
          .eq('id', novStruct[0].id),
      );
      const failing = await app.inject({
        method: 'POST',
        url: runsUrl,
        headers: ownerHeaders(),
        payload: { month: '2026-11' },
      });
      expect(failing.statusCode).toBe(202);
      const failingId = (JSON.parse(failing.body) as { id: string }).id;
      const failedRun = await awaitRun(failingId);
      expect(failedRun['status']).toBe('failed');
      expect(failedRun['errorMessage']).toContain('no longer evaluates');

      // Atomicity: the previous run's payslip is byte-identical.
      const after = await payslipOf(employeeA, '2026-11');
      expect(after['net_wages']).toBe(before['net_wages']);
      expect(after['slip_number']).toBe(before['slip_number']);

      // Repair and retry: the failed run is terminal, the re-run completes.
      must(
        await admin
          .from('salary_structures')
          .update({
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
          })
          .eq('id', novStruct[0].id),
      );
      const retry = await app.inject({
        method: 'POST',
        url: runsUrl,
        headers: ownerHeaders(),
        payload: { month: '2026-11' },
      });
      expect(retry.statusCode).toBe(202);
      const retryId = (JSON.parse(retry.body) as { id: string }).id;
      expect((await awaitRun(retryId))['status']).toBe('completed');

      // The runs list answers newest-first; another company's run is 404.
      const list = await app.inject({
        method: 'GET',
        url: runsUrl,
        headers: ownerHeaders(),
      });
      expect(list.statusCode).toBe(200);
      const runs = JSON.parse(list.body) as Array<{ month: string }>;
      expect(runs.length).toBeGreaterThan(3);
      const foreign = await app.inject({
        method: 'GET',
        url: `${runsUrl}/${queued.id}`,
        headers: { authorization: `Bearer ${bearerFor(otherOwner)}` },
      });
      expect(foreign.statusCode).toBe(404);
    },
  );

  maybeIt(
    '23-6 — the rejections refuse in plain English and leave zero payslips',
    async () => {
      const beforeBound = await app.inject({
        method: 'POST',
        url: runsUrl,
        headers: ownerHeaders(),
        payload: { month: '2026-08' },
      });
      expect(beforeBound.statusCode).toBe(422);
      expect(beforeBound.body).toContain('2026-09');
      expect(beforeBound.body).toContain('no payroll history');

      const future = await app.inject({
        method: 'POST',
        url: runsUrl,
        headers: ownerHeaders(),
        payload: { month: '2026-12' },
      });
      expect(future.statusCode).toBe(422);
      expect(future.body).toContain('has not started yet');

      for (const month of ['2026-08', '2026-12']) {
        expect(await payslipCount(month)).toBe(0);
      }
      const bad = await app.inject({
        method: 'POST',
        url: runsUrl,
        headers: ownerHeaders(),
        payload: { month: 'october' },
      });
      expect(bad.statusCode).toBe(422);
      expect(bad.body).toContain('YYYY-MM');

      // An employee token is 403 on the whole run surface.
      const forbidden = await app.inject({
        method: 'GET',
        url: runsUrl,
        headers: { authorization: `Bearer ${bearerFor(employeeA)}` },
      });
      expect(forbidden.statusCode).toBe(403);
    },
  );

  maybeIt(
    '23-7 — a month with no completed run cannot be locked (run payroll first)',
    async () => {
      // Never ran: 2026-07 has no runs at all.
      const neverRan = await app.inject({
        method: 'POST',
        url: '/api/v1/payroll/months/2026-07/lock',
        headers: ownerHeaders(),
      });
      expect(neverRan.statusCode).toBe(409);
      expect(neverRan.body).toContain('PAYROLL_MONTH_NOT_RUN');
      expect(neverRan.body).toContain('run payroll first');

      // Failed-only: a failed run row is still zero payslips — the same
      // refusal, never a lock over nothing.
      must(
        await admin.from('payroll_runs').insert({
          tenant_id: tenant,
          month: '2026-07',
          status: 'failed',
          initiated_by: owner,
          error_message: 'fixture: the executor died',
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
        }),
      );
      const failedOnly = await app.inject({
        method: 'POST',
        url: '/api/v1/payroll/months/2026-07/lock',
        headers: ownerHeaders(),
      });
      expect(failedOnly.statusCode).toBe(409);
      expect(failedOnly.body).toContain('PAYROLL_MONTH_NOT_RUN');
      expect(await payslipCount('2026-07')).toBe(0);

      // A bad month key is the 422, before any read.
      const badKey = await app.inject({
        method: 'POST',
        url: '/api/v1/payroll/months/october/lock',
        headers: ownerHeaders(),
      });
      expect(badKey.statusCode).toBe(422);
      expect(badKey.body).toContain('YYYY-MM');
    },
  );

  maybeIt(
    '23-7 — October locks: the confirmation, the status flip, and every refusal',
    async () => {
      const before = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/months/2026-10',
        headers: ownerHeaders(),
      });
      expect(before.statusCode).toBe(200);
      expect((JSON.parse(before.body) as { locked: boolean }).locked).toBe(
        false,
      );

      const lock = await app.inject({
        method: 'POST',
        url: '/api/v1/payroll/months/2026-10/lock',
        headers: ownerHeaders(),
      });
      expect(lock.statusCode).toBe(200);
      const lockBody = JSON.parse(lock.body) as {
        month: string;
        lockedBy: string;
        confirmation: Record<string, unknown>;
      };
      expect(lockBody.month).toBe('2026-10');
      expect(lockBody.lockedBy).toBe(owner);
      expect(String(lockBody.confirmation['statement'])).toContain('2026-10');
      expect(String(lockBody.confirmation['permanence'])).toContain(
        'cannot be undone',
      );
      expect(String(lockBody.confirmation['remedy'])).toContain('off-cycle');
      expect(lockBody.confirmation['stagedOffCycleLines']).toBe(0);

      // The readback: the lock row (API + DB) and the month-status flip.
      const readback = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/months/2026-10/lock',
        headers: ownerHeaders(),
      });
      expect(readback.statusCode).toBe(200);
      expect(JSON.parse(readback.body)).toMatchObject({
        month: '2026-10',
        lockedBy: owner,
      });
      const { rows: lockRows } = await pool.query(
        `select month, locked_by from public.payroll_month_locks
          where tenant_id = $1 and month = '2026-10'`,
        [tenant],
      );
      expect(lockRows).toHaveLength(1);
      const statusAfter = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/months/2026-10',
        headers: ownerHeaders(),
      });
      expect((JSON.parse(statusAfter.body) as { locked: boolean }).locked).toBe(
        true,
      );

      // An unlocked month has no lock row — a plain 404.
      const unlocked = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/months/2026-11/lock',
        headers: ownerHeaders(),
      });
      expect(unlocked.statusCode).toBe(404);

      // Re-lock is a 409 naming the permanence — never a silent rewrite.
      const slipsBefore = await payslipCount('2026-10');
      const relock = await app.inject({
        method: 'POST',
        url: '/api/v1/payroll/months/2026-10/lock',
        headers: ownerHeaders(),
      });
      expect(relock.statusCode).toBe(409);
      expect(relock.body).toContain('PAYROLL_MONTH_LOCKED');
      expect(relock.body).toContain('cannot be undone');

      // Re-running a locked month is refused and touches zero payslips.
      const rerun = await app.inject({
        method: 'POST',
        url: runsUrl,
        headers: ownerHeaders(),
        payload: { month: '2026-10' },
      });
      expect(rerun.statusCode).toBe(409);
      expect(rerun.body).toContain('PAYROLL_MONTH_LOCKED');
      expect(await payslipCount('2026-10')).toBe(slipsBefore);

      // A run override on a locked month is refused too — the month cannot
      // re-run, so the override could never take effect.
      const lockedOverride = await app.inject({
        method: 'PUT',
        url: `/api/v1/payroll/employees/${employeeA}/run-override`,
        headers: ownerHeaders(),
        payload: {
          month: '2026-10',
          field: 'pf_employee',
          amount: '1000',
          acknowledgedLiability: true,
        },
      });
      expect(lockedOverride.statusCode).toBe(409);
      expect(lockedOverride.body).toContain('PAYROLL_MONTH_LOCKED');
    },
  );

  maybeIt(
    '23-7 — the attendance boundary: owned dates freeze, post-cut-off stay live',
    async () => {
      const correct = (workDate: string) =>
        app.inject({
          method: 'PUT',
          url: `/api/v1/attendance/corrections/${employeeA}/${workDate}`,
          headers: ownerHeaders(),
          payload: { status: 'absent', note: 'payroll lock boundary probe' },
        });

      // Oct 20 is on/before October's resolved cut-off and October is
      // locked — the correction is refused, naming the boundary. The
      // resolved cut-off here is 25: the 23-6 fixture base re-established
      // the Oct-1 row at fixed-26/cut-off 25 (the 23-4 leg's 22 was
      // overwritten), so the gate must name THAT number.
      const frozen = await correct('2026-10-20');
      expect(frozen.statusCode).toBe(409);
      expect(frozen.body).toContain('PAYROLL_MONTH_LOCKED');
      expect(frozen.body).toContain('day-25');

      // DELETE freezes identically through the same gate.
      const frozenDelete = await app.inject({
        method: 'DELETE',
        url: `/api/v1/attendance/corrections/${employeeA}/2026-10-20`,
        headers: ownerHeaders(),
      });
      expect(frozenDelete.statusCode).toBe(409);
      expect(frozenDelete.body).toContain('PAYROLL_MONTH_LOCKED');

      // Oct 27 is post-cut-off — owned by November's run, still editable
      // while November is unlocked.
      const live = await correct('2026-10-27');
      expect(live.statusCode).toBe(200);

      // November's run consumes the Oct-27 day (prior-period LOP) and
      // completes even with October locked.
      const nov = await app.inject({
        method: 'POST',
        url: runsUrl,
        headers: ownerHeaders(),
        payload: { month: '2026-11' },
      });
      expect(nov.statusCode).toBe(202);
      const novId = (JSON.parse(nov.body) as { id: string }).id;
      expect((await awaitRun(novId))['status']).toBe('completed');

      // November locks; now it owns Oct 27 permanently.
      const novLock = await app.inject({
        method: 'POST',
        url: '/api/v1/payroll/months/2026-11/lock',
        headers: ownerHeaders(),
      });
      expect(novLock.statusCode).toBe(200);

      const nowFrozen = await correct('2026-10-27');
      expect(nowFrozen.statusCode).toBe(409);
      expect(nowFrozen.body).toContain('PAYROLL_MONTH_LOCKED');
      expect(nowFrozen.body).toContain(
        '2026-11 is locked for payroll and owns 2026-10-27',
      );

      // November's own pre-cut-off dates freeze with it.
      const ownFrozen = await correct('2026-11-10');
      expect(ownFrozen.statusCode).toBe(409);
      expect(ownFrozen.body).toContain('2026-11 is locked');

      // DELETE freezes identically — a removal is an edit of final payslip
      // input too, through the same gate.
      const frozenDeleteOwned = await app.inject({
        method: 'DELETE',
        url: `/api/v1/attendance/corrections/${employeeA}/2026-10-27`,
        headers: ownerHeaders(),
      });
      expect(frozenDeleteOwned.statusCode).toBe(409);
      expect(frozenDeleteOwned.body).toContain('PAYROLL_MONTH_LOCKED');
    },
  );

  maybeIt(
    '23-7 — the audit trail reads back newest-first, payroll-scoped, tenant-scoped',
    async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/audit',
        headers: ownerHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const entries = JSON.parse(res.body) as Array<{
        id: string;
        createdAt: string;
        actorId: string;
        action: string;
        targetUserId: string | null;
        details: Record<string, unknown>;
      }>;
      expect(entries.length).toBeGreaterThan(0);
      // Only payroll actions, newest first.
      for (const entry of entries) {
        expect(entry.action).toMatch(/^payroll\./);
      }
      for (let i = 1; i < entries.length; i += 1) {
        expect(
          new Date(entries[i - 1].createdAt).getTime(),
        ).toBeGreaterThanOrEqual(new Date(entries[i].createdAt).getTime());
      }
      // The newest payroll write is the November lock; both locks are here.
      expect(entries[0]['action']).toBe('payroll.month_locked');
      const months = entries
        .filter((e) => e.action === 'payroll.month_locked')
        .map((e) => e.details['month']);
      expect(months).toEqual(expect.arrayContaining(['2026-10', '2026-11']));
      expect(await payrollAuditCount('payroll.month_locked')).toBe(2);
      expect(
        entries
          .filter((e) => e.action === 'payroll.month_locked')
          .every((e) => e.actorId === owner),
      ).toBe(true);

      // Another company's trail carries none of this company's locks.
      const foreign = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/audit',
        headers: { authorization: `Bearer ${bearerFor(otherOwner)}` },
      });
      expect(foreign.statusCode).toBe(200);
      const foreignEntries = JSON.parse(foreign.body) as Array<{
        action: string;
        details: Record<string, unknown>;
      }>;
      // The whole payroll scope is tenant-scoped, not just the locks: zero
      // of this company's rows leak across the tenant line. The stranger
      // carries only the rows their OWN legs wrote — two calendar saves
      // (the 23-4 cross-tenant revisions) and the zero-employee run — so
      // anything outside that set is a leak.
      expect(
        foreignEntries.some((e) => e.action === 'payroll.month_locked'),
      ).toBe(false);
      for (const entry of foreignEntries.filter((e) =>
        e.action.startsWith('payroll.'),
      )) {
        expect(['payroll.calendar_saved', 'payroll.run_completed']).toContain(
          entry.action,
        );
        if (entry.action === 'payroll.run_completed') {
          expect(entry.details['payslips']).toBe(0);
        }
      }

      // An employee token is 403 on the trail.
      const forbidden = await app.inject({
        method: 'GET',
        url: '/api/v1/payroll/audit',
        headers: { authorization: `Bearer ${bearerFor(employeeA)}` },
      });
      expect(forbidden.statusCode).toBe(403);
    },
  );
});
