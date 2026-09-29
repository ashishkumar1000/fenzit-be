/**
 * 18-1 + 18-2 real-DB journey — FR-10 grid + corrections write/read + ack.
 * This is the jest port of the same journey the shipped services make:
 * one throwaway tenant, per-date fact seeding, then the SHIPPED
 * readDayStatusGrid / CorrectionsService against the real schema — the
 * exclusion constraints, the leave seam and the cascade only exist in the
 * real DB (the e2e boundary fakes mirror them, never prove them).
 * NOTE: W5 pins the checkout-only correction to 422 (the review's D4
 * ruling — the probe's old 200 expectation was wrong about the requirement).
 *
 * Requires real credentials: gated on DATABASE_URL/SUPABASE_* being set and
 * not the jest.env.setup.ts dummies. Fixtures are self-contained (throwaway
 * tenant) and removed in afterAll (the tenant delete cascades everything).
 */
import { Pool, type PoolClient } from 'pg';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { PgPoolFactory } from '../../src/common/pg/pg-pool.factory';
import { SupabaseClientFactory } from '../../src/common/factories/supabase-client.factory';
import { readDayStatusGrid } from '../../src/attendance/day-status.read';
import {
  computeDayStatus,
  type DayStatusOutcome,
} from '../../src/attendance/day-status.model';
import { CorrectionsService } from '../../src/attendance/corrections.service';
import { buildDayContext } from '../../src/attendance/day-context.read';
import {
  findActiveOverrideDates,
} from '../../src/attendance/corrections.repository';
import { LeaveService } from '../../src/attendance/leave.service';
import { LeaveReadService } from '../../src/attendance/leave-read.service';
import { MeAttendanceService } from '../../src/attendance/me-attendance.service';
import { toTenantOffsetIso } from '../../src/attendance/check-in-out.model';
import { Role } from '../../src/common/enums/role.enum';
import type { RequestUser } from '../../src/common/interfaces/request-user.interface';

// The real-DB scaffold + a 51×32 grid read need more than jest's 5s hook cap
// (mirrors the leave integration spec).
jest.setTimeout(120_000);

const DATABASE_URL = process.env['DATABASE_URL'] ?? '';
const SUPABASE_URL = process.env['SUPABASE_URL'] ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const IS_REAL_DB =
  DATABASE_URL !== '' &&
  !DATABASE_URL.includes('test:test') &&
  SUPABASE_URL !== '' &&
  !SUPABASE_URL.includes('test.supabase.co');

const TENANT = randomUUID();
const OWNER = randomUUID();
const TECH = randomUUID();

