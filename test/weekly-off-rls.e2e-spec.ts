import { SupabaseClient, createClient } from '@supabase/supabase-js';
import { Pool, PoolClient } from 'pg';
import {
  IS_REAL_DB,
  requireRealDbWhenAsked,
  Crew,
  createCrew,
  defaultSpans,
  must,
  openClients,
  overrideSpans,
  removeCrews,
  tenantToday,
} from './helpers/weekly-off-fixture';

/**
 * Deny-by-default: only the service role may touch the weekly-off tables or
 * run their RPCs. The tables keep Supabase's default table grants, so the
 * protection is RLS-enabled-with-no-policies; these tests prove that
 * behaviourally as `anon` (supabase-js, anon key) and as `authenticated`
 * (SET ROLE with the tenant owner's claims — the strongest legitimate
 * caller), and check the catalog (RLS on, no policies, no EXECUTE).
 */
jest.setTimeout(120_000);

const TABLES = [
  'attendance_weekly_off_defaults',
  'attendance_weekly_off_overrides',
];
const FUNCTIONS = [
  'attendance_set_weekly_off_default',
  'attendance_set_weekly_off_override',
  'attendance_remove_weekly_off_override',
];
const ROLES = ['anon', 'authenticated'];
const ANON_KEY = process.env['SUPABASE_ANON_KEY'] ?? '';
const FAR = '[2040-01-01,2040-02-01)';

