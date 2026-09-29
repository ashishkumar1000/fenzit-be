import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

/**
 * Story 16-4 live probe — the GET /attendance/me/summary Today extension
 * (officeLatitude/Longitude, today facts, todayRecord), real HTTP against
 * the running dev server + the real DB, throwaway tenant cleaned up at the
 * end. Run: bun scripts/probe-16-4-summary-today.ts   (server on :3000, or
 * PROBE_BASE for the production probe).
 *
 * Journey: active (facts on a plain working day, pin present, record null)
 * → holiday today flips isHoliday/isWorkingDay → weekly-off override flips
 * isWeeklyOff → open record (late grade vs the rule, offset instant) →
 * closed record (workedMinutes + earlyCheckout) → upcoming answers nulls →
 * none answers the honest empty → owner 403.
 */
const BASE = process.env['PROBE_BASE'] ?? 'http://localhost:3000/api/v1';

const TENANT = randomUUID();
const OWNER = randomUUID();
const TECH = randomUUID();
const UPCOMING = randomUUID();
const NONE_TECH = randomUUID();
const OFFICE = randomUUID();

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
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  ok(`${label} → ${res.status}`, json ? JSON.stringify(json) : undefined);
  return { status: res.status, json: json ?? {} };
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
  const today = await sqlToday(TENANT).catch(() => {
    // attendance_today needs the tenant row; resolve after seeding instead.
    return '';
  });

  // ── fixtures (throwaway tenant) ──
  await pool.query(
    `insert into public.users (id, role, status, country_code, phone_number, name)
     values ($1, 'owner', 'active', '+91', $2, '16-4 probe owner')`,
    [OWNER, `7${Date.now()}`.slice(-10) + '1'],
  );
  await pool.query(
    `insert into public.tenants (id, owner_id, company_name, state_code, timezone)
     values ($1, $2, '16-4 summary today probe', 'KA', 'Asia/Kolkata')`,
    [TENANT, OWNER],
  );
  await pool.query(`update public.users set tenant_id = $1 where id = $2`, [TENANT, OWNER]);
  for (const [id, name, phoneSuffix] of [
    [TECH, '16-4 probe tech', '2'],
    [UPCOMING, '16-4 probe upcoming', '3'],
    [NONE_TECH, '16-4 probe none', '4'],
  ] as const) {
    await pool.query(
      `insert into public.users (id, tenant_id, role, status, country_code, phone_number, name)
       values ($1, $2, 'technician', 'active', '+91', $3, $4)`,
      [id, TENANT, `7${Date.now()}`.slice(-10) + phoneSuffix, name],
    );
  }
  await pool.query(
    `insert into public.attendance_offices (id, tenant_id, name, latitude, longitude, radius_m)
     values ($1, $2, 'Probe Office', 19.076, 72.8777, 100)`,
    [OFFICE, TENANT],
  );
  await pool.query(
    `insert into public.attendance_settings (tenant_id, enabled, setup_completed_at)
     values ($1, true, now())`,
    [TENANT],
  );
  // Rule 09:30–18:00 cut-off 15 from 2026-01-01 → late 10:22 = 37.
  await pool.query(
    `insert into public.attendance_office_rules
       (tenant_id, office_id, valid, full_day_hours, half_day_hours, start_time, end_time, late_cutoff_minutes)
     values ($1, $2, '[2026-01-01,)', 8, 4, '09:30:00', '18:00:00', 15)`,
    [TENANT, OFFICE],
  );
  // Active + upcoming + none enrolments/assignments (paired, one tx).
  await inTx(async (tx) => {
    await tx.query(
      `insert into public.attendance_enrolments (tenant_id, employee_id, valid)
       values ($1, $2, '[2026-01-01,)')`,
      [TENANT, TECH],
    );
    await tx.query(
      `insert into public.attendance_office_assignments (tenant_id, employee_id, office_id, valid)
       values ($1, $2, $3, '[2026-01-01,)')`,
      [TENANT, TECH, OFFICE],
    );
    await tx.query(
      `insert into public.attendance_enrolments (tenant_id, employee_id, valid)
       values ($1, $2, '[2027-01-01,)')`,
      [TENANT, UPCOMING],
    );
    await tx.query(
      `insert into public.attendance_office_assignments (tenant_id, employee_id, office_id, valid)
       values ($1, $2, $3, '[2027-01-01,)')`,
      [TENANT, UPCOMING, OFFICE],
    );
  });

  const secret = process.env['SUPABASE_JWT_SECRET']!;
  const ownerJwt = jwt.sign({ sub: OWNER, tenantId: TENANT, role: 'owner' }, secret);
  const techJwt = jwt.sign({ sub: TECH, tenantId: TENANT, role: 'technician' }, secret);
  const upcomingJwt = jwt.sign({ sub: UPCOMING, tenantId: TENANT, role: 'technician' }, secret);
  const noneJwt = jwt.sign({ sub: NONE_TECH, tenantId: TENANT, role: 'technician' }, secret);

  const probeToday = await sqlToday(TENANT);
  ok(`fixtures seeded (today=${probeToday}, rule 09:30–18:00 cut-off 15)`);

  // 01 — plain working day: facts true working day, pin present, record null.
  {
    const { json } = await call('01 active summary (no record)', 'GET', '/attendance/me/summary', techJwt);
    const today0 = json['today'] as Record<string, unknown> | null;
    if (
      !today0 ||
      today0['date'] !== probeToday ||
      today0['isWeeklyOff'] !== false ||
      today0['isHoliday'] !== false ||
      today0['holidayName'] !== null ||
      today0['isWorkingDay'] !== true
    ) {
      fail('01 today facts wrong', today0);
    }
    if (json['officeLatitude'] !== 19.076 || json['officeLongitude'] !== 72.8777) {
      fail('01 office pin wrong', json);
    }
    if (json['todayRecord'] !== null) fail('01 todayRecord must be null', json);
    ok('01 facts + pin + null record correct');
  }

  // 02 — holiday today.
  await pool.query(
    `insert into public.holidays (tenant_id, holiday_date, name) values ($1, $2, 'Probe Holiday')`,
    [TENANT, probeToday],
  );
  {
    const { json } = await call('02 summary with holiday', 'GET', '/attendance/me/summary', techJwt);
    const t = json['today'] as Record<string, unknown>;
    if (t['isHoliday'] !== true || t['holidayName'] !== 'Probe Holiday' || t['isWorkingDay'] !== false) {
      fail('02 holiday facts wrong', t);
    }
  }
  await pool.query(`delete from public.holidays where tenant_id = $1 and holiday_date = $2`, [TENANT, probeToday]);
  ok('02 holiday flipped the facts; removed');

  // 03 — weekly-off override covering today.
  await inTx(async (tx) => {
    await tx.query(
      `insert into public.attendance_weekly_off_overrides (tenant_id, employee_id, valid, days)
       values ($1, $2, '[2026-01-01,)', (select array[extract(isodow from $3::date)::int]))`,
      [TENANT, TECH, probeToday],
    );
  });
  {
    const { json } = await call('03 summary with weekly-off override', 'GET', '/attendance/me/summary', techJwt);
    const t = json['today'] as Record<string, unknown>;
    if (t['isWeeklyOff'] !== true || t['isWorkingDay'] !== false) fail('03 weekly-off facts wrong', t);
  }
  await pool.query(`delete from public.attendance_weekly_off_overrides where tenant_id = $1`, [TENANT]);
  ok('03 weekly-off override flipped the facts; removed');

  // 04 — open record (check-in 10:22 IST, rule 09:30+15 → late 37).
  const attempt = randomUUID();
  await pool.query(
    `insert into public.attendance_attempts
       (id, tenant_id, employee_id, request_id, kind, outcome, attempted_at)
     values ($1, $2, $3, $4, 'check_in', 'ok', now())`,
    [attempt, TENANT, TECH, randomUUID()],
  );
  await pool.query(
    `insert into public.attendance_records
       (tenant_id, employee_id, work_date, office_id, office_rules_id, radius_m,
        checkin_at, checkin_attempt_id, checkin_lat, checkin_lng, checkin_accuracy_m,
        checkin_distance_m, checkin_mocked)
     values ($1, $2, $3::date, $4,
             (select id from public.attendance_office_rules where tenant_id = $1 limit 1),
             100,
             ($3::text || ' 10:22:00')::timestamp at time zone 'Asia/Kolkata',
             $5, 19.076, 72.8777, 12, 40, false)`,
    [TENANT, TECH, probeToday, OFFICE, attempt],
  );
  {
    const { json } = await call('04 summary with open record', 'GET', '/attendance/me/summary', techJwt);
    const rec = json['todayRecord'] as Record<string, unknown> | null;
    if (!rec) fail('04 todayRecord missing', json);
    if (rec!['checkoutAt'] !== null || rec!['workedMinutes'] !== null) fail('04 open record must have null checkout/worked', rec);
    if (rec!['lateMinutes'] !== 37 || rec!['isLate'] !== true) fail('04 late grade wrong (expect 37/true)', rec);
    if (!String(rec!['checkinAt']).endsWith('+05:30')) fail('04 instant must carry the tenant offset', rec);
  }
  ok('04 open record graded (late 37, +05:30 offset)');

  // 05 — close the record (checkout 18:05 IST → worked 463, early false).
  // The checkout-pair CHECK demands a paired checkout_attempt_id.
  const checkoutAttempt = randomUUID();
  await pool.query(
    `insert into public.attendance_attempts
       (id, tenant_id, employee_id, request_id, kind, outcome, attempted_at)
     values ($1, $2, $3, $4, 'check_out', 'ok', now())`,
    [checkoutAttempt, TENANT, TECH, randomUUID()],
  );
  await pool.query(
    `update public.attendance_records
       set checkout_at = ($2::text || ' 18:05:00')::timestamp at time zone 'Asia/Kolkata',
           checkout_attempt_id = $3
     where tenant_id = $1`,
    [TENANT, probeToday, checkoutAttempt],
  );
  {
    const { json } = await call('05 summary with closed record', 'GET', '/attendance/me/summary', techJwt);
    const rec = json['todayRecord'] as Record<string, unknown>;
    if (rec['workedMinutes'] !== 463 || rec['earlyCheckout'] !== false) {
      fail('05 closed record wrong (expect 463/false)', rec);
    }
  }
  ok('05 closed record graded (worked 463, early false)');

  // 06 — upcoming answers nulls (facts + record).
  {
    const { json } = await call('06 upcoming summary', 'GET', '/attendance/me/summary', upcomingJwt);
    if (json['today'] !== null || json['todayRecord'] !== null) fail('06 upcoming must answer null today/todayRecord', json);
  }
  ok('06 upcoming: today/todayRecord null');

  // 07 — none answers the honest empty.
  {
    const { json } = await call('07 none summary', 'GET', '/attendance/me/summary', noneJwt);
    if (json['today'] !== null || json['todayRecord'] !== null || json['officeLatitude'] !== null) {
      fail('07 none must answer the honest empty', json);
    }
  }
  ok('07 none: honest empty incl. the four new nulls');

  // 08 — owner 403.
  await call('08 owner summary (must 403)', 'GET', '/attendance/me/summary', ownerJwt)
    .then(({ status }) => {
      if (status !== 403) fail('08 expected 403', status);
    });
  ok('08 owner 403 as expected');

  // ── cleanup ──
  await pool.query(`delete from public.tenants where id = $1`, [TENANT]);
  await pool.query(`delete from public.users where id in ($1, $2)`, [OWNER, NONE_TECH]).catch(async () => {
    // none-tech has no tenant FK — cascade handles it; keep cleanup simple.
    await pool.query(`delete from public.users where id = $1`, [OWNER]);
  });
  ok('cleanup done (tenant cascade)');
  console.log(`\nALL ${step} PROBES GREEN`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('PROBE FAILED');
    console.error(err);
    process.exit(1);
  });
