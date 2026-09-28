import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

/**
 * Story 15-9 PRE-PATCH live probe — the attendance_access_state office
 * anchor (migration 20260928000001), real HTTP against the running dev
 * server + the real DB, throwaway tenant cleaned up at the end.
 * Run: bun scripts/probe-15-9-view-fix.ts   (server on :3000, or PROBE_BASE)
 *
 * The journey the integration test pins at the repository seam, driven
 * through the shipped NestJS routes: enrol BACKDATED via SQL (the API
 * clamps past start dates — only SQL can create the period_start < today
 * shape that the old anchor got wrong), reassign via HTTP, read via HTTP.
 */
const BASE = process.env['PROBE_BASE'] ?? 'http://localhost:3000/api/v1';

const TENANT = randomUUID();
const OWNER = randomUUID();
const TECH = randomUUID();
const OFFICE_B = randomUUID();
const OFFICE_C = randomUUID();
const FUTURE_START = '2027-03-01';

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
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status >= 400) {
    fail(`${label} → HTTP ${res.status}`, json);
  }
  ok(`${label} → ${res.status}`);
  return json ?? {};
}

/** The owner roster arrives as a bare JSON array. */
function techRow(roster: Record<string, unknown>): Record<string, unknown> {
  const rows = (Array.isArray(roster) ? roster : roster.data) as
    | Array<Record<string, unknown>>
    | undefined;
  const row = rows?.find((r) => r.employeeId === TECH);
  if (!row) fail('roster row for probe tech not found', roster);
  return row;
}

async function main() {
  // ── fixtures (throwaway tenant; mirrors the integration suite) ──
  const must = async (sql: string, params: unknown[] = []) => {
    const r = await pool.query(sql, params);
    if (r instanceof Error) throw r;
    return r;
  };
  await must(
    `insert into public.users (id, role, status, country_code, phone_number, name)
     values ($1, 'owner', 'active', '+91', $2, '15-9 probe owner')`,
    [OWNER, `7${Date.now()}`.slice(-10) + '1'],
  );
  await must(
    `insert into public.tenants (id, owner_id, company_name, state_code)
     values ($1, $2, '15-9 view-anchor probe', 'KA')`,
    [TENANT, OWNER],
  );
  await must(`update public.users set tenant_id = $1 where id = $2`, [TENANT, OWNER]);
  await must(
    `insert into public.users (id, tenant_id, role, status, country_code, phone_number, name)
     values ($1, $2, 'technician', 'active', '+91', $3, '15-9 probe tech')`,
    [TECH, TENANT, `7${Date.now()}`.slice(-10) + '2'],
  );
  await must(
    `insert into public.attendance_offices (id, tenant_id, name, latitude, longitude, radius_m)
     values ($1, $2, 'probe office B', 12.98, 77.6, 100), ($3, $2, 'probe office C', 12.99, 77.61, 100)`,
    [OFFICE_B, TENANT, OFFICE_C],
  );
  await must(
    `insert into public.attendance_settings (tenant_id, enabled, setup_completed_at)
     values ($1, true, now())`,
    [TENANT],
  );

  const todayRow = await must(`select public.attendance_today($1)::text as t`, [TENANT]);
  const today = todayRow.rows[0].t as string;
  const past = await must(`select (public.attendance_today($1) - 3)::text as d`, [TENANT]);
  const pastStart = past.rows[0].d as string;

  // The shape the API cannot create (past dates are clamped): a BACKDATED
  // period — the exact case the old period_start anchor got wrong. Both
  // tables in ONE transaction: statement-by-statement autocommit would
  // trip the coverage guard on the unpaired assignment.
  const tx = await pool.connect();
  try {
    await tx.query('begin');
    await tx.query(
      `insert into public.attendance_office_assignments (tenant_id, employee_id, office_id, valid)
       values ($1, $2, $3, daterange($4, null, '[)'))`,
      [TENANT, TECH, OFFICE_B, pastStart],
    );
    await tx.query(
      `insert into public.attendance_enrolments (tenant_id, employee_id, valid)
       values ($1, $2, daterange($3, null, '[)'))`,
      [TENANT, TECH, pastStart],
    );
    await tx.query('commit');
  } catch (err) {
    await tx.query('rollback');
    throw err;
  } finally {
    tx.release();
  }
  ok(`backdated period seeded: [${pastStart},∞) at office B (today=${today})`);

  const secret = process.env['SUPABASE_JWT_SECRET']!;
  const ownerJwt = jwt.sign({ sub: OWNER, tenantId: TENANT, role: 'owner' }, secret);

  // ── the journey ──
  const pre = techRow(await call('GET roster (pre-reassign)', 'GET', '/attendance/enrolments', ownerJwt));
  if (pre.officeId !== OFFICE_B) fail('pre-reassign office should be B', pre.officeId);
  ok(`roster reads office B (the backdated period's office), start ${pre.attendanceStartDate}`);

  const put1 = await call(
    'PUT reassign → office C effective today',
    'PUT',
    `/attendance/enrolments/${TECH}/office`,
    ownerJwt,
    { officeId: OFFICE_C, effectiveFrom: today },
  );
  if (put1.officeId !== OFFICE_C) fail('write response should already carry office C (today anchor)', put1);
  ok('write response carries the NEW office (post-write access state)');

  const post = techRow(await call('GET roster (post-reassign)', 'GET', '/attendance/enrolments', ownerJwt));
  // THE regression assertion: the shipped view returned office B here forever.
  if (post.officeId !== OFFICE_C) fail('REGRESSION: roster still reads the OLD office after reassign', post.officeId);
  ok('roster reads office C after reassign (today anchor) — the shipped view failed this step');

  await call(
    `PUT scheduled move → office B effective ${FUTURE_START}`,
    'PUT',
    `/attendance/enrolments/${TECH}/office`,
    ownerJwt,
    { officeId: OFFICE_B, effectiveFrom: FUTURE_START },
  );
  const scheduled = techRow(await call('GET roster (scheduled move)', 'GET', '/attendance/enrolments', ownerJwt));
  if (scheduled.officeId !== OFFICE_C) fail('scheduled future move must stay invisible until it takes effect', scheduled.officeId);
  ok('scheduled future move is invisible to reads (still office C) — FR-6 "Thane from 1 Nov" semantics');

  console.log(`\nALL ${step} PROBE STEPS GREEN`);
}