const TZ = 'Asia/Kolkata';
/** `2026-09-28 16:45:00+05:30` — a timestamptz literal in tenant-local time. */
const ist = (date: string, hms: string): string => `${date} ${hms}+05:30`;
const dayOffset = (dateIso: string, n: number): string => {
  const [y, m, d] = dateIso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const isSunday = (dateIso: string): boolean =>
  new Date(`${dateIso}T00:00:00Z`).getUTCDay() === 0;
/** The deepest past candidate ≤ n days back that is a working (non-Sunday) date. */
const nonSundayPast = (today: string, n: number): string => {
  let k = n;
  while (isSunday(dayOffset(today, -k))) k += 1;
  return dayOffset(today, -k);
};
const nonSundayFuture = (today: string, n: number): string => {
  let k = n;
  while (isSunday(dayOffset(today, k))) k += 1;
  return dayOffset(today, k);
};
const bodyOf = (e: unknown): { error_code?: string; message?: string } =>
  (e instanceof Error && 'getResponse' in e
    ? (
        (e as import('@nestjs/common').HttpException).getResponse() as Record<string, unknown>
      )
    : {}) as { error_code?: string; message?: string };

describe('Attendance day-statuses + corrections journey (18-1/18-2, real DB)', () => {
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let pool: Pool;
  let pg: PgPoolFactory;
  let admin: SupabaseClient;
  let corrections: CorrectionsService;
  let leaveService: LeaveService;
  let leaveRead: LeaveReadService;
  /** Per-date facts rows (DayGridRow), the whole journey's read surface. */
  let grid: Awaited<ReturnType<typeof readDayStatusGrid>>;
  let today = '1970-01-01';
  let d: Record<string, string> = {};
  let tenantTimezone = TZ;
  let officeId = '';
  let ruleId = '';

  async function inTx<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    return pg.withTransaction(work);
  }

  /** The owner identity the write surface is called under. */
  const ownerUser = (): RequestUser => ({
    userId: OWNER,
    tenantId: TENANT,
    role: Role.OWNER,
    rawJwt: 'probe-jwt',
  });

  const techUser = (): RequestUser => ({
    userId: TECH,
    tenantId: TENANT,
    role: Role.TECHNICIAN,
    rawJwt: 'probe-jwt',
  });

  const tenantDelete = (): Promise<unknown> =>
    pool.query(
      `delete from public.tenants where id = $1
         or company_name like 'epic-18 integration probe%'`,
      [TENANT],
    );

  /** Every check-in needs its attempt row. */
  const seedRecord = async (
    date: string,
    checkin: string,
    checkout: string | null,
    employeeId: string = TECH,
    dateOverride: string = date,
  ): Promise<void> => {
    const attemptIn = (
      await pool.query<{ id: string }>(
        `insert into public.attendance_attempts
           (tenant_id, employee_id, request_id, kind, outcome, attempted_at, mocked)
         values ($1, $2, gen_random_uuid(), 'check_in', 'ok', $3, false) returning id`,
        [TENANT, employeeId, checkin],
      )
    ).rows[0].id;
    if (checkout === null) {
      await pool.query(
        `insert into public.attendance_records
           (tenant_id, employee_id, work_date, office_id, office_rules_id, radius_m,
            checkin_at, checkin_attempt_id, checkin_lat, checkin_lng,
            checkin_accuracy_m, checkin_distance_m, checkin_mocked)
         values ($1, $2, $3, $4, $5, 100, $6, $7, 12.97, 77.59, 10, 40, false)`,
        [TENANT, employeeId, dateOverride, officeId, ruleId, checkin, attemptIn],
      );
      return;
    }
    const attemptOut = (
      await pool.query<{ id: string }>(
        `insert into public.attendance_attempts
           (tenant_id, employee_id, request_id, kind, outcome, attempted_at, mocked)
         values ($1, $2, gen_random_uuid(), 'check_out', 'ok', $3, false) returning id`,
        [TENANT, employeeId, checkout],
      )
    ).rows[0].id;
    await pool.query(
      `insert into public.attendance_records
         (tenant_id, employee_id, work_date, office_id, office_rules_id, radius_m,
          checkin_at, checkin_attempt_id, checkin_lat, checkin_lng,
          checkin_accuracy_m, checkin_distance_m, checkin_mocked,
          checkout_at, checkout_attempt_id, checkout_lat, checkout_lng,
          checkout_accuracy_m, checkout_distance_m, checkout_mocked)
       values ($1, $2, $3, $4, $5, 100, $6, $7, 12.97, 77.59, 10, 40, false,
               $8, $9, 12.97, 77.59, 10, 40, false)`,
      [TENANT, employeeId, dateOverride, officeId, ruleId, checkin, attemptIn, checkout, attemptOut],
    );
  };

  const leaveRequest = async (
    date: string,
    part: string,
    seedState: string,
    employeeId: string = TECH,
  ): Promise<void> => {
    const id = (
      await pool.query<{ id: string }>(
        `insert into public.leave_requests
           (tenant_id, employee_id, request_id, start_date, end_date, part, reason, created_by)
         values ($1, $2, gen_random_uuid(), $3, $4, $5, 'probe leave', $6) returning id`,
        [TENANT, employeeId, date, date, part, OWNER],
      )
    ).rows[0].id;
    await pool.query(
      `insert into public.leave_request_days
         (tenant_id, leave_request_id, employee_id, leave_date, state)
       values ($1, $2, $3, $4, $5)`,
      [TENANT, id, employeeId, date, seedState],
    );
  };

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
    admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    pg = new PgPoolFactory({
      getOrThrow: (k: string) => {
        const v = process.env[k];
        if (!v) throw new Error(`missing config key ${k}`);
        return v;
      },
    } as never);
    corrections = new CorrectionsService(pg, {
      createAdmin: () => admin,
    } as unknown as SupabaseClientFactory);
    leaveService = new LeaveService(pg);
    leaveRead = new LeaveReadService(pg);

    // A seeding failure must never leave the throwaway tenant behind: the
    // delete cascades every scaffold row (review G2-P14). seedScaffold is
    // declared at describe scope BELOW — by the time beforeAll runs, the
    // describe body has finished and the binding is live.
    try {
      await seedScaffold();
    } catch (e) {
      await tenantDelete();
      throw e;
    }
  });

  const seedScaffold = async (): Promise<void> => {
    await pool.query('begin');
    await pool.query(
      `insert into public.users (id, name, role, tenant_id, status, country_code, phone_number)
       values ($1, '18-1 probe owner', 'owner', null, 'active', '+91', $2),
              ($3, '18-1 probe tech', 'technician', null, 'active', '+91', $4)`,
      [
        OWNER,
        `7${Date.now()}`.slice(-10).replace(/^./, '7') + '1',
        TECH,
        `7${Date.now()}`.slice(-10).replace(/^./, '7') + '2',
      ],
    );
    await pool.query(
      `insert into public.tenants (id, owner_id, company_name, state_code, timezone)
       values ($1, $2, $3, 'KA', $4)`,
      [TENANT, OWNER, `epic-18 integration probe ${TENANT.slice(0, 8)}`, TZ],
    );
    await pool.query(
      'update public.users set tenant_id = $1 where id = any($2::uuid[])',
      [TENANT, [OWNER, TECH]],
    );
    await pool.query(
      `insert into public.attendance_settings (tenant_id, enabled, setup_completed_at)
       values ($1, true, now())`,
      [TENANT],
    );
    officeId = (
      await pool.query<{ id: string }>(
        `insert into public.attendance_offices (tenant_id, name, latitude, longitude, radius_m)
         values ($1, 'probe office', 12.9716, 77.5946, 100) returning id`,
        [TENANT],
      )
    ).rows[0].id;
    ruleId = (
      await pool.query<{ id: string }>(
        `insert into public.attendance_office_rules
           (office_id, tenant_id, valid, start_time, end_time,
            late_cutoff_minutes, full_day_hours, half_day_hours)
         values ($1, $2, daterange(current_date - 60, current_date + 120),
                 '09:30', '18:30', 15, 8, 4) returning id`,
        [officeId, TENANT],
      )
    ).rows[0].id;
    await pool.query(
      `insert into public.attendance_office_assignments
         (tenant_id, employee_id, office_id, valid)
       values ($1, $2, $3, daterange(current_date - 60, current_date + 120))`,
      [TENANT, TECH, officeId],
    );
    await pool.query(
      `insert into public.attendance_enrolments (tenant_id, employee_id, valid, enabled_at)
       values ($1, $2, daterange(current_date - 60, current_date + 120), now() - interval '60 days')`,
      [TENANT, TECH],
    );
    await pool.query(
      `insert into public.attendance_weekly_off_defaults (tenant_id, valid, days)
       values ($1, daterange(current_date - 60, current_date + 120), '{7}'::int[])`,
      [TENANT],
    );

    // DB-clock anchors (before records/leave/overrides need them).
    tenantTimezone = (
      await pool.query<{ timezone: string }>(
        'select timezone from public.tenants where id = $1',
        [TENANT],
      )
    ).rows[0].timezone;
    const todayIso = (
      await pool.query<{ today: string }>(
        'select (now() at time zone $1)::date::text as today',
        [tenantTimezone],
      )
    ).rows[0].today;
    today = todayIso;
    const iso = (n: number) => dayOffset(todayIso, n);
    // Sunday offsets: dow 0 (Sunday) means "today" itself is one — the
    // probes then read LAST Sunday (today-7) and the one before (-14).
    const dow = new Date(`${todayIso}T00:00:00Z`).getUTCDay();
    const lastPastSunday = iso(-((dow === 0 ? 7 : dow) as number));
    const priorSunday = iso(-((dow === 0 ? 7 : dow) + 7));

    const anchors = {
      notTracked: iso(-61), // pre-enrolment → rule 2 (any weekday)
      present: nonSundayPast(todayIso, 15), // full record → rule 7 present
      half: nonSundayPast(todayIso, 14), // short record → rule 7 half_day
      leaveApproved: nonSundayPast(todayIso, 7), // approved full-day leave → rule 5
      halfLeave: nonSundayPast(todayIso, 6), // approved first half + shift → rule 6
      ckm: nonSundayPast(todayIso, 11), // past check-in only → rule 8
      absent: nonSundayPast(todayIso, 13), // nothing → rule 9
      correctedStatus: nonSundayPast(todayIso, 8), // status-only override → rule 1
      timesSub: nonSundayPast(todayIso, 1), // record + checkout override → rule 1 times
      holiday: nonSundayPast(todayIso, 4), // record on a holiday → rule 3 record arm
      sunWork: lastPastSunday, // manual check-in on a weekly off → rule 3 off-day arm
      sunOff: priorSunday, // an earlier Sunday, untouched → rule 4
      future: dayOffset(todayIso, isSunday(iso(1)) ? 2 : 1), // pending leave → marker
      leaveHoliday: nonSundayFuture(todayIso, 3), // future approved leave under a holiday (G2-P11b)
      mirror: nonSundayPast(todayIso, 3), // D2 mirror gate (G2-P1; inside the apply window)
    };
    if (new Set(Object.values(anchors)).size !== 15) {
      throw new Error(`anchor collision: ${JSON.stringify(anchors)}`);
    }
    d = anchors; // the module-level anchors, live for the seeding + its below

    await pool.query(
      `insert into public.holidays (tenant_id, holiday_date, name)
       values ($1, $2, 'probe holiday')`,
      [TENANT, d.holiday],
    );

    // ---- records (every check-in needs its attempt row) --------------------
    await seedRecord(d.present, ist(d.present, '09:25:00'), ist(d.present, '18:40:00'));
    await seedRecord(d.half, ist(d.half, '10:00:00'), ist(d.half, '15:00:00'));
    await seedRecord(d.halfLeave, ist(d.halfLeave, '09:00:00'), ist(d.halfLeave, '13:30:00'));
    await seedRecord(d.holiday, ist(d.holiday, '09:30:00'), ist(d.holiday, '18:30:00'));
    await seedRecord(d.ckm, ist(d.ckm, '09:45:00'), null);
    await seedRecord(d.timesSub, ist(d.timesSub, '10:15:00'), null);

    // ---- leave: approved full-day + approved first-half + future pending ---
    await leaveRequest(d.leaveApproved, 'full_day', 'approved');
    await leaveRequest(d.halfLeave, 'first_half', 'approved');
    await leaveRequest(d.future, 'full_day', 'pending');

    // ---- overrides: status-only + two times-only ----------------------------
    await pool.query(
      `insert into public.attendance_day_overrides
         (tenant_id, employee_id, work_date, status, created_by)
       values ($1, $2, $3, 'present', $4)`,
      [TENANT, TECH, d.correctedStatus, OWNER],
    );
    await pool.query(
      `insert into public.attendance_day_overrides
         (tenant_id, employee_id, work_date, manual_checkout_at, created_by)
       values ($1, $2, $3, $4, $5)`,
      [TENANT, TECH, d.timesSub, ist(d.timesSub, '16:45:00'), OWNER],
    );
    await pool.query(
      `insert into public.attendance_day_overrides
         (tenant_id, employee_id, work_date, manual_checkin_at, created_by)
       values ($1, $2, $3, $4, $5)`,
      [TENANT, TECH, d.sunWork, ist(d.sunWork, '10:00:00'), OWNER],
    );
    await pool.query('commit');

    grid = await inTx((tx) =>
      readDayStatusGrid(tx, TENANT, [TECH], d.notTracked, d.future),
    );
  };

  afterAll(async () => {
    if (!IS_REAL_DB) return;
    // Dropped even after an abort (never leave probe tenants behind): by id
    // plus a name-pattern net like the 15-10 probe. Children-first — every
    // non-cascading child table must be empty before the users/tenant rows
    // can go; only then does the assertion check what the tenant cascade
    // left behind. A failing step still lets the pool close (review G2-P14).
    try {
      // The leave-apply probe's notifications carry tenant_id (no cascade).
      await pool.query(
        'delete from public.notifications where tenant_id = $1 or user_id = any($2::uuid[])',
        [TENANT, [OWNER, TECH]],
      );
      await pool.query(
        'delete from public.leave_request_days where tenant_id = $1',
        [TENANT],
      );
      // leave_events RESTRICTs direct leave_requests deletes
      // (leave_events_request_fkey) — it goes before the requests.
      await pool.query(
        'delete from public.leave_events where tenant_id = $1',
        [TENANT],
      );
      await pool.query(
        'delete from public.leave_requests where tenant_id = $1',
        [TENANT],
      );
      // Attendance children hold employee/created_by references:
      // records RESTRICT attempts; enrolments + assignments must go in ONE
      // statement — the coverage trigger is immediate statement-level on
      // both tables, so separate deletes fail in either direction.
      await pool.query(
        'delete from public.attendance_corrections where tenant_id = $1',
        [TENANT],
      );
      await pool.query(
        'delete from public.attendance_day_overrides where tenant_id = $1',
        [TENANT],
      );
      await pool.query(
        'delete from public.attendance_records where tenant_id = $1',
        [TENANT],
      );
      await pool.query(
        'delete from public.attendance_attempts where tenant_id = $1',
        [TENANT],
      );
      await pool.query(
        `with gone as (
           delete from public.attendance_enrolments where tenant_id = $1 returning 1
         )
         delete from public.attendance_office_assignments where tenant_id = $1`,
        [TENANT],
      );
      // users.tenant_id is ON DELETE SET NULL — a plain id list would orphan
      // the perf test's 50 probe workers; take every user of the tenant.
      await pool.query('delete from public.users where tenant_id = $1', [
        TENANT,
      ]);
      await tenantDelete();
      const residual = await pool.query<{ n: string }>(
        `select coalesce(sum(n), 0)::text as n from (
           select count(*) n from public.attendance_day_overrides where tenant_id = $1
           union all
           select count(*) n from public.attendance_records where tenant_id = $1
           union all
           select count(*) n from public.attendance_corrections where tenant_id = $1
         ) s`,
        [TENANT],
      );
      expect(residual.rows[0].n).toBe('0');
    } finally {
      await pool.end();
    }
  });

  maybeIt('the 10-rule grid matrix grades every seeded date (FR-10)', function () {
    const byDate = new Map(grid.map((r) => [r.workDate, r]));
    const outcome = (date: string): DayStatusOutcome => {
      const row = byDate.get(date);
      if (!row) throw new Error(`no grid row for ${date}`);
      return computeDayStatus(row);
    };

    expect(outcome(d.notTracked).status).toBe('not_tracked'); // rule 2
    const present = outcome(d.present);
    expect(present.status).toBe('present');
    expect(present.daysWorked).toBe(1);
    expect(present.workedMinutes).toBe(555);
    expect(present.lateMinutes).toBe(0);
    expect(outcome(d.half)).toMatchObject({ status: 'half_day', daysWorked: 0.5 });
    expect(outcome(d.leaveApproved)).toMatchObject({
      status: 'leave',
      leaveCredit: 1,
      daysWorked: 0,
    });
    expect(outcome(d.halfLeave)).toMatchObject({
      status: 'half_day_leave',
      daysWorked: 0.5,
      leaveCredit: 0.5,
    });
    const ckm = outcome(d.ckm);
    expect(ckm.status).toBe('checkout_missing');
    expect(ckm.markers).toContain('checkout_missing');
    expect(outcome(d.absent).status).toBe('absent');
    const corrected = outcome(d.correctedStatus);
    expect(corrected.status).toBe('present');
    expect(corrected.daysWorked).toBe(1);
    expect(corrected.markers).toContain('corrected');
    const timesSub = outcome(d.timesSub);
    expect(timesSub.status).toBe('half_day');
    expect(timesSub.checkinSource).toBe('gps');
    expect(timesSub.checkoutSource).toBe('manual');
    expect(timesSub.lateMinutes).toBe(30);
    expect(timesSub.daysWorked).toBe(0.5);
    const holiday = outcome(d.holiday);
    expect(holiday.status).toBe('worked_on_holiday');
    expect(holiday.workedOnHolidayCredit).toBe(1);
    expect(holiday.workedMinutes).toBe(540);
    expect(holiday.lateMinutes).toBeNull(); // no Late/Early on off-day statuses
    const sunWork = outcome(d.sunWork);
    expect(sunWork.status).toBe('worked_on_holiday');
    expect(sunWork.workedOnHolidayCredit).toBe(0); // manual check-in stayed open
    expect(sunWork.markers).toContain('corrected');
    expect(sunWork.markers).toContain('checkout_missing');
    expect(outcome(d.sunOff).status).toBe('weekly_off'); // rule 4
    const todayIsSunday = isSunday(today);
    expect(outcome(today).status).toBe(todayIsSunday ? 'weekly_off' : 'not_checked_in_yet');
    expect(outcome(d.future)).toMatchObject({
      status: todayIsSunday ? 'weekly_off' : 'not_checked_in_yet',
    });
    expect(outcome(d.future).markers).toContain('leave_pending'); // rides the row
  });

  maybeIt('the grid ctx and buildDayContext never disagree (parity, AD-22)', async () => {
    for (const date of [d.present, d.sunOff]) {
      const ctx = await inTx((tx) => buildDayContext(tx, TENANT, TECH, date, false));
      const row = grid.find((r) => r.workDate === date)!;
      expect(JSON.stringify({ ...ctx })).toBe(JSON.stringify({ ...row.ctx }));
    }
  });

  maybeIt('FR-10 completeness — every date once, and no day double-credits (review G2-P2)', () => {
    // The whole grid range: one row per calendar date, no gaps.
    const spanDays =
      (Date.parse(d.future) - Date.parse(d.notTracked)) / 86_400_000 + 1;
    expect(grid).toHaveLength(spanDays);
    expect(new Set(grid.map((r) => r.workDate)).size).toBe(grid.length);
    // Within the tracked window no date may fall out of the engine with a
    // not_tracked verdict, and no day may bank both a worked AND a leave
    // credit beyond the single credit a day can carry.
    let sawNotTracked = 0;
    for (const row of grid) {
      const outcome = computeDayStatus(row);
      const credited = outcome.daysWorked + outcome.leaveCredit;
      // Half-day leave can earn 0.5 + 0.5; nothing can cross 1.0 per day.
      expect(credited).toBeLessThanOrEqual(1 + 1e-9);
      expect(outcome.daysWorked).toBeGreaterThanOrEqual(0);
      expect(outcome.leaveCredit).toBeGreaterThanOrEqual(0);
      if (outcome.status === 'not_tracked') {
        sawNotTracked += 1;
        // Not-tracked days all sit BEFORE the seeded working window: the
        // pre-enrolment gap, plus the FR-2 enable-day (enabled_at = now()
        // - 60 days has no check-in → the grace blocks that day too).
        expect(Date.parse(row.workDate)).toBeLessThan(Date.parse(d.present));
      }
    }
    expect(sawNotTracked).toBeGreaterThanOrEqual(1);
  });

  maybeIt('W1 — a status correction grades live, removes cleanly and restores the record (FR-21)', async () => {
    const putRes = await corrections.put(
      ownerUser() as never, TECH, d.present, { status: 'absent' }, 'probe correction',
    );
    expect(putRes.override).toEqual({
      status: 'absent',
      checkinAt: null,
      checkoutAt: null,
    });
    const freshOutcome = async (date: string): Promise<DayStatusOutcome> => {
      const rows = await inTx((tx) => readDayStatusGrid(tx, TENANT, [TECH], date, date));
      return computeDayStatus(rows[0]!);
    };
    const after = await freshOutcome(d.present);
    expect(after.status).toBe('absent');
    expect(after.daysWorked).toBe(0);
    expect(after.markers).toContain('corrected');
    const removed = await corrections.remove(ownerUser() as never, TECH, d.present);
    expect(removed).toEqual({ deleted: true });
    const restored = await freshOutcome(d.present);
    expect(restored.status).toBe('present');
    expect(restored.daysWorked).toBe(1);
    const retry = await corrections.remove(ownerUser() as never, TECH, d.present);
    expect(retry).toEqual({ deleted: false });
    // The audit chain holds BOTH rows, newest first.
    const page = await corrections.listOwner(ownerUser() as never, TECH, {
      workDate: d.present,
    });
    expect(page.data).toHaveLength(2);
    expect(page.data[0].note).toBe('Removed correction');
    expect(page.data[1].newValue.status).toBe('absent');
  });

  maybeIt('W2 — a future date is 422 ATTENDANCE_FUTURE_DATE', async () => {
    try {
      await corrections.put(
        ownerUser() as never, TECH, d.future, { status: 'absent' }, 'future',
      );
      throw new Error('expected 422, got 200');
    } catch (e) {
      expect(bodyOf(e).error_code).toBe('ATTENDANCE_FUTURE_DATE');
    }
  });

  maybeIt('W3 — mixing status and times is 422 VALIDATION_ERROR', async () => {
    try {
      await corrections.put(
        ownerUser() as never, TECH, d.half,
        { status: 'absent', checkoutAt: ist(d.half, '12:00:00') } as never, 'mixed',
      );
      throw new Error('expected 422, got 200');
    } catch (e) {
      expect(bodyOf(e).error_code).toBe('VALIDATION_ERROR');
    }
  });

  maybeIt('W4 — note hygiene: 501 chars and a control char are 422, and none wrote audit', async () => {
    for (const note of ['n'.repeat(501), 'bad\u0007note']) {
      try {
        await corrections.put(
          ownerUser() as never, TECH, d.present, { status: 'absent' }, note,
        );
        throw new Error('expected 422, got 200');
      } catch (e) {
        // Only an HttpException reaches the status assertion — a stray
        // fixture error rethrows here loud and red.
        expect(e instanceof Error && e.message.endsWith('got 200')).toBe(false);
        expect((e as import('@nestjs/common').HttpException).getStatus()).toBe(422);
      }
    }
    const page = await corrections.listOwner(ownerUser() as never, TECH, { workDate: d.ckm });
    expect(page.data).toHaveLength(0);
  });

  maybeIt('W5 — a checkout ALONE is 422 (D4: the times arm grades from the check-in)', async () => {
    // NOTE: the probe asserted 200 here; the review's D4 amendment makes
    // the checkout-only body a 422 — this is the corrected expectation.
    try {
      await corrections.put(
        ownerUser() as never, TECH, today,
        { checkoutAt: ist(today, '12:00:00') } as never, 'checkout only',
      );
      throw new Error('expected 422, got 200');
    } catch (e) {
      expect(bodyOf(e).error_code).toBe('VALIDATION_ERROR');
    }
  });

  maybeIt('W6 — an unknown employee is 404 on the write path (no existence leak)', async () => {
    try {
      await corrections.put(
        ownerUser() as never, randomUUID(), '1970-01-01', { status: 'absent' }, 'ghost',
      );
      throw new Error('expected 404, got 200');
    } catch (e) {
      expect(bodyOf(e).error_code).toBe('ATTENDANCE_EMPLOYEE_NOT_FOUND');
    }
  });

  maybeIt('W7 — the mirror gate reads present/half-day/times-only overrides, never a plain absent', async () => {
    await corrections.put(ownerUser() as never, TECH, d.ckm, { status: 'absent' }, 'absent correction');
    const dates = await inTx((tx) =>
      findActiveOverrideDates(tx, {
        tenantId: TENANT,
        employeeId: TECH,
        start: d.notTracked,
        end: d.future,
      }),
    );
    // Exactly the three fixture overrides with presence-bearing values —
    // nothing else (no today row: W5's checkout-only body made no override).
    // The fact read now carries an ORDER BY work_date contract (G2-P7) —
    // pin the order, not a sorted set.
    const want = [...new Set([d.correctedStatus, d.timesSub, d.sunWork])].sort();
    expect(dates).toEqual(want);
    expect(dates).not.toContain(d.ckm); // a plain-absent row sits under the gate silently
    await corrections.remove(ownerUser() as never, TECH, d.ckm);
  });

  maybeIt('W8 — ack counts the unacknowledged mocked attempts per date, idempotently', async () => {
    await pool.query(
      `insert into public.attendance_attempts
         (tenant_id, employee_id, request_id, kind, outcome, attempted_at, mocked, acknowledged_at)
       values ($1, $2, gen_random_uuid(), 'check_in', 'mocked', $3::timestamptz, true, null),
              ($1, $2, gen_random_uuid(), 'check_out', 'mocked', $3::timestamptz, true, null),
              ($1, $2, gen_random_uuid(), 'check_in', 'mocked', $4::timestamptz, true, null)`,
      [TENANT, TECH,
        ist(d.timesSub, '10:00:00'),
        ist(d.present, '10:00:00')],
    );
    expect(
      (await corrections.acknowledge(ownerUser() as never, TECH, d.timesSub)).acknowledgedCount,
    ).toBe(2);
    expect(
      (await corrections.acknowledge(ownerUser() as never, TECH, d.timesSub)).acknowledgedCount,
    ).toBe(0);
    expect(
      (await corrections.acknowledge(ownerUser() as never, TECH, d.present)).acknowledgedCount,
    ).toBe(1);
  });

  maybeIt('holiday inside approved leave — the label outranks the credit, and removing the holiday returns it (G2-P11b)', async () => {
    const date = d.leaveHoliday;
    await leaveRequest(date, 'full_day', 'approved');
    await pool.query(
      `insert into public.holidays (tenant_id, holiday_date, name)
       values ($1, $2, 'in-leave holiday probe')`,
      [TENANT, date],
    );
    const read = async (): Promise<DayStatusOutcome> => {
      const rows = await inTx((tx) => readDayStatusGrid(tx, TENANT, [TECH], date, date));
      return computeDayStatus(rows[0]!);
    };
    const during = await read();
    expect(during.status).toBe('holiday'); // rule 4 beats the leave credit
    expect(during.leaveCredit).toBe(0);
    await pool.query(
      'delete from public.holidays where tenant_id = $1 and holiday_date = $2',
      [TENANT, date],
    );
    const after = await read();
    expect(after.status).toBe('leave'); // the leave credit returns
    expect(after.leaveCredit).toBe(1);
  });

  maybeIt('FR-2 enable-day grace — an enable-day employee before office start still reads tracked (G2-P11c)', async () => {
    if (isSunday(today)) return; // today is a weekly off; nothing to compare
    const GRACE = randomUUID();
    const phone = '9' + String(900000000 + (Date.now() % 9_000_000)); // 900-908M — never hits the perf range
    await pool.query(
      `insert into public.users (id, name, role, tenant_id, status, country_code, phone_number)
       values ($1, '18-1 probe grace tech', 'technician', $2, 'active', '+91', $3)`,
      [GRACE, TENANT, phone],
    );
    // The coverage guard checks the (assignment, enrolment) pair at once —
    // seed both inside one transaction (same posture as the perf block).
    await pool.query('begin');
    await pool.query(
      `insert into public.attendance_office_assignments (tenant_id, employee_id, office_id, valid)
       values ($1, $2, $3, daterange(current_date - 60, current_date + 120))`,
      [TENANT, GRACE, officeId],
    );
    await pool.query(
      `insert into public.attendance_enrolments (tenant_id, employee_id, valid, enabled_at)
       values ($1, $2, daterange(current_date - 60, current_date + 120), $3::timestamptz)`,
      [TENANT, GRACE, ist(today, '10:00:00')], // enabled 10:00, after the 09:30 start
    );
    await pool.query('commit');
    const rows = await inTx((tx) => readDayStatusGrid(tx, TENANT, [GRACE], today, today));
    const outcome = computeDayStatus(rows[0]!);
    // The enable-day grace (FR-2): today is the enabled day, the enable
    // instant is past the office start and there is no check-in — the day
    // is NOT tracked yet, with the diagnostic naming the grace.
    expect(outcome.status).toBe('not_tracked');
    expect(rows[0]!.ctx.enableDayGraceBlocks).toBe(true);
    expect(outcome.daysWorked).toBe(0);
  });

  maybeIt('W1b — an override on a Sunday put grades absent, and its removal restores weekly_off (G2-P11d)', async () => {
    await corrections.put(ownerUser() as never, TECH, d.sunOff, { status: 'absent' }, 'sunday corrected');
    const rows = await inTx((tx) => readDayStatusGrid(tx, TENANT, [TECH], d.sunOff, d.sunOff));
    expect(computeDayStatus(rows[0]!).status).toBe('absent');
    await corrections.remove(ownerUser() as never, TECH, d.sunOff);
    const restored = await inTx((tx) =>
      readDayStatusGrid(tx, TENANT, [TECH], d.sunOff, d.sunOff),
    );
    expect(computeDayStatus(restored[0]!).status).toBe('weekly_off');
  });

  maybeIt('a recordless day corrected with times-only instants grades present (G2-P11e, real DB)', async () => {
    await corrections.put(
      ownerUser() as never, TECH, d.absent,
      { checkinAt: ist(d.absent, '09:25:00'), checkoutAt: ist(d.absent, '18:40:00') }, 'times corrected',
    );
    const rows = await inTx((tx) => readDayStatusGrid(tx, TENANT, [TECH], d.absent, d.absent));
    const outcome = computeDayStatus(rows[0]!);
    expect(outcome.status).toBe('present');
    expect(outcome.daysWorked).toBe(1);
    expect(outcome.checkinSource).toBe('manual');
    expect(outcome.checkoutSource).toBe('manual');
  });

  maybeIt('old_value captures the prior override on a second correction (G2-P13)', async () => {
    // d.correctedStatus already carries a seeded 'present' status override.
    await corrections.put(
      ownerUser() as never, TECH, d.correctedStatus, { status: 'half_day' }, 'second pass',
    );
    const page = await corrections.listOwner(ownerUser() as never, TECH, {
      workDate: d.correctedStatus,
    });
    const newest = page.data[0];
    expect(newest?.newValue.status).toBe('half_day');
    expect(newest?.oldValue).toEqual({
      status: 'present',
      checkinAt: null,
      checkoutAt: null,
    });
  });

  maybeIt('D8 parity — the engine row and MeAttendanceService.getSummary agree on today (G2-P3)', async () => {
    if (isSunday(today)) return; // today is a weekly off; nothing to compare
    await seedRecord(today, ist(today, '09:20:00'), ist(today, '18:35:00'));
    const me = new MeAttendanceService({
      createAdmin: () => admin,
    } as unknown as SupabaseClientFactory);
    const summary = await me.getSummary(techUser() as never);
    const rows = await inTx((tx) => readDayStatusGrid(tx, TENANT, [TECH], today, today));
    const outcome = computeDayStatus(rows[0]!);
    const record = rows[0]!.record;
    const todayRecord = summary.todayRecord;
    expect(todayRecord).toBeTruthy();
    // The seven Today-extension fields, engine ↔ summary, field for field.
    expect(todayRecord?.checkinAt).toBe(
      toTenantOffsetIso(new Date(rows[0]!.record!.checkin_at), TZ),
    );
    expect(todayRecord?.checkoutAt).toBe(
      toTenantOffsetIso(new Date(record!.checkout_at!), TZ),
    );
    expect(todayRecord?.lateMinutes).toBe(outcome.lateMinutes);
    expect(todayRecord?.isLate).toBe(outcome.isLate);
    expect(todayRecord?.workedMinutes).toBe(outcome.workedMinutes);
    expect(todayRecord?.earlyCheckout).toBe(outcome.earlyCheckout);
    expect(todayRecord?.earlyCheckoutMinutes).toBe(outcome.earlyCheckoutMinutes);
    // 09:20 is WITHIN the 15-minute late grace (09:45) — zero late
    // minutes, no Late flag (D12's formula: max(0, in - start - grace)).
    expect(todayRecord?.lateMinutes).toBe(0);
    expect(todayRecord?.isLate).toBe(false);
    expect(todayRecord?.workedMinutes).toBe(555);
  });

  maybeIt('D2 mirror gate — leave over a present-corrected date is rejected; over a plain-absent one it applies (G2-P1)', async () => {
    const dto = {
      startDate: d.mirror,
      endDate: d.mirror,
      part: 'full_day' as const,
      reason: 'mirror probe',
    };
    await corrections.put(
      ownerUser() as never, TECH, d.mirror, { status: 'present' }, 'present correction',
    );
    try {
      await leaveService.applyForSelf(techUser() as never, dto as never, randomUUID() /* the service's idempotency key is a ::uuid column */);
      throw new Error('expected rejection, got success');
    } catch (e) {
      // Only an HttpException reaches the assertions — a stray fixture
      // error rethrows loud and red.
      expect(e instanceof Error && e.message.endsWith('got success')).toBe(false);
      expect(bodyOf(e).error_code).toBe('LEAVE_CHECKED_IN_CONFLICT');
      expect(bodyOf(e).message).toContain(`You have a correction on ${d.mirror}`);
    }
    const preview = await leaveRead.previewApply(techUser() as never, dto as never);
    expect(preview.ok).toBe(false);
    expect(preview.errorCode).toBe('LEAVE_CHECKED_IN_CONFLICT');
    // Leave may only sit under a PLAIN absent correction.
    await corrections.put(
      ownerUser() as never, TECH, d.mirror, { status: 'absent' }, 'absent correction',
    );
    const admitted = await leaveRead.previewApply(techUser() as never, dto as never);
    expect(admitted.ok).toBe(true);
    const view = await leaveService.applyForSelf(
      techUser() as never,
      dto as never,
      randomUUID(),
    );
    expect(view.startDate).toBe(d.mirror);
    expect(view.status).toBe('pending');
  });

  maybeIt('perf — 51 employees × 31 days reads inside 3s (the 15-9 drift-class budget)', async () => {
    const perfUsers: string[] = [];
    for (let i = 0; i < 50; i++) perfUsers.push(randomUUID());
    await pool.query('begin');
    // Deterministic per-run phones, unique per row (a random() collision
    // would 409 the whole scaffold — review G2-P14).
    const phoneBase = 910000000 + (Date.now() % 80_000_000);
    await pool.query(
      `insert into public.users (id, name, role, tenant_id, status, country_code, phone_number)
       select u.id, 'perf worker ' || row_number() over (), 'technician', $1, 'active', '+91',
              '9' || (($2 + row_number() over ())::bigint)::text
       from unnest($3::uuid[]) as u(id)`,
      [TENANT, phoneBase, perfUsers],
    );
    // Assignments BEFORE enrolments — the coverage guard checks the pair at
    // COMMIT, so all seeding goes in one transaction.
    await pool.query(
      `insert into public.attendance_office_assignments (tenant_id, employee_id, office_id, valid)
       select $1, u.id, $3, daterange(current_date - 60, current_date + 120)
       from unnest($2::uuid[]) as u(id)`,
      [TENANT, perfUsers, (await pool.query<{ office_id: string }>(
        'select office_id from public.attendance_office_assignments where tenant_id = $1 limit 1',
        [TENANT],
      )).rows[0].office_id],
    );
    await pool.query(
      `insert into public.attendance_enrolments (tenant_id, employee_id, valid, enabled_at)
       select $1, u.id, daterange(current_date - 60, current_date + 120), now() - interval '60 days'
       from unnest($2::uuid[]) as u(id)`,
      [TENANT, perfUsers],
    );
    await pool.query('commit');

    const t0 = Date.now();
    // The NFR-7 budget window: a full 31-day span (G2-P10), not just the
    // seeded anchor dates.
    const perfFrom = dayOffset(today, -31);
    await inTx((tx) =>
      readDayStatusGrid(tx, TENANT, [TECH, ...perfUsers], perfFrom, today),
    );
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
