import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { SupabaseClient } from '@supabase/supabase-js';
import { Pool } from 'pg';
import { bearerFor, bootApp } from './helpers/weekly-off-app';
import {
  IS_REAL_DB,
  requireRealDbWhenAsked,
  Crew,
  createCrew,
  must,
  openClients,
  overrideSpans,
  removeCrews,
  resetWeeklyOff,
  tenantToday,
} from './helpers/weekly-off-fixture';

/**
 * The bodiless-DELETE parser contract (src/common/allow-bodiless-delete.ts):
 * ONLY a zero-length DELETE body is treated as "no body". Anything else goes
 * to Fastify's own JSON parser, so whitespace-only bodies and malformed JSON
 * are 400 (parser, before the guards), a well-formed `{}` is just a body the
 * route ignores, and an empty body on POST/PUT/PATCH is still 400.
 */
jest.setTimeout(120_000);

describe('weekly-off routes: DELETE body handling (real DB)', () => {
  requireRealDbWhenAsked();
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let pool: Pool;
  let admin: SupabaseClient;
  let crew: Crew;
  let T: string;

  const owner = () => bearerFor(jwt, crew, crew.owner);
  const tech = () => bearerFor(jwt, crew, crew.staff[0]);
  const JSON_CT = { 'content-type': 'application/json' };
  const emp = () => crew.staff[0];
  const url = () => `/api/v1/attendance/weekly-offs/overrides/${emp()}`;

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    ({ pool, admin } = openClients());
    try {
      crew = await createCrew(admin, 1);
      ({ app, jwt } = await bootApp());
    } catch (err) {
      await removeCrews(admin, [crew]).catch(() => undefined);
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
        await removeCrews(admin, [crew]);
      } finally {
        await pool?.end();
      }
    }
  });

  beforeEach(async () => {
    if (!IS_REAL_DB) return;
    T = await tenantToday(pool, crew.tenant);
    await resetWeeklyOff(admin, [crew], true);
    must(
      await admin.rpc('attendance_set_weekly_off_override', {
        p_tenant_id: crew.tenant,
        p_employee_id: emp(),
        p_days: [6],
        p_effective_from: T,
      }),
    );
  });

  const del = (headers: Record<string, string>, payload?: string) =>
    app.inject({ method: 'DELETE', url: url(), headers, payload });

  maybeIt(
    'empty body + json content-type: company admin 200, row removed',
    async () => {
      const r = await del({ ...owner(), ...JSON_CT }, '');
      expect(r.statusCode).toBe(200);
      expect(await overrideSpans(pool, emp(), T)).toEqual([]);
    },
  );

  maybeIt(
    'empty body + json content-type: employee 403, row kept',
    async () => {
      const r = await del({ ...tech(), ...JSON_CT }, '');
      expect(r.statusCode).toBe(403);
      expect(await overrideSpans(pool, emp(), T)).toEqual([[0, null, [6]]]);
    },
  );

  maybeIt('"{}" body: parsed, ignored by the route, company admin 200', async () => {
    const r = await del({ ...owner(), ...JSON_CT }, '{}');
    expect(r.statusCode).toBe(200);
    expect(await overrideSpans(pool, emp(), T)).toEqual([]);
  });

  maybeIt('"{}" body: employee still 403', async () => {
    const r = await del({ ...tech(), ...JSON_CT }, '{}');
    expect(r.statusCode).toBe(403);
    expect(await overrideSpans(pool, emp(), T)).toEqual([[0, null, [6]]]);
  });

  for (const [name, body] of [
    ['whitespace-only "   "', '   '],
    ['newline-only', '\n'],
    ['invalid JSON "{bad"', '{bad'],
    ['truncated JSON', '{"effectiveFrom":'],
    ['bare word', 'nope'],
  ]) {
    maybeIt(
      `${name}: 400 from the parser, even for a company admin; row kept`,
      async () => {
        const r = await del({ ...owner(), ...JSON_CT }, body);
        expect(r.statusCode).toBe(400);
        expect(await overrideSpans(pool, emp(), T)).toEqual([[0, null, [6]]]);
      },
    );
  }

  maybeIt(
    'invalid JSON from an employee is 400 (parser runs before guards)',
    async () => {
      const r = await del({ ...tech(), ...JSON_CT }, '{bad');
      expect(r.statusCode).toBe(400);
    },
  );

  maybeIt('no content-type and no body: company admin 200', async () => {
    const r = await del(owner());
    expect(r.statusCode).toBe(200);
  });

  describe('non-DELETE: an empty or whitespace JSON body is still 400', () => {
    for (const body of ['', '   ']) {
      maybeIt(`PUT /weekly-offs with ${JSON.stringify(body)}`, async () => {
        const r = await app.inject({
          method: 'PUT',
          url: '/api/v1/attendance/weekly-offs',
          headers: { ...owner(), ...JSON_CT },
          payload: body,
        });
        expect(r.statusCode).toBe(400);
        expect(await overrideSpans(pool, emp(), T)).toEqual([[0, null, [6]]]);
      });

      maybeIt(`PUT override with ${JSON.stringify(body)}`, async () => {
        const r = await app.inject({
          method: 'PUT',
          url: url(),
          headers: { ...owner(), ...JSON_CT },
          payload: body,
        });
        expect(r.statusCode).toBe(400);
        expect(await overrideSpans(pool, emp(), T)).toEqual([[0, null, [6]]]);
      });
    }
  });
});