main()
  .catch((err) => {
    console.error('PROBE FAILED', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Cleanup in ONE transaction, assignments before enrolments: each
    // pool.query autocommits, and an unpaired-enrolment intermediate state
    // trips the deferred coverage guard (the mirror of the fixture rule).
    const tx = await pool.connect();
    try {
      await tx.query('begin');
      await tx.query(`delete from public.notifications where tenant_id = $1`, [TENANT]);
      await tx.query(`delete from public.attendance_office_assignments where tenant_id = $1`, [TENANT]);
      await tx.query(`delete from public.attendance_enrolments where tenant_id = $1`, [TENANT]);
      await tx.query(`delete from public.attendance_onboarding where employee_id in (select id from public.users where tenant_id = $1)`, [TENANT]);
      await tx.query(`delete from public.attendance_setup_progress where tenant_id = $1`, [TENANT]);
      await tx.query(`delete from public.attendance_settings where tenant_id = $1`, [TENANT]);
      await tx.query(`delete from public.attendance_offices where tenant_id = $1`, [TENANT]);
      await tx.query(`delete from public.tenants where id = $1`, [TENANT]);
      await tx.query(`delete from public.users where id = any($1::uuid[])`, [[OWNER, TECH]]);
      await tx.query('commit');
      console.log('cleanup complete (throwaway tenant removed)');
    } catch (err) {
      await tx.query('rollback');
      console.error(`CLEANUP ERROR — tenant ${TENANT} may need manual removal`, err);
    } finally {
      tx.release();
      await pool.end();
    }
  });
