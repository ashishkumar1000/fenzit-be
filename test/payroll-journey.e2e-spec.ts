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
});
