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
  removeCrews,
  resetWeeklyOff,
  seedDefault,
  tenantToday,
} from './helpers/weekly-off-fixture';

/**
 * attendance_set_weekly_off_default — queued clears, configured marker, failures. Spans are shown
 * as [fromOffset, toOffset|null, days] relative to the tenant's today (T).
 * Throwaway tenants only; every case ends with the no-overlap invariant.
 */
jest.setTimeout(120_000);

describe('weekly-off default RPC: clears and marker (real DB)', () => {
  requireRealDbWhenAsked();
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let pool: Pool;
  let admin: SupabaseClient;
  let crew: Crew;
  let other: Crew;
  let T: string;

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    ({ pool, admin } = openClients());
    crew = await createCrew(admin, 0);
    other = await createCrew(admin, 0);
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
    await resetWeeklyOff(admin, [crew, other], false);
  });

  const save = (days: number[], from: number | null, c: Crew = crew) =>
    admin.rpc('attendance_set_weekly_off_default', {
      p_tenant_id: c.tenant,
      p_days: days,
      p_effective_from: from === null ? null : addDays(T, from),
    });
  const ok = async (days: number[], from: number | null, c: Crew = crew) => {
    const r = await save(days, from, c);
    if (r.error) throw new Error(`rpc failed: ${r.error.message}`);
  };
  const rows = async (c: Crew = crew): Promise<Span[]> => {
    const s = await defaultSpans(pool, c.tenant, T);
    expect(await overlapCount(pool, [crew.tenant, other.tenant])).toBe(0);
    return s;
  };
  const configuredAt = async (c: Crew = crew) =>
    (
      await pool.query<{ v: string | null }>(
        'select weekly_off_configured_at::text as v from public.tenants where id = $1',
        [c.tenant],
      )
    ).rows[0].v;

  describe('queued "no day off" (clear)', () => {
    maybeIt('a queued clear moves to a later date', async () => {
      await seedDefault(pool, crew.tenant, T, -10, null, [6]);
      await ok([], 5);
      expect(await rows()).toEqual([[-10, 5, [6]]]);
      await ok([], 9);
      expect(await rows()).toEqual([[-10, 9, [6]]]);
    });

    maybeIt('a queued clear can be pulled earlier', async () => {
      await seedDefault(pool, crew.tenant, T, -10, null, [6]);
      await ok([], 9);
      await ok([], 5);
      expect(await rows()).toEqual([[-10, 5, [6]]]);
    });

    maybeIt(
      'clear when nothing is queued is a plain clear from that date',
      async () => {
        await seedDefault(pool, crew.tenant, T, -10, null, [6]);
        await ok([], 0);
        expect(await rows()).toEqual([[-10, 0, [6]]]);
      },
    );

    maybeIt(
      'clear when no rule exists leaves no row but stamps configured',
      async () => {
        await ok([], 0);
        expect(await rows()).toEqual([]);
        expect(await configuredAt()).not.toBeNull();
      },
    );

    maybeIt(
      'a clear moved later stretches the queued rule that precedes it, not older ones',
      async () => {
        await seedDefault(pool, crew.tenant, T, -10, 5, [6]);
        await seedDefault(pool, crew.tenant, T, 5, 9, [7]);
        await ok([], 12);
        expect(await rows()).toEqual([
          [-10, 5, [6]],
          [5, 12, [7]],
        ]);
      },
    );

    maybeIt(
      'a rule that ended in the past is never stretched by a later clear',
      async () => {
        await seedDefault(pool, crew.tenant, T, -10, -3, [6]);
        await ok([], 4);
        expect(await rows()).toEqual([[-10, -3, [6]]]);
      },
    );

    maybeIt('clear does not touch another tenant', async () => {
      await seedDefault(pool, crew.tenant, T, -10, null, [6]);
      await seedDefault(pool, other.tenant, T, -10, 5, [6]);
      await ok([], 5);
      await ok([], 9);
      expect(await rows(other)).toEqual([[-10, 5, [6]]]);
    });

    maybeIt(
      'a new rule saved after a queued clear fills the gap correctly',
      async () => {
        await seedDefault(pool, crew.tenant, T, -10, null, [6]);
        await ok([], 5);
        await ok([7], 9);
        expect(await rows()).toEqual([
          [-10, 5, [6]],
          [9, null, [7]],
        ]);
      },
    );
  });

  describe('R-11 configured marker', () => {
    maybeIt('is NULL before any save', async () => {
      expect(await configuredAt()).toBeNull();
    });

    maybeIt('is set by a save of EMPTY days', async () => {
      await ok([], 0);
      expect(await configuredAt()).not.toBeNull();
    });

    maybeIt('is set by a normal save', async () => {
      await ok([7], 0);
      expect(await configuredAt()).not.toBeNull();
    });

    maybeIt(
      'is stable: later saves and clears never reset or re-stamp it',
      async () => {
        await ok([], 0);
        const first = await configuredAt();
        await ok([7], 0);
        await ok([], 3);
        await ok([6], 9);
        expect(await configuredAt()).toBe(first);
      },
    );

    maybeIt('saving one tenant does not configure another', async () => {
      await ok([7], 0);
      expect(await configuredAt(other)).toBeNull();
    });
  });

  maybeIt('unknown tenant fails loudly and writes nothing', async () => {
    const r = await admin.rpc('attendance_set_weekly_off_default', {
      p_tenant_id: '00000000-0000-4000-8000-000000000000',
      p_days: [7],
      p_effective_from: T,
    });
    expect(r.error?.code).toBe('PT404');
    expect(
      (
        await pool.query(
          'select 1 from public.attendance_weekly_off_defaults where tenant_id = $1',
          ['00000000-0000-4000-8000-000000000000'],
        )
      ).rowCount,
    ).toBe(0);
  });

  maybeIt(
    'out-of-range weekday (0, 8) is rejected by the DB check (23514)',
    async () => {
      expect((await save([0], 0)).error?.code).toBe('23514');
      expect((await save([8], 0)).error?.code).toBe('23514');
      expect(await rows()).toEqual([]);
      expect(await configuredAt()).toBeNull();
    },
  );

  maybeIt('NULL p_days is rejected and writes nothing', async () => {
    const r = await admin.rpc('attendance_set_weekly_off_default', {
      p_tenant_id: crew.tenant,
      p_days: null,
      p_effective_from: T,
    });
    // Contract: a NULL selection is malformed input, not "clear all".
    expect(r.error?.code).toBe('23514');
    expect(await rows()).toEqual([]);
    expect(await configuredAt()).toBeNull();
  });
});
