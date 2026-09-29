/**
 * Story 15-10 real-DB journey probe — GET /attendance/me/summary (FR-4).
 *
 * Drives the SHIPPED MeAttendanceService (the same class the controller
 * calls, on a REAL admin client) against the real attendance schema: the
 * attendance_access_state view supplies the office AND the anchor date, the
 * office rule covering that anchor supplies the timings, and the weekly-off
 * override→default precedence (AD-22) is exercised at the tables — none of
 * which the mocked-boundary unit suite can prove (the view's anchor SQL and
 * the exclusion constraints only exist in the real DB).
 *
 * The two-office fixture makes the journey discriminating: the future
 * office's rule reads 10:00/19:00/30 while the live office's reads
 * 09:30/18:00/15, so a summary that anchored the wrong office or picked a
 * rule for the wrong date cannot pass.
 *
 * Requires real credentials: gated on DATABASE_URL/SUPABASE_* being set and
 * not the jest.env.setup.ts dummies (same convention as the 15-7 enrolments
 * probe). Fixtures are self-contained (throwaway tenant, unique probe phone
 * numbers) and removed in afterAll; the paired enrolment/assignment ranges
 * are written and removed in ONE transaction each — the deferred coverage
 * trigger (23514 ATTENDANCE_ASSIGNMENT_GAP) validates the pair at COMMIT.
 */
import { Pool } from 'pg';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { MeAttendanceService } from '../../src/attendance/me-attendance.service';
import { SupabaseClientFactory } from '../../src/common/factories/supabase-client.factory';
import { EMPTY_ME_SUMMARY } from '../../src/attendance/me-summary.model';
import type { RequestUser } from '../../src/common/interfaces/request-user.interface';
import { Role } from '../../src/common/enums/role.enum';
import {
  insertAssignment,
  insertEnrolment,
  deleteRanges,
  readAssignments,
  readEnrolments,
} from '../../src/attendance/enrolments.repository';

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
const OWNER = randomUUID();
const TECH = randomUUID();
/** The office with the LIVE assignment (today-anchored reads). */
const OFFICE_MAIN = randomUUID();
/** The office the FUTURE period is assigned to (upcoming-anchored reads). */
const OFFICE_FUTURE = randomUUID();
/** Probe phone numbers (unique-enough; double as the pre-clean key). */
const PROBE_PHONES = [
  `7${Date.now()}`.slice(-10).replace(/^./, '7') + '1',
  `7${Date.now()}`.slice(-10).replace(/^./, '7') + '2',
];

const techUser: RequestUser = {
  userId: TECH,
  tenantId: TENANT,
  role: Role.TECHNICIAN,
  rawJwt: 'probe-jwt',
};

