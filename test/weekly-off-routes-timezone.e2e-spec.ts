import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { SupabaseClient } from '@supabase/supabase-js';
import { Pool } from 'pg';
import { bearerFor, bootApp } from './helpers/weekly-off-app';
import {
  IS_REAL_DB,
  requireRealDbWhenAsked,
  Crew,
  addDays,
  createCrew,
  defaultSpans,
  openClients,
  removeCrews,
  resetWeeklyOff,
  tenantToday,
} from './helpers/weekly-off-fixture';

/**
 * Non-IST tenants. The weekly-off dates must follow the TENANT's calendar
 * day, never the server's UTC day nor IST. UTC+14 and UTC-11 are the two
 * extremes: at any moment at least one of them is on a different calendar
 * day from UTC, so the suite always exercises a real date disagreement.
 */
jest.setTimeout(120_000);

const ZONES = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'] as const;
const utcToday = () => new Date().toISOString().slice(0, 10);

describe('weekly-off routes: non-IST tenants (real DB)', () => {
  requireRealDbWhenAsked();
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let pool: Pool;
  let admin: SupabaseClient;
  const crews = new Map<string, Crew>();

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    ({ pool, admin } = openClients());
    try {
      for (const z of ZONES) crews.set(z, await createCrew(admin, 0, z));
      ({ app, jwt } = await bootApp());
    } catch (err) {
      await removeCrews(admin, [...crews.values()]).catch(() => undefined);
      await pool.end();
      throw err;
    }
  });

  afterAll(async () => {
    if (!IS_REAL_DB) return;
    try {
      await app?.close();
    } finally {
      try {
        await removeCrews(admin, [...crews.values()]);
      } finally {
        await pool?.end();
      }
    }
  });

  beforeEach(async () => {
    if (!IS_REAL_DB) return;
    await resetWeeklyOff(admin, [...crews.values()]);
  });

  const put = (c: Crew, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PUT',
      url: '/api/v1/attendance/weekly-offs',
      headers: bearerFor(jwt, c, c.owner, 'owner'),
      payload,
    });
  const view = async (c: Crew) =>
    JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/attendance/weekly-offs',
          headers: bearerFor(jwt, c, c.owner, 'owner'),
        })
      ).body,
    ) as {
      default: { validFrom: string } | null;
      next: { validFrom: string } | null;
      history: { validFrom: string }[];
    };

  maybeIt(
    'guard: right now at least one zone is on a different day from UTC',
    async () => {
      const days = new Set<string>();
      for (const c of crews.values())
        days.add(await tenantToday(pool, c.tenant));
      expect([...days].some((d) => d !== utcToday())).toBe(true);
    },
  );

  for (const zone of ZONES) {
    describe(zone, () => {
      let c: Crew;
      let T: string;
      beforeEach(async () => {
        if (!IS_REAL_DB) return;
        c = crews.get(zone) as Crew;
        T = await tenantToday(pool, c.tenant);
      });

      maybeIt('a past effectiveFrom clamps to the TENANT today', async () => {
        const r = await put(c, { days: [6], effectiveFrom: addDays(T, -3) });
        expect(r.statusCode).toBe(200);
        expect(await defaultSpans(pool, c.tenant, T)).toEqual([[0, null, [6]]]);
        expect((await view(c)).default?.validFrom).toBe(T);
      });

      maybeIt(
        'effectiveFrom = the UTC date is judged against tenant today (clamped only if it is in the tenant past)',
        async () => {
          const u = utcToday();
          const r = await put(c, { days: [6], effectiveFrom: u });
          expect(r.statusCode).toBe(200);
          const expected = u < T ? T : u;
          const v = await view(c);
          expect((v.default ?? v.next)?.validFrom).toBe(expected);
          expect(v.history[0].validFrom).toBe(expected);
        },
      );

      maybeIt(
        'a save with no effectiveFrom starts at tenant today',
        async () => {
          const r = await put(c, { days: [7] });
          expect(r.statusCode).toBe(200);
          expect(await defaultSpans(pool, c.tenant, T)).toEqual([
            [0, null, [7]],
          ]);
        },
      );

      maybeIt(
        'a queued change moved later (R-20) is relative to tenant today',
        async () => {
          await put(c, { days: [6] });
          await put(c, { days: [7], effectiveFrom: addDays(T, 5) });
          await put(c, { days: [7], effectiveFrom: addDays(T, 9) });
          expect(await defaultSpans(pool, c.tenant, T)).toEqual([
            [0, 9, [6]],
            [9, null, [7]],
          ]);
          const v = await view(c);
          expect(v.next?.validFrom).toBe(addDays(T, 9));
          expect(v.history.map((h) => h.validFrom)).toEqual([T, addDays(T, 9)]);
        },
      );
    });
  }
});