describe('weekly-off RLS and permissions (real DB)', () => {
  requireRealDbWhenAsked();
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let pool: Pool;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  let crew: Crew;
  let T: string;

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    ({ pool, admin } = openClients());
    try {
      crew = await createCrew(admin, 1);
      T = await tenantToday(pool, crew.tenant);
      anon = createClient(process.env['SUPABASE_URL'] as string, ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    } catch (err) {
      await removeCrews(admin, [crew]).catch(() => undefined);
      await pool.end();
      throw err;
    }
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
    must(
      await admin
        .from('attendance_weekly_off_overrides')
        .delete()
        .eq('tenant_id', crew.tenant),
    );
    must(
      await admin
        .from('attendance_weekly_off_defaults')
        .delete()
        .eq('tenant_id', crew.tenant),
    );
    must(
      await admin.rpc('attendance_set_weekly_off_default', {
        p_tenant_id: crew.tenant,
        p_days: [7],
        p_effective_from: T,
      }),
    );
    must(
      await admin.rpc('attendance_set_weekly_off_override', {
        p_tenant_id: crew.tenant,
        p_employee_id: crew.staff[0],
        p_days: [6],
        p_effective_from: T,
      }),
    );
  });

  /** Both rule tables are still exactly as seeded (nothing leaked in or out). */
  const intact = async () => {
    expect(await defaultSpans(pool, crew.tenant, T)).toEqual([[0, null, [7]]]);
    expect(await overrideSpans(pool, crew.staff[0], T)).toEqual([
      [0, null, [6]],
    ]);
  };

  describe('catalog', () => {
    maybeIt('RLS is enabled on both tables', async () => {
      const r = await pool.query<{ relname: string; relrowsecurity: boolean }>(
        'select relname, relrowsecurity from pg_class where oid = any($1::regclass[])',
        [TABLES.map((t) => `public.${t}`)],
      );
      expect(r.rows.map((x) => x.relname).sort()).toEqual([...TABLES].sort());
      expect(r.rows.every((x) => x.relrowsecurity)).toBe(true);
    });

    maybeIt('no policy lets anon/authenticated/public in', async () => {
      const r = await pool.query(
        'select policyname, roles from pg_policies where schemaname = $1 and tablename = any($2)',
        ['public', TABLES],
      );
      expect(r.rows).toEqual([]);
    });

    maybeIt(
      'the three RPCs exist and anon/authenticated cannot EXECUTE them',
      async () => {
        const r = await pool.query<{ f: string; role: string; ok: boolean }>(
          `select p.proname as f, r as role, has_function_privilege(r, p.oid, 'execute') as ok
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
                unnest($2::text[]) r
          where n.nspname = 'public' and p.proname = any($1)`,
          [FUNCTIONS, ROLES],
        );
        expect(new Set(r.rows.map((x) => x.f))).toEqual(new Set(FUNCTIONS));
        expect(r.rows).toHaveLength(FUNCTIONS.length * ROLES.length);
        expect(r.rows.filter((x) => x.ok)).toEqual([]);
      },
    );
  });

  describe('anon key (supabase-js)', () => {
    maybeIt('the anon key is a real key', () => {
      expect(ANON_KEY.length).toBeGreaterThan(40);
      expect(ANON_KEY).not.toBe('test-anon-key');
    });

    for (const t of TABLES) {
      maybeIt(`${t}: reads see no rows`, async () => {
        const r = await anon.from(t).select('*').eq('tenant_id', crew.tenant);
        expect(Array.isArray(r.data) ? r.data : []).toHaveLength(0);
      });

      maybeIt(`${t}: update and delete change nothing`, async () => {
        await anon
          .from(t)
          .update({ days: [1] })
          .eq('tenant_id', crew.tenant);
        await anon.from(t).delete().eq('tenant_id', crew.tenant);
        await intact();
      });
    }

    maybeIt('insert into defaults is rejected', async () => {
      const r = await anon
        .from('attendance_weekly_off_defaults')
        .insert({ tenant_id: crew.tenant, valid: FAR, days: [1] });
      expect(r.error).not.toBeNull();
      await intact();
    });

    maybeIt('insert into overrides is rejected', async () => {
      const r = await anon.from('attendance_weekly_off_overrides').insert({
        employee_id: crew.staff[0],
        tenant_id: crew.tenant,
        valid: FAR,
        days: [1],
      });
      expect(r.error).not.toBeNull();
      await intact();
    });

    for (const f of FUNCTIONS) {
      maybeIt(`${f}: cannot be called`, async () => {
        const r = await anon.rpc(f, {
          p_tenant_id: crew.tenant,
          p_employee_id: crew.staff[0],
          p_days: [1],
          p_effective_from: T,
        });
        expect(r.error).not.toBeNull();
        await intact();
      });
    }
  });

  describe('authenticated role (company admin claims, SET ROLE)', () => {
    /** Run `fn` inside a rolled-back transaction as `authenticated`. */
    const asOwner = async <R>(
      fn: (c: PoolClient) => Promise<R>,
    ): Promise<R> => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: crew.owner, role: 'authenticated' }),
        ]);
        await c.query('set local role authenticated');
        return await fn(c);
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
      }
    };
    /** A statement that must fail inside the transaction (savepoint keeps it usable). */
    const fails = async (c: PoolClient, sql: string, args: unknown[] = []) => {
      await c.query('savepoint s');
      await expect(c.query(sql, args)).rejects.toMatchObject({ code: '42501' });
      await c.query('rollback to savepoint s');
    };

    for (const t of TABLES) {
      maybeIt(`${t}: sees no rows, updates and deletes hit none`, async () => {
        await asOwner(async (c) => {
          expect((await c.query(`select * from public.${t}`)).rowCount).toBe(0);
          expect(
            (await c.query(`update public.${t} set days = '{1}'`)).rowCount,
          ).toBe(0);
          expect((await c.query(`delete from public.${t}`)).rowCount).toBe(0);
        });
        await intact();
      });
    }

    maybeIt('inserts are rejected by RLS', async () => {
      await asOwner(async (c) => {
        await fails(
          c,
          `insert into public.attendance_weekly_off_defaults (tenant_id, valid, days) values ($1, $2, '{1}')`,
          [crew.tenant, FAR],
        );
        await fails(
          c,
          `insert into public.attendance_weekly_off_overrides (employee_id, tenant_id, valid, days) values ($1, $2, $3, '{1}')`,
          [crew.staff[0], crew.tenant, FAR],
        );
      });
      await intact();
    });

    maybeIt(
      'the RPCs are permission-denied, even for the company admin',
      async () => {
        await asOwner(async (c) => {
          await fails(
            c,
            `select public.attendance_set_weekly_off_default($1, '{1}', $2)`,
            [crew.tenant, T],
          );
          await fails(
            c,
            `select public.attendance_set_weekly_off_override($1, $2, '{1}', $3)`,
            [crew.tenant, crew.staff[0], T],
          );
          await fails(
            c,
            `select public.attendance_remove_weekly_off_override($1, $2, $3)`,
            [crew.tenant, crew.staff[0], T],
          );
        });
        await intact();
      },
    );
  });
});
