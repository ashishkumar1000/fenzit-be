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
  defaultSpans,
  must,
  openClients,
  overrideSpans,
  removeCrews,
  resetWeeklyOff,
  tenantToday,
} from './helpers/weekly-off-fixture';

/**
 * Override DELETE (bodiless parser, 403/404/400, row effects) and malformed
 * PUT /attendance/weekly-offs input — real guards, real DB, throwaway tenants.
 * The global ValidationPipe answers 422 (docs/api-contracts.md).
 */
jest.setTimeout(120_000);

describe('weekly-off routes: override DELETE and bad input (real DB)', () => {
  requireRealDbWhenAsked();
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let pool: Pool;
  let admin: SupabaseClient;
  let crew: Crew;
  let other: Crew;
  let T: string;

  const owner = () => bearerFor(jwt, crew, crew.owner, 'owner');
  const tech = () => bearerFor(jwt, crew, crew.staff[0], 'technician');
  const JSON_CT = { 'content-type': 'application/json' };
  const url = (emp: string) =>
    `/api/v1/attendance/weekly-offs/overrides/${emp}`;

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    ({ pool, admin } = openClients());
    crew = await createCrew(admin, 2);
    other = await createCrew(admin, 0);
    ({ app, jwt } = await bootApp());
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
  });

  const seedOverride = async (emp: string, days: number[]) =>
    must(
      await admin.rpc('attendance_set_weekly_off_override', {
        p_tenant_id: crew.tenant,
        p_employee_id: emp,
        p_days: days,
        p_effective_from: T,
      }),
    );
  const del = (headers: Record<string, string>, emp = crew.staff[0]) =>
    app.inject({
      method: 'DELETE',
      url: url(emp),
      headers: { ...headers, ...JSON_CT },
    });

  describe('bodiless DELETE of an override', () => {
    maybeIt('technician: 403 (guard) — not a 400 parser error', async () => {
      const r = await del(tech());
      expect(r.statusCode).toBe(403);
    });

    maybeIt('technician without a content-type: 403', async () => {
      const r = await app.inject({
        method: 'DELETE',
        url: url(crew.staff[0]),
        headers: tech(),
      });
      expect(r.statusCode).toBe(403);
    });

    maybeIt('owner: nothing to remove is an idempotent 200', async () => {
      const r = await del(owner());
      expect(r.statusCode).toBe(200);
    });

    maybeIt(
      'owner: removes that employee override only; a colleague is untouched',
      async () => {
        const [a, b] = crew.staff;
        await seedOverride(a, [6]);
        await seedOverride(b, [7]);
        expect(await overrideSpans(pool, a, T)).toEqual([[0, null, [6]]]);
        const r = await del(owner(), a);
        expect(r.statusCode).toBe(200);
        expect(await overrideSpans(pool, a, T)).toEqual([]);
        expect(await overrideSpans(pool, b, T)).toEqual([[0, null, [7]]]);
      },
    );

    maybeIt(
      'cross-tenant: another tenant owner gets 404 and the row is intact',
      async () => {
        await seedOverride(crew.staff[0], [6]);
        const r = await del(
          bearerFor(jwt, other, other.owner, 'owner'),
          crew.staff[0],
        );
        expect(r.statusCode).toBe(404);
        expect(await overrideSpans(pool, crew.staff[0], T)).toEqual([
          [0, null, [6]],
        ]);
      },
    );

    maybeIt('owner: a malformed employee id is 400, not a crash', async () => {
      const r = await del(owner(), 'not-a-uuid');
      expect(r.statusCode).toBe(400);
    });
  });

  describe('PUT /attendance/weekly-offs rejects malformed input', () => {
    const put = (payload: unknown) =>
      app.inject({
        method: 'PUT',
        url: '/api/v1/attendance/weekly-offs',
        headers: owner(),
        payload: payload as Record<string, unknown>,
      });
    const bad: [string, unknown][] = [
      ['day 8', { days: [8] }],
      ['day 0', { days: [0] }],
      ['negative day', { days: [-1] }],
      ['fractional day', { days: [1.5] }],
      ['days is a string', { days: '1,2' }],
      ['days is a number', { days: 7 }],
      ['days is null', { days: null }],
      ['days missing', {}],
      ['8 entries', { days: [1, 1, 1, 1, 1, 1, 1, 1] }],
      ['duplicate days', { days: [1, 1] }],
      ['effectiveFrom abc', { days: [7], effectiveFrom: 'abc' }],
      ['effectiveFrom 2026-02-30', { days: [7], effectiveFrom: '2026-02-30' }],
    ];

    for (const [name, payload] of bad) {
      maybeIt(`${name}: 422 and nothing is written`, async () => {
        const r = await put(payload);
        expect(r.statusCode).toBe(422);
        expect(await defaultSpans(pool, crew.tenant, T)).toEqual([]);
      });
    }
  });
});