describe('Attendance me/summary journey (15-10, real DB)', () => {
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let pool: Pool;
  let admin: SupabaseClient;
  let service: MeAttendanceService;
  let today: string;
  /** [today-30, ∞) — both rules and the weekly-off default's validity. */
  let pastStart: string;
  /** [today+7, ∞) — the future period that reads upcoming. */
  let futureStart: string;

  async function inTx<T>(
    work: (tx: import('pg').PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  const must = <T>(res: {
    data: T | null;
    error: { message: string } | null;
  }): T => {
    if (res.error) {
      throw new Error(`fixture insert failed: ${res.error.message}`);
    }
    return res.data as T;
  };

  beforeAll(async () => {
    if (!IS_REAL_DB) {
      return;
    }
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
    admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // The service under test, on a real admin client — no ConfigService.
    service = new MeAttendanceService({
      createAdmin: () => admin,
    } as unknown as SupabaseClientFactory);

    // Pre-clean any leftovers from an aborted earlier run (same probe
    // phones), FK-safe order. attendance_onboarding has no tenant cascade
    // gap here — every table is tenant-scoped or cleaned by tenant/id.
    const { data: stale } = await admin
      .from('users')
      .select('id, tenant_id')
      .in('phone_number', PROBE_PHONES);
    if (stale && stale.length > 0) {
      const staleTenants = [
        ...new Set(stale.map((s) => s.tenant_id).filter(Boolean)),
      ] as string[];
      for (const t of staleTenants) {
        await admin.from('notifications').delete().eq('tenant_id', t);
        await admin.from('attendance_records').delete().eq('tenant_id', t);
        await admin.from('attendance_attempts').delete().eq('tenant_id', t);
        await admin.from('holidays').delete().eq('tenant_id', t);
        await admin
          .from('attendance_weekly_off_overrides')
          .delete()
          .eq('tenant_id', t);
        await admin
          .from('attendance_weekly_off_defaults')
          .delete()
          .eq('tenant_id', t);
        await admin.from('attendance_office_rules').delete().eq('tenant_id', t);
        // The deferred coverage guard (23514 ATTENDANCE_ASSIGNMENT_GAP)
        // rejects an enrolment delete that un-anchors a live assignment —
        // assignments FIRST, and every result checked (a silently swallowed
        // failure here would defeat the pre-clean's whole purpose).
        const assignDel = await admin
          .from('attendance_office_assignments')
          .delete()
          .eq('tenant_id', t);
        if (assignDel.error) throw assignDel.error;
        const enrolDel = await admin
          .from('attendance_enrolments')
          .delete()
          .eq('tenant_id', t);
        if (enrolDel.error) throw enrolDel.error;
        await admin.from('attendance_onboarding').delete().eq('tenant_id', t);
        await admin
          .from('attendance_setup_progress')
          .delete()
          .eq('tenant_id', t);
        await admin.from('attendance_settings').delete().eq('tenant_id', t);
        await admin.from('attendance_offices').delete().eq('tenant_id', t);
        await admin.from('tenants').delete().eq('id', t);
      }
      await admin
        .from('users')
        .delete()
        .in(
          'id',
          stale.map((s) => s.id),
        );
    }

    // Fixtures: owner (tenant-less first — tenants.owner_id references it),
    // tenant, technician, two offices, settings enabled+completed.
    must(
      await admin.from('users').insert({
        id: OWNER,
        role: 'owner',
        status: 'active',
        country_code: '+91',
        phone_number: PROBE_PHONES[0],
        name: '15-10 probe owner',
      }),
    );
    must(
      await admin.from('tenants').insert({
        id: TENANT,
        owner_id: OWNER,
        company_name: '15-10 summary probe',
        state_code: 'KA',
      }),
    );
    await admin.from('users').update({ tenant_id: TENANT }).eq('id', OWNER);
    must(
      await admin.from('users').insert({
        id: TECH,
        tenant_id: TENANT,
        role: 'technician',
        status: 'active',
        country_code: '+91',
        phone_number: PROBE_PHONES[1],
        name: '15-10 probe tech',
      }),
    );
    must(
      await admin.from('attendance_offices').insert([
        {
          id: OFFICE_MAIN,
          tenant_id: TENANT,
          name: 'probe summary office (main)',
          latitude: 12.97,
          longitude: 77.59,
          radius_m: 100,
        },
        {
          id: OFFICE_FUTURE,
          tenant_id: TENANT,
          name: 'probe summary office (future)',
          latitude: 12.98,
          longitude: 77.6,
          radius_m: 100,
        },
      ]),
    );
    must(
      await admin.from('attendance_settings').insert({
        tenant_id: TENANT,
        enabled: true,
        setup_completed_at: new Date().toISOString(),
      }),
    );

    // Anchor dates come from the tenant's own clock (AD-7) — no JS date
    // math anywhere.
    const dates = await pool.query(
      `select public.attendance_today($1)::text as today,
              (public.attendance_today($1) - 30)::text as past,
              (public.attendance_today($1) + 7)::text as future`,
      [TENANT],
    );
    today = dates.rows[0].today;
    pastStart = dates.rows[0].past;
    futureStart = dates.rows[0].future;

    // Rules: the LIVE office reads 09:30/18:00/15; the FUTURE office a
    // different 10:00/19:00/30 — so a summary that shows the wrong office's
    // rule fails loudly instead of passing by coincidence.
    must(
      await admin.from('attendance_office_rules').insert([
        {
          office_id: OFFICE_MAIN,
          tenant_id: TENANT,
          valid: `[${pastStart},)`,
          start_time: '09:30:00',
          end_time: '18:00:00',
          late_cutoff_minutes: 15,
          full_day_hours: 8,
          half_day_hours: 4,
        },
        {
          office_id: OFFICE_FUTURE,
          tenant_id: TENANT,
          valid: `[${pastStart},)`,
          start_time: '10:00:00',
          end_time: '19:00:00',
          late_cutoff_minutes: 30,
          full_day_hours: 8,
          half_day_hours: 4,
        },
      ]),
    );
    // Tenant weekly-off default: Sundays (7), effective [today-30, ∞).
    must(
      await admin.from('attendance_weekly_off_defaults').insert({
        tenant_id: TENANT,
        valid: `[${pastStart},)`,
        days: [7],
      }),
    );
  });

  afterAll(async () => {
    if (!IS_REAL_DB) {
      return;
    }
    await cleanupFixtures();
    await pool.end();
  });

  /** Idempotent full teardown: paired ranges in ONE txn, then the rest. */
  async function cleanupFixtures() {
    // Assignments BEFORE enrolments, ONE transaction — the deferred
    // coverage trigger validates the pair at COMMIT; deleting both halves
    // in one txn leaves nothing for it to reject.
    await inTx(async (tx) => {
      const assignments = await tx.query(
        'select id from public.attendance_office_assignments where tenant_id = $1',
        [TENANT],
      );
      const enrolments = await tx.query(
        'select id from public.attendance_enrolments where tenant_id = $1',
        [TENANT],
      );
      await deleteRanges(
        tx,
        'attendance_office_assignments',
        assignments.rows.map((r) => r.id),
      );
      await deleteRanges(
        tx,
        'attendance_enrolments',
        enrolments.rows.map((r) => r.id),
      );
    });
    await admin.from('notifications').delete().eq('tenant_id', TENANT);
    // 16-4 fixtures: records/attempts before users — the composite
    // (employee_id, tenant_id) → users FK is ON DELETE RESTRICT.
    await admin.from('attendance_records').delete().eq('tenant_id', TENANT);
    await admin.from('attendance_attempts').delete().eq('tenant_id', TENANT);
    await admin.from('holidays').delete().eq('tenant_id', TENANT);
    await admin
      .from('attendance_weekly_off_overrides')
      .delete()
      .eq('tenant_id', TENANT);
    await admin
      .from('attendance_weekly_off_defaults')
      .delete()
      .eq('tenant_id', TENANT);
    await admin
      .from('attendance_office_rules')
      .delete()
      .eq('tenant_id', TENANT);
    await admin.from('attendance_onboarding').delete().eq('tenant_id', TENANT);
    await admin.from('attendance_offices').delete().eq('tenant_id', TENANT);
    await admin
      .from('attendance_setup_progress')
      .delete()
      .eq('tenant_id', TENANT);
    await admin.from('attendance_settings').delete().eq('tenant_id', TENANT);
    // 17-8 probe residue: days before requests (the request FK is
    // RESTRICT) and both before users (the employee FK is RESTRICT too).
    await admin.from('leave_request_days').delete().eq('tenant_id', TENANT);
    await admin.from('leave_requests').delete().eq('tenant_id', TENANT);
    await admin.from('users').delete().in('id', [OWNER, TECH]);
    await admin.from('tenants').delete().eq('id', TENANT);
  }

  maybeIt(
    'upcoming: the summary reads the FUTURE office, its rule at the period start, and the tenant default [7]',
    async () => {
      // Future-dated period at the FUTURE office — enrolment + assignment
      // in ONE transaction (the deferred coverage trigger validates the
      // pair at COMMIT).
      await inTx(async (tx) => {
        await insertAssignment(tx, TENANT, TECH, OFFICE_FUTURE, futureStart);
        await insertEnrolment(tx, TENANT, TECH, futureStart);
      });

      const summary = await service.getSummary(techUser);

      expect(summary).toEqual({
        officeId: OFFICE_FUTURE,
        officeName: 'probe summary office (future)',
        startTime: '10:00', // the FUTURE office's rule — not main's 09:30
        endTime: '19:00',
        lateCutOffMinutes: 30,
        weeklyOffDays: [7], // the default covers the future start too
        // 16-4: the FUTURE office's pin IS anchored (the summary shows it),
        // but the Today facts/record are active-only — a future date's
        // "today" would be a lie.
        officeLatitude: 12.98,
        officeLongitude: 77.6,
        today: null,
        todayRecord: null,
      });
    },
  );

  maybeIt(
    'none: after the future rows go, the summary answers the honest empty shape',
    async () => {
      // Delete-style cancel of the future period (both tables, ONE txn).
      await inTx(async (tx) => {
        const assignments = await readAssignments(tx, TECH);
        const enrolments = await readEnrolments(tx, TECH);
        await deleteRanges(
          tx,
          'attendance_office_assignments',
          assignments.map((r) => r.id),
        );
        await deleteRanges(
          tx,
          'attendance_enrolments',
          enrolments.map((r) => r.id),
        );
      });

      const summary = await service.getSummary(techUser);

      // Settings are enabled+completed but nothing is tracked: access none,
      // and the endpoint answers all-null/[] rather than a stale office.
      expect(summary).toEqual(EMPTY_ME_SUMMARY);
    },
  );

  maybeIt(
    'active: SQL-inserted covering-today period reads the live office, its rule and [7]',
    async () => {
      await inTx(async (tx) => {
        await insertAssignment(tx, TENANT, TECH, OFFICE_MAIN, today);
        await insertEnrolment(tx, TENANT, TECH, today);
      });

      const summary = await service.getSummary(techUser);

      // The default weekly off is [7]; whether TODAY is a weekly off depends
      // on the run day — the expected facts compute the same way the pure
      // helper does (ISO weekday from the date, UTC space — no DST).
      const weekdayOf = (date: string) =>
        ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
      const isWeeklyOffToday = weekdayOf(today) === 7;

      expect(summary).toEqual({
        officeId: OFFICE_MAIN,
        officeName: 'probe summary office (main)',
        startTime: '09:30',
        endTime: '18:00',
        lateCutOffMinutes: 15,
        weeklyOffDays: [7],
        // 16-4 Today extension (active): pin + facts present, no record yet.
        officeLatitude: 12.97,
        officeLongitude: 77.59,
        today: {
          date: today,
          isWeeklyOff: isWeeklyOffToday,
          isHoliday: false,
          holidayName: null,
          isWorkingDay: !isWeeklyOffToday,
          leaveState: null,
          leavePart: null,
        },
        todayRecord: null,
      });
    },
  );

  maybeIt(
    '17-8 today leave facts: an approved covering leave reads state+part, a cancelled one reads null',
    async () => {
      // The active leave seam mirrored on the summary: one live
      // pending/approved day row at most (the partial unique index). Insert
      // a real approved request covering today, read it, then cancel the
      // days and watch the facts fall back to honest nulls.
      const requestId = randomUUID();
      must(
        await admin.from('leave_requests').insert({
          id: requestId,
          tenant_id: TENANT,
          employee_id: TECH,
          request_id: randomUUID(),
          start_date: today,
          end_date: today,
          part: 'first_half',
          reason: 'probe summary leave',
          created_by: TECH,
        }),
      );
      must(
        await admin.from('leave_request_days').insert({
          tenant_id: TENANT,
          leave_request_id: requestId,
          employee_id: TECH,
          leave_date: today,
          state: 'approved',
        }),
      );

      const withLeave = await service.getSummary(techUser);
      expect(withLeave.today).toMatchObject({
        leaveState: 'approved',
        leavePart: 'first_half',
      });

      // The auto-cancel shape (17-4's check-in transition): the day row goes
      // 'cancelled' — the summary must read null/null again.
      must(
        await admin
          .from('leave_request_days')
          .update({ state: 'cancelled' })
          .eq('leave_request_id', requestId),
      );

      const afterCancel = await service.getSummary(techUser);
      expect(afterCancel.today).toMatchObject({
        leaveState: null,
        leavePart: null,
      });

      // Days first — the request FK is RESTRICT, so the user teardown below
      // would fail with an orphaned day row.
      await admin
        .from('leave_request_days')
        .delete()
        .eq('leave_request_id', requestId);
      await admin.from('leave_requests').delete().eq('id', requestId);
    },
  );

  maybeIt(
    '16-4 today facts: a holiday row today flips isHoliday/holidayName/isWorkingDay, then un-flips',
    async () => {
      must(
        await admin.from('holidays').insert({
          tenant_id: TENANT,
          holiday_date: today,
          name: 'probe holiday',
        }),
      );

      const withHoliday = await service.getSummary(techUser);
      expect(withHoliday.today).toMatchObject({
        date: today,
        isHoliday: true,
        holidayName: 'probe holiday',
        isWorkingDay: false,
      });

      await admin.from('holidays').delete().eq('tenant_id', TENANT);

      const after = await service.getSummary(techUser);
      expect(after.today).toMatchObject({
        isHoliday: false,
        holidayName: null,
      });
    },
  );

  maybeIt(
    '16-4 todayRecord: an open record grades lateMinutes against the rule and carries the tenant offset',
    async () => {
      // An ok attempt row first — attendance_records.checkin_attempt_id is
      // NOT NULL with an FK to it. Check-in 10:22 tenant-local vs rule
      // 09:30+15 → late 37, isLate.
      const attemptId = randomUUID();
      must(
        await admin.from('attendance_attempts').insert({
          id: attemptId,
          tenant_id: TENANT,
          employee_id: TECH,
          request_id: randomUUID(),
          kind: 'check_in',
          outcome: 'ok',
        }),
      );
      must(
        await admin.from('attendance_records').insert({
          tenant_id: TENANT,
          employee_id: TECH,
          work_date: today,
          office_id: OFFICE_MAIN,
          radius_m: 100,
          // 10:22 IST as an explicit-offset instant (the tenant default is
          // Asia/Kolkata; PostgREST parses the offset, not SQL expressions).
          checkin_at: `${today}T10:22:00+05:30`,
          checkin_attempt_id: attemptId,
          checkin_lat: 12.97,
          checkin_lng: 77.59,
          checkin_accuracy_m: 12,
          checkin_distance_m: 40,
          checkin_mocked: false,
        }),
      );

      const summary = await service.getSummary(techUser);

      const rec = summary.todayRecord;
      expect(rec).not.toBeNull();
      expect(rec!.checkoutAt).toBeNull();
      expect(rec!.workedMinutes).toBeNull();
      expect(rec!.earlyCheckout).toBeNull();
      expect(rec!.lateMinutes).toBe(37);
      expect(rec!.isLate).toBe(true);
      // AD-7/D11: the wall-clock parts travel in the string, tenant offset
      // (the tenant default Asia/Kolkata) — the FE never converts.
      expect(rec!.checkinAt).toBe(`${today}T10:22:00+05:30`);

      // Keep the record for the close-out step below (its own probe).
    },
  );

  maybeIt(
    '16-4 todayRecord: closing the record adds workedMinutes (instants, truncated) + earlyCheckout',
    async () => {
      const checkoutAttempt = randomUUID();
      must(
        await admin.from('attendance_attempts').insert({
          id: checkoutAttempt,
          tenant_id: TENANT,
          employee_id: TECH,
          request_id: randomUUID(),
          kind: 'check_out',
          outcome: 'ok',
        }),
      );
      // The checkout-pair CHECK demands the paired attempt id.
      const upd = await admin
        .from('attendance_records')
        .update({
          checkout_at: `${today}T18:05:00+05:30`,
          checkout_attempt_id: checkoutAttempt,
        })
        .eq('tenant_id', TENANT)
        .eq('employee_id', TECH);
      if (upd.error)
        throw new Error(`fixture update failed: ${upd.error.message}`);

      const summary = await service.getSummary(techUser);

      // 10:22 → 18:05 = 7 h 43 m = 463 whole minutes; 18:05 is past the
      // 18:00 rule end → earlyCheckout false.
      expect(summary.todayRecord).toMatchObject({
        checkoutAt: `${today}T18:05:00+05:30`,
        workedMinutes: 463,
        earlyCheckout: false,
        earlyCheckoutMinutes: null,
        lateMinutes: 37,
        isLate: true,
      });
    },
  );

  maybeIt(
    'override precedence: a covering [1] override replaces the default; removing it restores [7]',
    async () => {
      must(
        await admin.from('attendance_weekly_off_overrides').insert({
          tenant_id: TENANT,
          employee_id: TECH,
          valid: `[${today},)`,
          days: [1],
        }),
      );

      const overridden = await service.getSummary(techUser);
      expect(overridden.weeklyOffDays).toEqual([1]);
      // The override changes ONLY the weekly offs.
      expect(overridden.officeId).toBe(OFFICE_MAIN);
      expect(overridden.startTime).toBe('09:30');

      await admin
        .from('attendance_weekly_off_overrides')
        .delete()
        .eq('tenant_id', TENANT);

      const restored = await service.getSummary(techUser);
      expect(restored.weeklyOffDays).toEqual([7]);
    },
  );

  maybeIt(
    'cleanup removed every fixture row — zero residue under the probe tenant',
    async () => {
      // The final journey step performs the teardown itself so the residue
      // assertion is testable; afterAll re-runs it (idempotent) as a safety
      // net if an earlier step threw.
      await cleanupFixtures();

      for (const table of [
        'attendance_office_assignments',
        'attendance_enrolments',
        'attendance_weekly_off_overrides',
        'attendance_weekly_off_defaults',
        'attendance_office_rules',
        'attendance_onboarding',
        'attendance_offices',
        'attendance_setup_progress',
        'attendance_settings',
        'attendance_records',
        'attendance_attempts',
        'holidays',
      ]) {
        const { rows } = await pool.query(
          `select count(*)::int as n from public.${table} where tenant_id = $1`,
          [TENANT],
        );
        expect(rows[0].n).toBe(0);
      }
      const { rows: userRows } = await pool.query(
        'select count(*)::int as n from public.users where id = any($1::uuid[])',
        [[OWNER, TECH]],
      );
      expect(userRows[0].n).toBe(0);
      const { rows: tenantRows } = await pool.query(
        'select count(*)::int as n from public.tenants where id = $1',
        [TENANT],
      );
      expect(tenantRows[0].n).toBe(0);
    },
  );
});
