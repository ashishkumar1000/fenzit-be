import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

/**
 * Story 15-10 live probe — GET /attendance/me/summary, real HTTP against
 * the running dev server + the real DB, throwaway tenant cleaned up at the
 * end. Run: bun scripts/probe-15-10-me-summary.ts   (server on :3000, or
 * PROBE_BASE for the production probe).
 *
 * Journey: upcoming (future-dated enrolment) → summary carries the office
 * + rule + tenant default weekly offs → owner 403 → DELETE the future
 * start → none answers honestly empty → active (SQL-seeded covering
 * period) → summary again → employee override REPLACES the default (AD-22)
 * → deleting the override restores the default.
 */
const BASE = process.env['PROBE_BASE'] ?? 'http://localhost:3000/api/v1';

const TENANT = randomUUID();
const OWNER = randomUUID();
const TECH = randomUUID();
const OFFICE = randomUUID();
const FUTURE_START_OFFSET = 7;

const pool = new Pool({
  connectionString: process.env['DATABASE_URL'],
  ssl: { rejectUnauthorized: false },
  max: 2,
});

let step = 0;
function ok(label: string, detail?: string) {
  step += 1;
  console.log(`${String(step).padStart(2, '0')}. ✓ ${label}${detail ? ` — ${detail}` : ''}`);
}
function fail(label: string, err: unknown): never {
  console.error(`${String(step + 1).padStart(2, '0')}. ✗ ${label}`);
  console.error(err);
  throw err instanceof Error ? err : new Error(String(err));
}

async function call(
  label: string,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  ok(`${label} → ${res.status}`, json ? JSON.stringify(json) : undefined);
  return { status: res.status, json: json ?? {} };
}

async function expectStatus(
  label: string,
  method: string,
  path: string,
  token: string,
  expected: number,
): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  if (res.status !== expected) {
    fail(`${label} → expected ${expected}, got ${res.status}`, await res.text().catch(() => ''));
  }
  ok(`${label} → ${res.status} (as expected)`);
}

