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
 * attendance_set_weekly_off_default (real DB, service role). Spans are shown
 * as [fromOffset, toOffset|null, days] relative to the tenant's today (T).
 * Throwaway tenants only; every case ends with the no-overlap invariant.
 */
jest.setTimeout(120_000);

describe('weekly-off default RPC (real DB)', () => {
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

  describe('replace-from-date', () => {
    maybeIt(
      'first ever save from today starts one open-ended rule',
      async () => {
        await ok([6, 7], 0);
        expect(await rows()).toEqual([[0, null, [6, 7]]]);
      },
    );

    maybeIt('null effective date means today', async () => {
      await ok([7], null);
      expect(await rows()).toEqual([[0, null, [7]]]);
    });

    maybeIt(
      'saving from today clips the running rule and starts a new one',
      async () => {
        await seedDefault(pool, crew.tenant, T, -10, null, [6, 7]);
        await ok([7], 0);
        expect(await rows()).toEqual([
          [-10, 0, [6, 7]],
          [0, null, [7]],
        ]);
      },
    );

    maybeIt(
      'past dates clamp to today (history is never rewritten)',
      async () => {
        await seedDefault(pool, crew.tenant, T, -10, null, [6, 7]);
        await ok([1], -5);
        expect(await rows()).toEqual([
          [-10, 0, [6, 7]],
          [0, null, [1]],
        ]);
      },
    );

    maybeIt('a far-past date also clamps', async () => {
      await ok([1], -4000);
      expect(await rows()).toEqual([[0, null, [1]]]);
    });

    maybeIt('duplicate and unsorted days are deduped and sorted', async () => {
      await ok([7, 6, 7, 6, 1], 0);
      expect(await rows()).toEqual([[0, null, [1, 6, 7]]]);
    });

    maybeIt(
      'saving the identical selection twice converges to one rule',
      async () => {
        await ok([6], 0);
        await ok([6], 0);
        expect(await rows()).toEqual([[0, null, [6]]]);
      },
    );

    maybeIt(
      'a save from an earlier date wipes later queued rules',
      async () => {
        await ok([6], 0);
        await ok([7], 5);
        await ok([1], 3);
        expect(await rows()).toEqual([
          [0, 3, [6]],
          [3, null, [1]],
        ]);
      },
    );
  });

  describe('all seven days', () => {
    maybeIt(
      'raises PT422 ATTENDANCE_NO_WORKING_DAYS and changes nothing',
      async () => {
        await ok([6], 0);
        const r = await save([1, 2, 3, 4, 5, 6, 7], 0);
        expect(r.error?.code).toBe('PT422');
        expect(r.error?.hint).toBe('ATTENDANCE_NO_WORKING_DAYS');
        expect(await rows()).toEqual([[0, null, [6]]]);
      },
    );

    maybeIt(
      'a rejected first save does not stamp the configured marker',
      async () => {
        const r = await save([1, 2, 3, 4, 5, 6, 7], 0);
        expect(r.error?.hint).toBe('ATTENDANCE_NO_WORKING_DAYS');
        expect(await configuredAt()).toBeNull();
      },
    );

    maybeIt(
      '7 entries that dedupe to 2 days are accepted; 9 entries with 7 distinct days are rejected',
      async () => {
        await ok([1, 1, 1, 1, 1, 1, 2], 0);
        expect(await rows()).toEqual([[0, null, [1, 2]]]);
        const r = await save([1, 2, 3, 4, 5, 6, 7, 7, 1], 0);
        expect(r.error?.hint).toBe('ATTENDANCE_NO_WORKING_DAYS');
      },
    );

    maybeIt('6 days off is the allowed maximum', async () => {
      await ok([1, 2, 3, 4, 5, 6], 0);
      expect(await rows()).toEqual([[0, null, [1, 2, 3, 4, 5, 6]]]);
    });
  });

  describe('R-20 move a queued rule', () => {
    maybeIt(
      'same days from a later date moves the queued rule; earlier rule keeps the gap',
      async () => {
        await seedDefault(pool, crew.tenant, T, -10, null, [6]);
        await ok([7], 5);
        await ok([7], 9);
        expect(await rows()).toEqual([
          [-10, 9, [6]],
          [9, null, [7]],
        ]);
      },
    );

    maybeIt('moves repeatedly without leaving duplicates', async () => {
      await seedDefault(pool, crew.tenant, T, -10, null, [6]);
      await ok([7], 5);
      await ok([7], 9);
      await ok([7], 14);
      expect(await rows()).toEqual([
        [-10, 14, [6]],
        [14, null, [7]],
      ]);
    });

    maybeIt(
      'same days from an EARLIER date is a normal replace, not a move',
      async () => {
        await seedDefault(pool, crew.tenant, T, -10, null, [6]);
        await ok([7], 9);
        await ok([7], 5);
        expect(await rows()).toEqual([
          [-10, 5, [6]],
          [5, null, [7]],
        ]);
      },
    );

    maybeIt('same days from the SAME date is a no-op replace', async () => {
      await seedDefault(pool, crew.tenant, T, -10, null, [6]);
      await ok([7], 5);
      await ok([7], 5);
      expect(await rows()).toEqual([
        [-10, 5, [6]],
        [5, null, [7]],
      ]);
    });

    maybeIt('different days from a later date is NOT a move', async () => {
      await seedDefault(pool, crew.tenant, T, -10, null, [6]);
      await ok([7], 5);
      await ok([1], 9);
      expect(await rows()).toEqual([
        [-10, 5, [6]],
        [5, 9, [7]],
        [9, null, [1]],
      ]);
    });

    maybeIt(
      'same days in a different order/duplicates still count as the same days',
      async () => {
        await seedDefault(pool, crew.tenant, T, -10, null, [6]);
        await ok([7, 1], 5);
        await ok([1, 7, 1], 9);
        expect(await rows()).toEqual([
          [-10, 9, [6]],
          [9, null, [1, 7]],
        ]);
      },
    );

    maybeIt(
      'queued rule is the first ever: it just starts at the new date',
      async () => {
        await ok([7], 5);
        await ok([7], 9);
        expect(await rows()).toEqual([[9, null, [7]]]);
      },
    );

    maybeIt(
      'a rule that is already running (starts today) is not treated as queued',
      async () => {
        await ok([7], 0);
        await ok([7], 9);
        const s = await rows();
        expect(s[0]).toEqual([0, 9, [7]]);
        expect(s[s.length - 1][0]).toBe(9);
      },
    );

    maybeIt('a move never leaks into another tenant', async () => {
      await seedDefault(pool, crew.tenant, T, -10, null, [6]);
      await seedDefault(pool, other.tenant, T, -10, 5, [6]);
      await seedDefault(pool, other.tenant, T, 5, null, [7]);
      await ok([7], 5);
      await ok([7], 9);
      expect(await rows(other)).toEqual([
        [-10, 5, [6]],
        [5, null, [7]],
      ]);
    });
  });
});
