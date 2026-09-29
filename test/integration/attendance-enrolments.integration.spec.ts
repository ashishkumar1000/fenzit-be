/**
 * Story 15-7 real-DB journey probe (Epic 15 — enrolment, office assignment
 * & access state).
 *
 * Drives the SHIPPED repository SQL (the same functions the NestJS service
 * calls inside its pg transactions), the reconciled RPCs, and the
 * attendance_access_state view against a REAL database — the executable
 * verification the mocked-boundary e2e suite cannot provide (spec-15-7
 * Tasks; closes the Spec-15-5 deferred item: the holiday fan-out branches
 * were to_regclass-gated and never executed by any test until the
 * enrolments table existed).
 *
 * Requires real credentials: gated on DATABASE_URL being set and not the
 * jest.env.setup.ts dummy. Fixtures are self-contained (throwaway tenant)
 * and removed in afterAll.
 */
import { Pool } from 'pg';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import {
  ATTENDANCE_NOTIFICATION_EVENT,
  ATTENDANCE_NOTIFICATION_EVENT_REGISTRY,
  ATTENDANCE_ENTITY_TYPE,
} from '../../src/attendance/notification-events';
import {
  insertEnrolment,
  insertAssignment,
  clipRangeEnd,
  deleteRanges,
  readEnrolments,
  readAssignments,
  readAccessState,
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
const TECH_ACTIVE = randomUUID();
const TECH_UPCOMING = randomUUID();
const TECH_PAST = randomUUID();
const OFFICE_A = randomUUID();
const OFFICE_B = randomUUID();
const OFFICE_C = randomUUID();
/** The gate-3 drift probe's rule-less office (created and dropped in-test). */
const OFFICE_D = randomUUID();
/** Probe phone numbers (unique-enough prefix doubles as the cleanup key). */
const PROBE_PHONES = [
  `7${Date.now()}`.slice(-10).replace(/^./, '7') + '1',
  `7${Date.now()}`.slice(-10).replace(/^./, '7') + '2',
  `7${Date.now()}`.slice(-10).replace(/^./, '7') + '3',
  `7${Date.now()}`.slice(-10).replace(/^./, '7') + '4',
];
/** A start date far enough out to stay in the future for the whole run. */
const FUTURE_START = '2027-03-01';
const FUTURE_HOLIDAY = '2027-12-25';

type RangeRow = { id: string; valid: string };

/** lower(valid) as text, from a pg daterange literal like '[2026-09-25,)'. */
function rangeStart(valid: string): string {
  return valid.slice(1, valid.indexOf(','));
}

/** True when the range's textual upper bound is open (NULL) or > today. */
function coversTodayOrLater(valid: string, today: string): boolean {
  const upper = valid.slice(valid.indexOf(',') + 1).replace(/[)\]]$/, '');
  return upper === '' || upper > today;
}