/** The one-transaction fixture rule: paired writes only, autocommit trips the coverage guard. */
async function inTx(fn: (tx: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<void>) {
  const tx = await pool.connect();
  try {
    await tx.query('begin');
    await fn({
      query: async (sql, params = []) => {
        const r = await tx.query(sql, params);
        if (r instanceof Error) throw r;
        return r;
      },
    });
    await tx.query('commit');
  } catch (err) {
    await tx.query('rollback');
    throw err;
  } finally {
    tx.release();
  }
}

async function sqlToday(tenantId: string): Promise<string> {
  const r = await pool.query(`select public.attendance_today($1)::text as t`, [tenantId]);
  return r.rows[0].t as string;
}

async function main() {
  // ── fixtures (throwaway tenant; mirrors the 15-9 probe) ──
  await pool.query(
    `insert into public.users (id, role, status, country_code, phone_number, name)
     values ($1, 'owner', 'active', '+91', $2, '15-10 probe owner')`,
    [OWNER, `7${Date.now()}`.slice(-10) + '1'],
  );
  await pool.query(
    `insert into public.tenants (id, owner_id, company_name, state_code)
     values ($1, $2, '15-10 me-summary probe', 'KA')`,
    [TENANT, OWNER],
  );
  await pool.query(`update public.users set tenant_id = $1 where id = $2`, [TENANT, OWNER]);
  await pool.query(
    `insert into public.users (id, tenant_id, role, status, country_code, phone_number, name)
     values ($1, $2, 'technician', 'active', '+91', $3, '15-10 probe tech')`,
    [TECH, TENANT, `7${Date.now()}`.slice(-10) + '2'],
  );
  await pool.query(
    `insert into public.attendance_offices (id, tenant_id, name, latitude, longitude, radius_m)
     values ($1, $2, 'probe office', 12.98, 77.6, 100)`,
    [OFFICE, TENANT],
  );
  await pool.query(
    `insert into public.attendance_settings (tenant_id, enabled, setup_completed_at)
     values ($1, true, now())`,
    [TENANT],
  );

  const today = await sqlToday(TENANT);
  const future = new Date(`${today}T00:00:00Z`);
  future.setUTCDate(future.getUTCDate() + FUTURE_START_OFFSET);
  const futureStart = future.toISOString().slice(0, 10);

  // Office rule + Sunday default, both unbounded from a past date — visible
  // in every state the probe visits.
  await inTx(async ({ query }) => {
    await query(
      `insert into public.attendance_office_rules
         (office_id, tenant_id, valid, start_time, end_time, late_cutoff_minutes, full_day_hours, half_day_hours)
       values ($1, $2, daterange($3::date - 30, null, '[)'), '09:30', '18:00', 15, 8, 4)`,
      [OFFICE, TENANT, today],
    );
    await query(
      `insert into public.attendance_weekly_off_defaults (tenant_id, valid, days)
       values ($1, daterange($2::date - 30, null, '[)'), array[7])`,
      [TENANT, today],
    );
    // UPCOMING: future-dated enrolment + matching assignment, both tables in ONE transaction.
    await query(
      `insert into public.attendance_enrolments (tenant_id, employee_id, valid)
       values ($1, $2, daterange($3, null, '[)'))`,
      [TENANT, TECH, futureStart],
    );
    await query(
      `insert into public.attendance_office_assignments (tenant_id, employee_id, office_id, valid)
       values ($1, $2, $3, daterange($4, null, '[)'))`,
      [TENANT, TECH, OFFICE, futureStart],
    );
  });
  ok(`fixtures seeded: future period [${futureStart},∞), rule 09:30–18:00 cut-off 15, default WO [7] (today=${today})`);

  const secret = process.env['SUPABASE_JWT_SECRET']!;
  const ownerJwt = jwt.sign({ sub: OWNER, tenantId: TENANT, role: 'owner' }, secret);
  const techJwt = jwt.sign({ sub: TECH, tenantId: TENANT, role: 'technician' }, secret);

  // ── the journey ──
  const access1 = await call('GET me/access (upcoming)', 'GET', '/attendance/me/access', techJwt);
  if (access1.json.attendanceAccess !== 'upcoming') fail('access should be upcoming', access1.json);

  const sum1 = await call('GET me/summary (upcoming)', 'GET', '/attendance/me/summary', techJwt);
  const s1 = sum1.json;
  if (s1.officeId !== OFFICE || s1.startTime !== '09:30' || s1.endTime !== '18:00' || s1.lateCutOffMinutes !== 15) {
    fail('upcoming summary should carry the probe office + rule (HH:mm times)', s1);
  }
  if (JSON.stringify(s1.weeklyOffDays) !== '[7]') fail('upcoming summary weekly offs should be the tenant default [7]', s1);
  ok('upcoming summary: office + rule + tenant-default weekly offs, times HH:mm');

  await expectStatus('GET me/summary as OWNER', 'GET', '/attendance/me/summary', ownerJwt, 403);

  // None: cancelling the future start removes the rows outright (AD-8).
  await call('DELETE future start (owner)', 'DELETE', `/attendance/enrolments/${TECH}`, ownerJwt);
  const access2 = await call('GET me/access (none)', 'GET', '/attendance/me/access', techJwt);
  if (access2.json.attendanceAccess !== 'none') fail('access should be none after cancelling the future start', access2.json);
  const sum2 = await call('GET me/summary (none → honest empty)', 'GET', '/attendance/me/summary', techJwt);
  const s2 = sum2.json;
  if (s2.officeId !== null || s2.startTime !== null || JSON.stringify(s2.weeklyOffDays) !== '[]') {
    fail('none summary should be honestly empty', s2);
  }
  ok('none answers honestly empty (no fabricated office)');

  // Active: covering period seeded via SQL, both tables in ONE transaction.
  await inTx(async ({ query }) => {
    await query(
      `insert into public.attendance_enrolments (tenant_id, employee_id, valid)
       values ($1, $2, daterange($3::date, null, '[)'))`,
      [TENANT, TECH, today],
    );
    await query(
      `insert into public.attendance_office_assignments (tenant_id, employee_id, office_id, valid)
       values ($1, $2, $3, daterange($4::date, null, '[)'))`,
      [TENANT, TECH, OFFICE, today],
    );
  });
  const access3 = await call('GET me/access (active)', 'GET', '/attendance/me/access', techJwt);
  if (access3.json.attendanceAccess !== 'active') fail('access should be active', access3.json);
  const sum3 = await call('GET me/summary (active)', 'GET', '/attendance/me/summary', techJwt);
  if (sum3.json.officeId !== OFFICE || sum3.json.startTime !== '09:30') fail('active summary should carry office + rule', sum3.json);
  ok('active summary: same office + rule via the view-anchored read');

  // Override REPLACES the default (AD-22).
  await pool.query(
    `insert into public.attendance_weekly_off_overrides (tenant_id, employee_id, valid, days)
     values ($1, $2, daterange($3::date, null, '[)'), array[1])`,
    [TENANT, TECH, today],
  );
  const sum4 = await call('GET me/summary (override [1])', 'GET', '/attendance/me/summary', techJwt);
  if (JSON.stringify(sum4.json.weeklyOffDays) !== '[1]') fail('override [1] should REPLACE the default [7]', sum4.json);
  ok('employee override replaces the tenant default');

  await pool.query(`delete from public.attendance_weekly_off_overrides where tenant_id = $1`, [TENANT]);
  const sum5 = await call('GET me/summary (default resumes)', 'GET', '/attendance/me/summary', techJwt);
  if (JSON.stringify(sum5.json.weeklyOffDays) !== '[7]') fail('removing the override should restore the default [7]', sum5.json);
  ok('removing the override restores the tenant default');

  console.log(`\nALL ${step} PROBE STEPS GREEN`);
}

main()
  .catch((err) => {
    console.error('PROBE FAILED', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Cleanup in ONE transaction (assignments before enrolments; single-table
    // intermediates trip the deferred coverage guard).
    const tx = await pool.connect();
    try {
      await tx.query('begin');
      await tx.query(`delete from public.notifications where tenant_id = $1`, [TENANT]);
      await tx.query(`delete from public.attendance_office_assignments where tenant_id = $1`, [TENANT]);
      await tx.query(`delete from public.attendance_enrolments where tenant_id = $1`, [TENANT]);
      await tx.query(`delete from public.attendance_weekly_off_overrides where tenant_id = $1`, [TENANT]);
      await tx.query(`delete from public.attendance_weekly_off_defaults where tenant_id = $1`, [TENANT]);
      await tx.query(`delete from public.attendance_office_rules where tenant_id = $1`, [TENANT]);
      await tx.query(`delete from public.attendance_onboarding where tenant_id = $1`, [TENANT]);
      await tx.query(`delete from public.attendance_offices where tenant_id = $1`, [TENANT]);
      await tx.query(`delete from public.attendance_setup_progress where tenant_id = $1`, [TENANT]);
      await tx.query(`delete from public.attendance_settings where tenant_id = $1`, [TENANT]);
      await tx.query(`delete from public.users where tenant_id = $1 or id = $2 or id = $3`, [TENANT, OWNER, TECH]);
      await tx.query(`delete from public.tenants where id = $1`, [TENANT]);
      await tx.query('commit');
      console.log('cleanup committed (throwaway tenant removed)');
    } catch (err) {
      await tx.query('rollback');
      console.error('CLEANUP FAILED — throwaway tenant', TENANT, 'left behind', err);
    } finally {
      tx.release();
      await pool.end();
    }
  });
