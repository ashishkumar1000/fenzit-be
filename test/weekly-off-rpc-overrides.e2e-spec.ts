import { SupabaseClient } from '@supabase/supabase-js';
import { Pool } from 'pg';
import {
  IS_REAL_DB,
  requireRealDbWhenAsked,
  Crew,
  Span,
  addDays,
  createCrew,
  defaultSpans,
  openClients,
  overlapCount,
  overrideSpans,
  must,
  removeCrews,
  resetWeeklyOff,
  tenantToday,
} from './helpers/weekly-off-fixture';

/**
 * attendance_set_weekly_off_override(p_tenant_id, p_employee_id, p_days,
 * p_effective_from) — real DB, service role. Spans are [from, to|null, days]
 * as offsets from the tenant's today (T). Two employees (A, B) in one tenant
 * and one employee (C) in another prove per-employee and per-tenant isolation.
 */
jest.setTimeout(120_000);

describe('weekly-off override RPC (real DB)', () => {
  requireRealDbWhenAsked();
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let pool: Pool;
  let admin: SupabaseClient;
  let crew: Crew;
  let other: Crew;
  let T: string;
  let A: string;
  let B: string;
  let C: string;

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    ({ pool, admin } = openClients());
    crew = await createCrew(admin, 2);
    other = await createCrew(admin, 1);
    [A, B] = crew.staff;
    [C] = other.staff;
  });

  afterAll(async () => {
    if (!IS_REAL_DB) return;
    try {
      await removeCrews(admin, [crew, other]);
    } finally {
      await pool?.end();
    }
  });

  beforeEach(async () => {
    if (!IS_REAL_DB) return;
    T = await tenantToday(pool, crew.tenant);
    await resetWeeklyOff(admin, [crew, other], true);
  });

  const save = (
    emp: string,
    days: number[],
    from: number | null,
    c: Crew = crew,
  ) =>
    admin.rpc('attendance_set_weekly_off_override', {
      p_tenant_id: c.tenant,
      p_employee_id: emp,
      p_days: days,
      p_effective_from: from === null ? null : addDays(T, from),
    });
  const ok = async (
    emp: string,
    days: number[],
    from: number | null,
    c: Crew = crew,
  ) => {
    const r = await save(emp, days, from, c);
    if (r.error) throw new Error(`rpc failed: ${r.error.message}`);
  };
  const rows = async (emp: string): Promise<Span[]> => {
    const s = await overrideSpans(pool, emp, T);
    expect(await overlapCount(pool, [crew.tenant, other.tenant])).toBe(0);
    return s;
  };

  maybeIt('first save starts one open-ended rule; dedupes days', async () => {
    await ok(A, [7, 6, 7], null);
    expect(await rows(A)).toEqual([[0, null, [6, 7]]]);
  });

  maybeIt(
    'empty days is stored as the works-all-7-days marker row',
    async () => {
      await ok(A, [], 0);
      expect(await rows(A)).toEqual([[0, null, []]]);
    },
  );

  maybeIt(
    'past dates clamp to today (replaces a rule that started today)',
    async () => {
      await ok(A, [6], 0);
      await ok(A, [7], -9);
      expect(await rows(A)).toEqual([[0, null, [7]]]);
    },
  );

  maybeIt(
    'all seven days: PT422 ATTENDANCE_NO_WORKING_DAYS, nothing written',
    async () => {
      const r = await save(A, [1, 2, 3, 4, 5, 6, 7], 0);
      expect(r.error?.code).toBe('PT422');
      expect(r.error?.hint).toBe('ATTENDANCE_NO_WORKING_DAYS');
      expect(await rows(A)).toEqual([]);
    },
  );

  maybeIt(
    'R-20 move: same days from a later date moves the queued rule',
    async () => {
      await ok(A, [6], 0);
      await ok(A, [7], 5);
      await ok(A, [7], 9);
      expect(await rows(A)).toEqual([
        [0, 9, [6]],
        [9, null, [7]],
      ]);
    },
  );

  maybeIt('move applies to the empty-days marker too', async () => {
    await ok(A, [6], 0);
    await ok(A, [], 5);
    await ok(A, [], 9);
    expect(await rows(A)).toEqual([
      [0, 9, [6]],
      [9, null, []],
    ]);
  });

  maybeIt('same days from an EARLIER date is a normal replace', async () => {
    await ok(A, [6], 0);
    await ok(A, [7], 9);
    await ok(A, [7], 5);
    expect(await rows(A)).toEqual([
      [0, 5, [6]],
      [5, null, [7]],
    ]);
  });

  maybeIt('different days from a later date is NOT a move', async () => {
    await ok(A, [6], 0);
    await ok(A, [7], 5);
    await ok(A, [1], 9);
    expect(await rows(A)).toEqual([
      [0, 5, [6]],
      [5, 9, [7]],
      [9, null, [1]],
    ]);
  });

  maybeIt(
    'queued rule is the first ever: it just starts at the new date',
    async () => {
      await ok(A, [7], 5);
      await ok(A, [7], 9);
      expect(await rows(A)).toEqual([[9, null, [7]]]);
    },
  );

  maybeIt('moving A never touches B (same days, same dates)', async () => {
    for (const e of [A, B]) {
      await ok(e, [6], 0);
      await ok(e, [7], 5);
    }
    const bBefore = await rows(B);
    await ok(A, [7], 9);
    expect(await rows(A)).toEqual([
      [0, 9, [6]],
      [9, null, [7]],
    ]);
    expect(await rows(B)).toEqual(bBefore);
    expect(bBefore).toEqual([
      [0, 5, [6]],
      [5, null, [7]],
    ]);
  });

  maybeIt(
    "moving A's empty marker never touches B's empty marker",
    async () => {
      for (const e of [A, B]) {
        await ok(e, [6], 0);
        await ok(e, [], 5);
      }
      await ok(A, [], 9);
      expect(await rows(B)).toEqual([
        [0, 5, [6]],
        [5, null, []],
      ]);
    },
  );

  maybeIt('an employee override never touches the tenant default', async () => {
    must(
      await admin.rpc('attendance_set_weekly_off_default', {
        p_tenant_id: crew.tenant,
        p_days: [7],
        p_effective_from: T,
      }),
    );
    await ok(A, [6], 0);
    await ok(A, [6], 5);
    expect(await defaultSpans(pool, crew.tenant, T)).toEqual([[0, null, [7]]]);
  });

  maybeIt('other tenant stays untouched (same shape, same dates)', async () => {
    await ok(C, [6], 0, other);
    await ok(C, [7], 5, other);
    await ok(A, [6], 0);
    await ok(A, [7], 5);
    await ok(A, [7], 9);
    expect(await rows(C)).toEqual([
      [0, 5, [6]],
      [5, null, [7]],
    ]);
  });

  maybeIt(
    'tenant isolation: an employee of ANOTHER tenant is PT404 and unchanged',
    async () => {
      await ok(C, [6], 0, other);
      const r = await save(C, [7], 0, crew);
      expect(r.error?.code).toBe('PT404');
      expect(r.error?.hint).toBe('ATTENDANCE_EMPLOYEE_NOT_FOUND');
      expect(await rows(C)).toEqual([[0, null, [6]]]);
    },
  );

  maybeIt('unknown employee id is PT404', async () => {
    const r = await save('00000000-0000-4000-8000-000000000000', [7], 0);
    expect(r.error?.code).toBe('PT404');
  });

  maybeIt(
    'invited (not yet active) employee is PT422 ATTENDANCE_EMPLOYEE_NOT_ACTIVE',
    async () => {
      must(await admin.from('users').update({ status: 'invited' }).eq('id', B));
      try {
        const r = await save(B, [7], 0);
        expect(r.error?.code).toBe('PT422');
        expect(r.error?.hint).toBe('ATTENDANCE_EMPLOYEE_NOT_ACTIVE');
        expect(await rows(B)).toEqual([]);
      } finally {
        must(
          await admin.from('users').update({ status: 'active' }).eq('id', B),
        );
      }
    },
  );

  maybeIt('NULL p_days is rejected (23514) and writes nothing', async () => {
    const r = await admin.rpc('attendance_set_weekly_off_override', {
      p_tenant_id: crew.tenant,
      p_employee_id: B,
      p_days: null,
      p_effective_from: T,
    });
    // A NULL selection is malformed input; "works all 7 days" is an empty array.
    expect(r.error?.code).toBe('23514');
    expect(await rows(B)).toEqual([]);
  });
});
