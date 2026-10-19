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
  openClients,
  removeCrews,
  resetWeeklyOff,
  tenantToday,
} from './helpers/weekly-off-fixture';

/**
 * GET/PUT /attendance/weekly-offs (real guards, AppModule, real DB). Covers
 * R-11 `configured`, R-21 queued-clear stand-ins, technician 403 and
 * per-tenant isolation. DELETE and malformed input live in
 * weekly-off-routes-input.e2e-spec.ts.
 */
jest.setTimeout(120_000);

interface View {
  days: number[];
  validFrom: string;
  validTo: string | null;
}
interface DefaultBody {
  configured: boolean;
  default: View | null;
  next: View | null;
  history: View[];
}

describe('weekly-off routes (real DB, real routes)', () => {
  requireRealDbWhenAsked();
  const maybeIt = IS_REAL_DB ? it : it.skip;
  let app: NestFastifyApplication;
  let jwt: JwtService;
  let pool: Pool;
  let admin: SupabaseClient;
  let crew: Crew;
  let other: Crew;
  let T: string;
  const d = (n: number) => addDays(T, n);

  const owner = () => bearerFor(jwt, crew, crew.owner, 'owner');
  const tech = () => bearerFor(jwt, crew, crew.staff[0], 'technician');

  beforeAll(async () => {
    if (!IS_REAL_DB) return;
    ({ pool, admin } = openClients());
    crew = await createCrew(admin, 1);
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
    await resetWeeklyOff(admin, [crew, other]);
  });

  const get = async (headers = owner()) => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/attendance/weekly-offs',
      headers,
    });
    return { status: r.statusCode, body: JSON.parse(r.body) as DefaultBody };
  };
  const put = async (
    payload: Record<string, unknown>,
    headers: Record<string, string> = owner(),
  ) => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/v1/attendance/weekly-offs',
      headers,
      payload,
    });
    return {
      status: r.statusCode,
      body: JSON.parse(r.body) as DefaultBody & { error_code?: string },
    };
  };

  maybeIt(
    'never configured: configured=false, default null, nothing queued',
    async () => {
      const r = await get();
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        configured: false,
        default: null,
        next: null,
        history: [],
      });
    },
  );

  maybeIt(
    'configured flips false -> true after saving "no day off" (empty days)',
    async () => {
      const saved = await put({ days: [] });
      expect(saved.status).toBe(200);
      expect(saved.body.configured).toBe(true);
      const r = await get();
      expect(r.body.configured).toBe(true);
      expect(r.body.default).toBeNull();
      expect(r.body.history).toEqual([]);
    },
  );

  maybeIt('configured stays true after later saves', async () => {
    await put({ days: [] });
    await put({ days: [7] });
    expect((await get()).body.configured).toBe(true);
  });

  maybeIt(
    'a rejected 7-day save keeps configured=false and answers 422',
    async () => {
      const r = await put({ days: [1, 2, 3, 4, 5, 6, 7] });
      expect(r.status).toBe(422);
      expect(r.body.error_code).toBe('ATTENDANCE_NO_WORKING_DAYS');
      expect((await get()).body.configured).toBe(false);
    },
  );

  maybeIt(
    'queued clear shows as a stand-in in next and history; default is unaffected',
    async () => {
      await put({ days: [6], effectiveFrom: d(0) });
      await put({ days: [], effectiveFrom: d(5) });
      const { body } = await get();
      expect(body.default).toEqual({
        days: [6],
        validFrom: d(0),
        validTo: d(5),
      });
      expect(body.next).toEqual({ days: [], validFrom: d(5), validTo: null });
      expect(body.history).toEqual([
        { days: [6], validFrom: d(0), validTo: d(5) },
        { days: [], validFrom: d(5), validTo: null },
      ]);
    },
  );

  maybeIt(
    'a queued clear moved later shows the new date, with one stand-in only',
    async () => {
      await put({ days: [6], effectiveFrom: d(0) });
      await put({ days: [], effectiveFrom: d(5) });
      await put({ days: [], effectiveFrom: d(9) });
      const { body } = await get();
      expect(body.next).toEqual({ days: [], validFrom: d(9), validTo: null });
      expect(body.history).toHaveLength(2);
      expect(body.default?.validTo).toBe(d(9));
    },
  );

  maybeIt('a queued rule moved later (R-20) shows once in next', async () => {
    await put({ days: [6], effectiveFrom: d(0) });
    await put({ days: [7], effectiveFrom: d(5) });
    await put({ days: [7], effectiveFrom: d(9) });
    const { body } = await get();
    expect(body.next).toEqual({ days: [7], validFrom: d(9), validTo: null });
    expect(body.history.map((h) => h.validFrom)).toEqual([d(0), d(9)]);
  });

  maybeIt('no queued clear is invented when nothing was clipped', async () => {
    await put({ days: [6], effectiveFrom: d(0) });
    const { body } = await get();
    expect(body.next).toBeNull();
    expect(body.history).toHaveLength(1);
  });

  maybeIt(
    'tenant isolation: another tenant owner never sees this tenant rules',
    async () => {
      await put({ days: [6], effectiveFrom: d(0) });
      const r = await get(bearerFor(jwt, other, other.owner, 'owner'));
      expect(r.body).toEqual({
        configured: false,
        default: null,
        next: null,
        history: [],
      });
    },
  );

  maybeIt(
    'technician gets 403 on GET and PUT; no token gets 401; nothing is written',
    async () => {
      expect((await get(tech())).status).toBe(403);
      expect((await put({ days: [7] }, tech())).status).toBe(403);
      const anon = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/weekly-offs',
      });
      expect(anon.statusCode).toBe(401);
      expect((await get()).body.configured).toBe(false);
    },
  );
});
