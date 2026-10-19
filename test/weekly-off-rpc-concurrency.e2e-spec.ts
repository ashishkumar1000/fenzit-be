import { SupabaseClient } from '@supabase/supabase-js';
import { Pool } from 'pg';
import {
  IS_REAL_DB,
  requireRealDbWhenAsked,
  Crew,
  addDays,
  createCrew,
  defaultSpans,
  openClients,
  overlapCount,
  overrideSpans,
  removeCrews,
  resetWeeklyOff,
  tenantToday,
} from './helpers/weekly-off-fixture';

/**
 * Two saves racing for the same tenant (default RPC) or the same employee
 * (override RPC), with different days: the RPC lock must serialise them, so
 * both succeed, nothing overlaps and exactly one rule stays open-ended.
 */
jest.setTimeout(120_000);

describe('weekly-off RPC concurrency (real DB)', () => {
  requireRealDbWhenAsked();
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let pool: Pool;
  let admin: SupabaseClient;
  let crew: Crew;
  let T: string;

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    ({ pool, admin } = openClients());
    crew = await createCrew(admin, 1);
  });

  afterAll(async () => {
    if (!IS_REAL_DB) return;
    try {
      await removeCrews(admin, [crew]);
    } finally {
      await pool?.end();
    }
  });

  beforeEach(async () => {
    if (!IS_REAL_DB) return;
    T = await tenantToday(pool, crew.tenant);
    await resetWeeklyOff(admin, [crew], true);
  });

  const failures = (rs: PromiseSettledResult<{ error: unknown }>[]) =>
    rs.filter((r) => r.status === 'rejected' || r.value.error !== null);

  maybeIt('two different-day default saves converge cleanly', async () => {
    const save = (days: number[]) =>
      admin.rpc('attendance_set_weekly_off_default', {
        p_tenant_id: crew.tenant,
        p_days: days,
        p_effective_from: addDays(T, 0),
      });
    const rs = await Promise.allSettled([save([6]), save([7])]);
    expect(failures(rs)).toEqual([]);
    expect(await overlapCount(pool, [crew.tenant])).toBe(0);
    const open = (await defaultSpans(pool, crew.tenant, T)).filter(
      (s) => s[1] === null,
    );
    expect(open).toHaveLength(1);
    expect([[6], [7]]).toContainEqual(open[0][2]);
  });

  maybeIt('two different-day override saves converge cleanly', async () => {
    const emp = crew.staff[0];
    const save = (days: number[]) =>
      admin.rpc('attendance_set_weekly_off_override', {
        p_tenant_id: crew.tenant,
        p_employee_id: emp,
        p_days: days,
        p_effective_from: addDays(T, 0),
      });
    const rs = await Promise.allSettled([save([6]), save([7])]);
    expect(failures(rs)).toEqual([]);
    expect(await overlapCount(pool, [crew.tenant])).toBe(0);
    const open = (await overrideSpans(pool, emp, T)).filter(
      (s) => s[1] === null,
    );
    expect(open).toHaveLength(1);
    expect([[6], [7]]).toContainEqual(open[0][2]);
  });
});