describe('Attendance enrolments journey (15-7, real DB)', () => {
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let pool: Pool;
  let admin: SupabaseClient;
  let today: string;

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

  beforeAll(async () => {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
    admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Pre-clean any leftovers from an aborted earlier run (same probe
    // phone numbers), FK-safe order, then every insert is error-checked —
    // a silently failed fixture insert poisons the whole journey.
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
        await admin.from('holidays').delete().eq('tenant_id', t);
        await admin.from('attendance_enrolments').delete().eq('tenant_id', t);
        await admin
          .from('attendance_office_assignments')
          .delete()
          .eq('tenant_id', t);
        await admin.from('attendance_onboarding').delete().eq('tenant_id', t);
        await admin
          .from('attendance_setup_progress')
          .delete()
          .eq('tenant_id', t);
        await admin.from('attendance_settings').delete().eq('tenant_id', t);
        await admin.from('attendance_office_rules').delete().eq('tenant_id', t);
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

    const must = <T>(res: { data: T | null; error: { message: string } | null }): T => {
      if (res.error) {
        throw new Error(`fixture insert failed: ${res.error.message}`);
      }
      return res.data as T;
    };

    // Fixtures: owner (tenant-less first — tenants.owner_id references it),
    // tenant, two technicians, two live offices.
    must(
      await admin.from('users').insert({
        id: OWNER,
        role: 'owner',
        status: 'active',
        country_code: '+91',
        phone_number: PROBE_PHONES[0],
        name: '15-7 probe owner',
      }),
    );
    must(
      await admin.from('tenants').insert({
        id: TENANT,
        owner_id: OWNER,
        company_name: '15-7 journey probe',
        state_code: 'KA',
      }),
    );
    await admin.from('users').update({ tenant_id: TENANT }).eq('id', OWNER);
    must(
      await admin.from('users').insert([
        {
          id: TECH_ACTIVE,
          tenant_id: TENANT,
          role: 'technician',
          status: 'active',
          country_code: '+91',
          phone_number: PROBE_PHONES[1],
          name: '15-7 probe tech (active)',
        },
        {
          id: TECH_UPCOMING,
          tenant_id: TENANT,
          role: 'technician',
          status: 'active',
          country_code: '+91',
          phone_number: PROBE_PHONES[2],
          name: '15-7 probe tech (upcoming)',
        },
        {
          id: TECH_PAST,
          tenant_id: TENANT,
          role: 'technician',
          status: 'active',
          country_code: '+91',
          phone_number: PROBE_PHONES[3],
          name: '15-9 probe tech (backdated)',
        },
      ]),
    );
    must(
      await admin.from('attendance_offices').insert([
        { id: OFFICE_A, tenant_id: TENANT, name: 'probe office A', latitude: 12.97, longitude: 77.59, radius_m: 100 },
        { id: OFFICE_B, tenant_id: TENANT, name: 'probe office B', latitude: 12.98, longitude: 77.6, radius_m: 100 },
        { id: OFFICE_C, tenant_id: TENANT, name: 'probe office C', latitude: 12.99, longitude: 77.61, radius_m: 100 },
      ]),
    );
    // Gate 3 (AD-25, added by 19-1): completing setup is blocked while any
    // ACTIVE office has no covering rule — this fixture predates the gate,
    // so each of its live offices needs one. The open `valid` covers today
    // (the gate's check date) and the probe's far-future dates alike; the
    // rule content is irrelevant to these enrolment journeys.
    must(
      await admin.from('attendance_office_rules').insert([
        ...[OFFICE_A, OFFICE_B, OFFICE_C].map((office_id) => ({
          tenant_id: TENANT,
          office_id,
          valid: '[2000-01-01,)',
          start_time: '09:00',
          end_time: '18:00',
          late_cutoff_minutes: 15,
          full_day_hours: 8,
          half_day_hours: 4,
        })),
      ]),
    );

    const t = await pool.query(
      'select public.attendance_today($1)::text as today',
      [TENANT],
    );
    today = t.rows[0].today;
  });

  afterAll(async () => {
    if (!IS_REAL_DB) {
      return;
    }
    // Cleanup in FK-safe order; the tenant cascade takes the rest.
    await admin.from('notifications').delete().eq('tenant_id', TENANT);
    await admin.from('holidays').delete().eq('tenant_id', TENANT);
    await admin.from('attendance_enrolments').delete().eq('tenant_id', TENANT);
    await admin
      .from('attendance_office_assignments')
      .delete()
      .eq('tenant_id', TENANT);
    await admin.from('attendance_onboarding').delete().eq('tenant_id', TENANT);
    await admin
      .from('attendance_setup_progress')
      .delete()
      .eq('tenant_id', TENANT);
    await admin.from('attendance_settings').delete().eq('tenant_id', TENANT);
    // Rules RESTRICT to their office (AD-25) — delete them BEFORE offices;
    // the tenant drop takes whatever the per-table legs above missed.
    await admin
      .from('attendance_office_rules')
      .delete()
      .eq('tenant_id', TENANT);
    await admin.from('attendance_offices').delete().eq('tenant_id', TENANT);
    await admin
      .from('users')
      .delete()
      .in('id', [OWNER, TECH_ACTIVE, TECH_UPCOMING, TECH_PAST]);
    await admin.from('tenants').delete().eq('id', TENANT);
    await pool.end();
  });

  maybeIt('a never-enrolled technician reads access none (AD-17)', async () => {
    const state = await inTx((tx) => readAccessState(tx, TENANT, TECH_ACTIVE));
    expect(state.access_state).toBe('none');
    expect(state.attendance_enabled).toBe(false);
    expect(state.attendance_start_date).toBeNull();
  });

  maybeIt('complete-setup is 422 SETUP_INCOMPLETE before anyone is enrolled (Gate 2)', async () => {
    await admin.from('attendance_settings').insert({ tenant_id: TENANT });
    const { error } = await admin.rpc('attendance_complete_setup', {
      p_tenant_id: TENANT,
      p_actor_id: OWNER,
    });
    expect(error).not.toBeNull();
    expect(error?.hint).toBe('ATTENDANCE_SETUP_INCOMPLETE');
  });

  maybeIt('gate 3 rejects 422 and NAMES the rule-less office with the fix (18-5, D3)', async () => {
    // A rule-less ACTIVE office among the rule-seeded ones — the only
    // offending office, so the rejection names it deterministically.
    const { error: officeErr } = await admin
      .from('attendance_offices')
      .insert({
        id: OFFICE_D,
        tenant_id: TENANT,
        name: 'rule-less probe office',
        latitude: 13.0,
        longitude: 77.62,
        radius_m: 100,
      });
    // `must` above is local to beforeAll's closure — inline the same check
    // here so a fixture failure fails THIS test, not a later one.
    if (officeErr) {
      throw new Error(`fixture insert failed: ${officeErr.message}`);
    }
    try {
      // Gate 2 must PASS for the probe to reach gate 3: seed the tracked
      // pair in ONE transaction (the coverage guard's deferred trigger),
      // and undo it in the finally so the later journeys start clean.
      await inTx(async (tx) => {
        await insertAssignment(tx, TENANT, TECH_ACTIVE, OFFICE_A, today);
        await insertEnrolment(tx, TENANT, TECH_ACTIVE, today);
      });

      const { error } = await admin.rpc('attendance_complete_setup', {
        p_tenant_id: TENANT,
        p_actor_id: OWNER,
      });
      expect(error).not.toBeNull();
      expect(error?.code).toBe('PT422');
      expect(error?.hint).toBe('ATTENDANCE_SETUP_INCOMPLETE');
      // D3 (user decision 2026-09-29): the owner is told WHY the completion
      // failed, WHICH office is un-timed, and WHAT to do next.
      expect(error?.message).toBe(
        'attendance setup could not be completed: office «rule-less probe office» has no timing rule covering today. Add a rule for this office, then try again.',
      );
    } finally {
      // The enrolment↔assignment pairing is enforced by function-based
      // CHECKs (23514 ATTENDANCE_ASSIGNMENT_GAP) — a single-table REST
      // delete trips the other table's gap check and silently no-ops, so
      // the pair is stripped in ONE transaction (the seeding's own shape).
      await inTx(async (tx) => {
        await tx.query(
          'delete from public.attendance_enrolments where employee_id = $1',
          [TECH_ACTIVE],
        );
        await tx.query(
          'delete from public.attendance_office_assignments where employee_id = $1',
          [TECH_ACTIVE],
        );
      });
      // No rule row exists, so the office deletes clean (rules RESTRICT).
      await admin.from('attendance_offices').delete().eq('id', OFFICE_D);
    }
  });

  maybeIt('enable co-writes the enrolment + assignment; kill switch still reads none', async () => {
    await inTx(async (tx) => {
      await insertAssignment(tx, TENANT, TECH_ACTIVE, OFFICE_A, today);
      await insertEnrolment(tx, TENANT, TECH_ACTIVE, today);
    });

    const state = await inTx((tx) => readAccessState(tx, TENANT, TECH_ACTIVE));
    // The kill switch is the module's off act (locked decision): enrolled
    // but the wizard has not completed → none, with the period carried.
    expect(state.access_state).toBe('none');
    expect(state.attendance_start_date).toBe(today);
    expect(state.office_id).toBe(OFFICE_A);
  });

  maybeIt('completing setup flips the module on → active (Gate 2 passes on the tracked employee)', async () => {
    const { error } = await admin.rpc('attendance_complete_setup', {
      p_tenant_id: TENANT,
      p_actor_id: OWNER,
    });
    expect(error).toBeNull();

    const state = await inTx((tx) => readAccessState(tx, TENANT, TECH_ACTIVE));
    expect(state.attendance_enabled).toBe(true);
    expect(state.access_state).toBe('active');
  });

  maybeIt('a future start date reads upcoming (FR-2, invited-technician flow)', async () => {
    await inTx(async (tx) => {
      await insertAssignment(tx, TENANT, TECH_UPCOMING, OFFICE_B, FUTURE_START);
      await insertEnrolment(tx, TENANT, TECH_UPCOMING, FUTURE_START);
    });
    const state = await inTx((tx) =>
      readAccessState(tx, TENANT, TECH_UPCOMING),
    );
    expect(state.access_state).toBe('upcoming');
    expect(state.attendance_start_date).toBe(FUTURE_START);
  });

  maybeIt('reassignment moves the live office (FR-6) without touching the enrolment', async () => {
    await inTx(async (tx) => {
      const assignments = await readAssignments(tx, TECH_ACTIVE);
      // Clip the covering assignment at today and re-insert at office B —
      // the AD-8 algorithm the service runs for reassignment.
      const covering = assignments.find(
        (a) => rangeStart(a.valid) <= today && coversTodayOrLater(a.valid, today),
      );
      if (covering) {
        // A covering range starting exactly today is DELETED (clipping it
        // would make the range empty — the isempty CHECK); an earlier-
        // starting covering range is clipped at today (AD-8).
        if (rangeStart(covering.valid) === today) {
          await deleteRanges(tx, 'attendance_office_assignments', [covering.id]);
        } else {
          await clipRangeEnd(tx, 'attendance_office_assignments', covering.id, today);
        }
      }
      await insertAssignment(tx, TENANT, TECH_ACTIVE, OFFICE_B, today);
      void readEnrolments;
    });

    const state = await inTx((tx) => readAccessState(tx, TENANT, TECH_ACTIVE));
    expect(state.access_state).toBe('active');
    expect(state.office_id).toBe(OFFICE_B);
    expect(state.office_name).toBe('probe office B');
  });

  maybeIt('the holiday fan-out executes and its rows match the notification registry (Spec-15-5 deferred item)', async () => {
    // Both technicians cover the holiday date (active + upcoming periods).
    const { data: holidayId, error } = await admin.rpc('attendance_add_holiday', {
      p_tenant_id: TENANT,
      p_holiday_date: FUTURE_HOLIDAY,
      p_name: 'Probe Christmas',
    });
    expect(error).toBeNull();

    const { data: rows } = await admin
      .from('notifications')
      .select('*')
      .eq('tenant_id', TENANT)
      .eq('event_type', ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_ADDED);
    expect(rows).toHaveLength(2);
    for (const row of rows ?? []) {
      expect(row.entity_type).toBe(ATTENDANCE_ENTITY_TYPE);
      expect(row.entity_id).toBe(holidayId);
      // Registry-contract assertion at the DB boundary (import-the-registry
      // style): the persisted literals must exist in the backend registry.
      expect(
        Object.values(ATTENDANCE_NOTIFICATION_EVENT_REGISTRY).some(
          (meta) => meta.eventType === row.event_type,
        ),
      ).toBe(true);
      expect(row.payload).toEqual({
        holidayName: 'Probe Christmas',
        holidayDate: FUTURE_HOLIDAY,
      });
      expect(row.dedupe_key).toBe(
        `${TENANT}:attendance.holiday_added:${row.user_id}:${holidayId}`,
      );
      expect(row.job_id).toBeNull();
    }

    // Removal fans holiday_removed for the same recipients.
    const { error: removeError } = await admin.rpc('attendance_remove_holiday', {
      p_tenant_id: TENANT,
      p_holiday_id: holidayId as string,
    });
    expect(removeError).toBeNull();
    const { data: removed } = await admin
      .from('notifications')
      .select('*')
      .eq('tenant_id', TENANT)
      .eq('event_type', ATTENDANCE_NOTIFICATION_EVENT.HOLIDAY_REMOVED);
    expect(removed).toHaveLength(2);
    await admin.from('notifications').delete().eq('tenant_id', TENANT);
  });

  maybeIt('coverage guard: an unpaired enrolment is rejected at COMMIT with the GAP hint', async () => {
    // Bounded and disjoint from TECH_UPCOMING's open period, so the
    // exclusion constraint cannot fire first — the COMMIT-time rejection
    // exercised here is the coverage guard itself.
    await expect(
      inTx(async (tx) => {
        await tx.query(
          `insert into public.attendance_enrolments (tenant_id, employee_id, valid)
           values ($1, $2, daterange('2026-10-01', '2027-02-28', '[)'))`,
          [TENANT, TECH_UPCOMING],
        );
      }),
    ).rejects.toMatchObject({ code: '23514', hint: 'ATTENDANCE_ASSIGNMENT_GAP' });
  });

  maybeIt('cancelling a future start deletes the rows outright (access none)', async () => {
    await inTx(async (tx) => {
      const [assignments, enrolments] = await Promise.all([
        readAssignments(tx, TECH_UPCOMING),
        readEnrolments(tx, TECH_UPCOMING),
      ]);
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
    const state = await inTx((tx) => readAccessState(tx, TENANT, TECH_UPCOMING));
    expect(state.access_state).toBe('none');
  });

  maybeIt('disabling after a past period CLIPS the history (history_only); re-enable starts a new period', async () => {
    // Simulate a day having passed: rewind the open period's start behind
    // today (both tables in ONE transaction — the deferred coverage trigger
    // validates the pair at COMMIT).
    await inTx(async (tx) => {
      await tx.query(
        `update public.attendance_enrolments
           set valid = daterange(current_date - 3, null, '[)')
         where employee_id = $1`,
        [TECH_ACTIVE],
      );
      await tx.query(
        `update public.attendance_office_assignments
           set valid = daterange(current_date - 3, null, '[)')
         where employee_id = $1`,
        [TECH_ACTIVE],
      );
    });

    // Disable: the covering ranges start BEFORE today → clipped, not deleted.
    await inTx(async (tx) => {
      const clip = async (
        table: 'attendance_enrolments' | 'attendance_office_assignments',
        rows: RangeRow[],
      ) => {
        for (const row of rows) {
          if (coversTodayOrLater(row.valid, today)) {
            await clipRangeEnd(tx, table, row.id, today);
          }
        }
      };
      await clip('attendance_office_assignments', await readAssignments(tx, TECH_ACTIVE));
      await clip('attendance_enrolments', await readEnrolments(tx, TECH_ACTIVE));
    });

    const state = await inTx((tx) => readAccessState(tx, TENANT, TECH_ACTIVE));
    expect(state.access_state).toBe('history_only');

    // The residual row is the closed period — history kept read-only.
    const residual = await pool.query(
      'select valid::text from public.attendance_enrolments where employee_id = $1',
      [TECH_ACTIVE],
    );
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000)
      .toISOString()
      .slice(0, 10);
    expect(residual.rows[0].valid).toBe(`[${threeDaysAgo},${today})`);

    // Re-enable: a new open period with a fresh enabled_at; the gap reads
    // Not tracked (Epic 16's day context), and BOTH periods survive.
    await inTx(async (tx) => {
      await insertAssignment(tx, TENANT, TECH_ACTIVE, OFFICE_A, today);
      await insertEnrolment(tx, TENANT, TECH_ACTIVE, today);
    });
    const periods = await pool.query(
      'select lower(valid)::text as s from public.attendance_enrolments where employee_id = $1 order by s',
      [TECH_ACTIVE],
    );
    expect(periods.rows).toHaveLength(2);
    expect(periods.rows[1].s).toBe(today);

    const reenabled = await inTx((tx) =>
      readAccessState(tx, TENANT, TECH_ACTIVE),
    );
    expect(reenabled.access_state).toBe('active');
  });

  maybeIt('archive blockers: the active assignment blocks; after disable the archive succeeds (FR-5)', async () => {
    // TECH_ACTIVE's current period sits on OFFICE_A (re-enabled there after
    // the rewind/clip above; the earlier B leg is closed history).
    const { data: blockers, error: previewError } = await admin.rpc(
      'attendance_office_archive_blockers',
      { p_tenant_id: TENANT, p_office_id: OFFICE_A },
    );
    expect(previewError).toBeNull();
    expect(
      (blockers ?? []).map((b: { employee_id: string }) => b.employee_id),
    ).toContain(TECH_ACTIVE);

    // The archive write itself refuses (shared predicate — no copy-paste).
    const { error: archiveError } = await admin.rpc('attendance_archive_office', {
      p_tenant_id: TENANT,
      p_actor_id: OWNER,
      p_office_id: OFFICE_A,
    });
    expect(archiveError?.hint).toBe('ATTENDANCE_OFFICE_ARCHIVE_BLOCKED');

    // Disable (today-starting period → cancelled outright) → archive succeeds.
    await inTx(async (tx) => {
      const assignments = await readAssignments(tx, TECH_ACTIVE);
      const enrolments = await readEnrolments(tx, TECH_ACTIVE);
      await deleteRanges(
        tx,
        'attendance_office_assignments',
        assignments
          .filter((r) => rangeStart(r.valid) === today)
          .map((r) => r.id),
      );
      await deleteRanges(
        tx,
        'attendance_enrolments',
        enrolments
          .filter((r) => rangeStart(r.valid) === today)
          .map((r) => r.id),
      );
    });
    const { error: archiveOk } = await admin.rpc('attendance_archive_office', {
      p_tenant_id: TENANT,
      p_actor_id: OWNER,
      p_office_id: OFFICE_A,
    });
    expect(archiveOk).toBeNull();
    const { data: archived } = await admin
      .from('attendance_offices')
      .select('archived_at')
      .eq('id', OFFICE_A)
      .single();
    expect(archived?.archived_at).not.toBeNull();

    // And the lifecycle still works afterwards: the closed history is
    // covered by the (now archived) office — re-enabling at the LIVE
    // office B must NOT hit the coverage guard (review regression probe).
    await inTx(async (tx) => {
      await insertAssignment(tx, TENANT, TECH_ACTIVE, OFFICE_B, today);
      await insertEnrolment(tx, TENANT, TECH_ACTIVE, today);
    });
    const state = await inTx((tx) => readAccessState(tx, TENANT, TECH_ACTIVE));
    expect(state.access_state).toBe('active');
  });

  // ── Story 15-9 pre-patch regression (20260928000001) ─────────────────
  // The shipped view anchored the office join at the enrolment's period
  // start, so an employee enrolled BEFORE today kept reading the OLD
  // office forever after a reassignment — in the roster, me/access and
  // /users/me alike. Every earlier probe here enrolled at `today`, the
  // one case where period_start = today masks the bug; TECH_PAST's
  // backdated period is the case that broke. Runs last: while these rows
  // exist the holiday fan-out's exact recipient count would not hold.
  maybeIt('15-9 pre-patch: the view reads TODAY\'s office after a reassignment of a backdated period', async () => {
    // Backdated period: enrolment + assignment [today-3, ∞) at office B —
    // both tables in ONE transaction (the deferred coverage trigger
    // validates the pair at COMMIT).
    const past = await pool.query(
      'select (public.attendance_today($1) - 3)::text as d',
      [TENANT],
    );
    const pastStart = past.rows[0].d;
    await inTx(async (tx) => {
      await insertAssignment(tx, TENANT, TECH_PAST, OFFICE_B, pastStart);
      await insertEnrolment(tx, TENANT, TECH_PAST, pastStart);
    });

    const before = await inTx((tx) => readAccessState(tx, TENANT, TECH_PAST));
    expect(before.access_state).toBe('active');
    expect(before.attendance_start_date).toBe(pastStart);
    expect(before.office_id).toBe(OFFICE_B);

    // The AD-8 reassignment plan (assignments only): clip the covering leg
    // at today, insert office C from today. The enrolment is untouched —
    // the period start STAYS behind today, which is exactly what the old
    // anchor got wrong.
    await inTx(async (tx) => {
      const assignments = await readAssignments(tx, TECH_PAST);
      const covering = assignments.find(
        (a) => rangeStart(a.valid) <= today && coversTodayOrLater(a.valid, today),
      );
      if (!covering) {
        throw new Error('fixture drift: no covering assignment leg');
      }
      await clipRangeEnd(
        tx,
        'attendance_office_assignments',
        covering.id,
        today,
      );
      await insertAssignment(tx, TENANT, TECH_PAST, OFFICE_C, today);
    });

    // THE regression assertion: the view must report the office covering
    // TODAY (C) — the shipped view returned B forever here.
    const after = await inTx((tx) => readAccessState(tx, TENANT, TECH_PAST));
    expect(after.access_state).toBe('active');
    expect(after.office_id).toBe(OFFICE_C);
    expect(after.office_name).toBe('probe office C');

    // A SCHEDULED future move stays invisible until it takes effect: move
    // back to office B effective FUTURE_START (clip C there, insert B) —
    // every read keeps showing C, the assignment covering today.
    await inTx(async (tx) => {
      const assignments = await readAssignments(tx, TECH_PAST);
      const covering = assignments.find(
        (a) =>
          rangeStart(a.valid) <= FUTURE_START &&
          coversTodayOrLater(a.valid, FUTURE_START),
      );
      if (!covering) {
        throw new Error('fixture drift: no leg covering the future date');
      }
      await clipRangeEnd(
        tx,
        'attendance_office_assignments',
        covering.id,
        FUTURE_START,
      );
      await insertAssignment(tx, TENANT, TECH_PAST, OFFICE_B, FUTURE_START);
    });
    const scheduled = await inTx((tx) =>
      readAccessState(tx, TENANT, TECH_PAST),
    );
    expect(scheduled.access_state).toBe('active');
    expect(scheduled.office_id).toBe(OFFICE_C);
    expect(scheduled.attendance_start_date).toBe(pastStart);
  });
});
