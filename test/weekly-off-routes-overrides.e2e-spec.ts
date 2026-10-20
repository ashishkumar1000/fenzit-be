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
  must,
  openClients,
  overrideSpans,
  removeCrews,
  resetWeeklyOff,
  tenantToday,
} from './helpers/weekly-off-fixture';

/**
 * GET /attendance/weekly-offs/overrides and PUT .../overrides/:employeeId
 * through the real guards and pipes, against the real DB (DELETE lives in
 * weekly-off-routes-input.e2e-spec.ts).
 */
jest.setTimeout(120_000);

interface View {
  days: number[];
  validFrom: string;
  validTo: string | null;
}
interface OverrideBody {
  employeeId: string;
  employeeName: string;
  current: View | null;
  next: View | null;
  error_code?: string;
}

describe('weekly-off routes: overrides (real DB, real routes)', () => {
  requireRealDbWhenAsked();
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let pool: Pool;
  let admin: SupabaseClient;
  let crew: Crew;
  let other: Crew;
  let T: string;

  const owner = () => bearerFor(jwt, crew, crew.owner);
  const tech = () => bearerFor(jwt, crew, crew.staff[0]);
  const url = (emp: string) =>
    `/api/v1/attendance/weekly-offs/overrides/${emp}`;

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    ({ pool, admin } = openClients());
    try {
      crew = await createCrew(admin, 3);
      other = await createCrew(admin, 1);
      ({ app, jwt } = await bootApp());
    } catch (err) {
      await removeCrews(admin, [crew, other]).catch(() => undefined);
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
        await removeCrews(admin, [crew, other]);
      } finally {
        await pool?.end();
      }
    }
  });

  beforeEach(async () => {
    if (!IS_REAL_DB) return;
    T = await tenantToday(pool, crew.tenant);
    await resetWeeklyOff(admin, [crew, other], true);
    must(
      await admin
        .from('memberships')
        .update({ status: 'active' })
        .eq('tenant_id', crew.tenant)
        .in('user_id', crew.staff),
    );
  });

  const list = async (headers: Record<string, string> = owner()) => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/attendance/weekly-offs/overrides',
      headers,
    });
    return { status: r.statusCode, body: JSON.parse(r.body) as OverrideBody[] };
  };
  const put = async (
    emp: string,
    payload: Record<string, unknown>,
    headers: Record<string, string> = owner(),
  ) => {
    const r = await app.inject({
      method: 'PUT',
      url: url(emp),
      headers,
      payload,
    });
    return { status: r.statusCode, body: JSON.parse(r.body) as OverrideBody };
  };

  describe('PUT override', () => {
    maybeIt('company admin happy path: 200, response and DB row agree', async () => {
      const [a] = crew.staff;
      const r = await put(a, { days: [6, 7] });
      expect(r.status).toBe(200);
      expect(r.body.employeeId).toBe(a);
      expect(r.body.employeeName).toBe('wo staff 1');
      expect(r.body.current).toEqual({
        days: [6, 7],
        validFrom: T,
        validTo: null,
      });
      expect(r.body.next).toBeNull();
      expect(await overrideSpans(pool, a, T)).toEqual([[0, null, [6, 7]]]);
    });

    maybeIt('empty days = works all 7 days, stored as a real row', async () => {
      const [a] = crew.staff;
      const r = await put(a, { days: [] });
      expect(r.status).toBe(200);
      expect(r.body.current?.days).toEqual([]);
      expect(await overrideSpans(pool, a, T)).toEqual([[0, null, []]]);
    });

    maybeIt('a future effectiveFrom shows as next, current stays', async () => {
      const [a] = crew.staff;
      await put(a, { days: [6] });
      const r = await put(a, { days: [7], effectiveFrom: addDays(T, 4) });
      expect(r.status).toBe(200);
      expect(r.body.current).toEqual({
        days: [6],
        validFrom: T,
        validTo: addDays(T, 4),
      });
      expect(r.body.next).toEqual({
        days: [7],
        validFrom: addDays(T, 4),
        validTo: null,
      });
    });

    maybeIt('employee: 403 and nothing is written', async () => {
      const r = await put(crew.staff[1], { days: [6] }, tech());
      expect(r.status).toBe(403);
      expect(await overrideSpans(pool, crew.staff[1], T)).toEqual([]);
    });

    maybeIt('no token: 401 and nothing is written', async () => {
      const r = await put(crew.staff[0], { days: [6] }, {});
      expect(r.status).toBe(401);
      expect(await overrideSpans(pool, crew.staff[0], T)).toEqual([]);
    });

    maybeIt(
      'cross-tenant employee: 404, no row for either tenant',
      async () => {
        const victim = other.staff[0];
        const r = await put(victim, { days: [6] });
        expect(r.status).toBe(404);
        expect(r.body.error_code).toBe('ATTENDANCE_EMPLOYEE_NOT_FOUND');
        expect(await overrideSpans(pool, victim, T)).toEqual([]);
      },
    );

    maybeIt('unknown (well-formed) employee id: 404', async () => {
      const r = await put('00000000-0000-4000-8000-000000000001', {
        days: [6],
      });
      expect(r.status).toBe(404);
    });

    maybeIt('invited employee: 422 NOT_ACTIVE, nothing written', async () => {
      const a = crew.staff[2];
      must(
        await admin
          .from('memberships')
          .update({ status: 'invited' })
          .eq('user_id', a),
      );
      const r = await put(a, { days: [6] });
      expect(r.status).toBe(422);
      expect(r.body.error_code).toBe('ATTENDANCE_EMPLOYEE_NOT_ACTIVE');
      expect(await overrideSpans(pool, a, T)).toEqual([]);
    });

    maybeIt('7 days: 422 NO_WORKING_DAYS, existing override kept', async () => {
      const [a] = crew.staff;
      await put(a, { days: [6] });
      const r = await put(a, { days: [1, 2, 3, 4, 5, 6, 7] });
      expect(r.status).toBe(422);
      expect(r.body.error_code).toBe('ATTENDANCE_NO_WORKING_DAYS');
      expect(await overrideSpans(pool, a, T)).toEqual([[0, null, [6]]]);
    });

    maybeIt('malformed employee uuid: 400', async () => {
      const r = await put('not-a-uuid', { days: [6] });
      expect(r.status).toBe(400);
    });

    for (const [name, payload] of [
      ['day 8', { days: [8] }],
      ['duplicate days', { days: [1, 1] }],
      ['days missing', {}],
      ['bad effectiveFrom', { days: [6], effectiveFrom: '2026-02-30' }],
    ] as [string, Record<string, unknown>][]) {
      maybeIt(`${name}: 422 and nothing is written`, async () => {
        const r = await put(crew.staff[0], payload);
        expect(r.status).toBe(422);
        expect(await overrideSpans(pool, crew.staff[0], T)).toEqual([]);
      });
    }
  });

  describe('GET overrides', () => {
    maybeIt('no overrides: 200 and an empty list', async () => {
      expect(await list()).toEqual({ status: 200, body: [] });
    });

    maybeIt(
      'lists overrides sorted by employee name with current/next',
      async () => {
        const [a, b] = crew.staff;
        await put(b, { days: [7] });
        await put(a, { days: [6] });
        await put(a, { days: [5], effectiveFrom: addDays(T, 3) });
        const { status, body } = await list();
        expect(status).toBe(200);
        expect(body.map((x) => x.employeeName)).toEqual([
          'wo staff 1',
          'wo staff 2',
        ]);
        expect(body[0].current?.days).toEqual([6]);
        expect(body[0].next).toEqual({
          days: [5],
          validFrom: addDays(T, 3),
          validTo: null,
        });
        expect(body[1].current?.days).toEqual([7]);
        expect(body[1].next).toBeNull();
      },
    );

    maybeIt(
      'an employee with only a future override: current null, next set',
      async () => {
        const [a] = crew.staff;
        await put(a, { days: [6], effectiveFrom: addDays(T, 2) });
        const { body } = await list();
        expect(body).toHaveLength(1);
        expect(body[0].current).toBeNull();
        expect(body[0].next?.validFrom).toBe(addDays(T, 2));
      },
    );

    maybeIt(
      'tenant isolation: each company admin sees only own overrides',
      async () => {
        await put(crew.staff[0], { days: [6] });
        const otherOwner = bearerFor(jwt, other, other.owner);
        await put(other.staff[0], { days: [7] }, otherOwner);
        const mine = await list();
        const theirs = await list(otherOwner);
        expect(mine.body.map((x) => x.employeeId)).toEqual([crew.staff[0]]);
        expect(theirs.body.map((x) => x.employeeId)).toEqual([other.staff[0]]);
      },
    );

    maybeIt('employee: 403; no token: 401', async () => {
      expect((await list(tech())).status).toBe(403);
      expect((await list({})).status).toBe(401);
    });
  });

  // The list does NOT add queued-clear stand-ins (only the default GET does):
  // an override cleared with DELETE has no row to show, so it just drops out.
  maybeIt('a removed override drops out of the list', async () => {
    const [a] = crew.staff;
    await put(a, { days: [6] });
    await app.inject({ method: 'DELETE', url: url(a), headers: owner() });
    expect((await list()).body).toEqual([]);
  });
});
