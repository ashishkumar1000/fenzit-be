import { ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../src/common/validation-pipe-options';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { SupabaseClientFactory } from '../src/common/factories/supabase-client.factory';
import { PgPoolFactory } from '../src/common/pg/pg-pool.factory';
import { encodeCursor } from '../src/common/utils/cursor.util';

/**
 * HTTP boundary for the 18-2 corrections routes: PUT/DELETE
 * /attendance/corrections/:employeeId/:workDate, GET /attendance/corrections
 * (owner), GET /attendance/me/corrections (technician) and POST
 * /attendance/attempts/acknowledge. Pins the D4 gate order, the write
 * shape (upsert + ONE audit row per change, nothing on a failed gate),
 * the removal/ack idempotency and the cursor scopes — with the DB mocked
 * at the pg pool (the real-DB semantics live in the integration spec).
 */

type RpcResult = { data: unknown; error: Record<string, unknown> | null };
type SqlResult = { rows: unknown[]; rowCount?: number };

const TENANT_ID = 'f2e0a5c7-1b9d-4c8e-a0f3-0000000000f0';
const EMPLOYEE_ID = 'f2e0a5c7-1b9d-4c8e-a0f3-0000000000f1';
const TODAY = '2026-09-29'; // Tuesday; 09-28 is a tracked, record-backed past day

const settingsGateRow = { enabled: true, setup_completed_at: '2026-09-01T00:00:00+00:00' };
const enrolmentRow = {
  employee_id: EMPLOYEE_ID,
  valid: '[2026-09-01,)',
  enabled_at: '2026-09-15T04:00:00+00:00',
};
const assignmentRow = {
  employee_id: EMPLOYEE_ID,
  office_id: 'office-uuid-e2e',
  valid: '[2026-09-01,)',
  office_name: 'Andheri West',
  office_lat: 19.1364,
  office_lng: 72.8296,
  radius_m: 100,
};
const ruleRow = {
  id: 'rule-uuid-e2e',
  office_id: 'office-uuid-e2e',
  valid: '[2026-01-01,)',
  start_time: '09:30:00',
  end_time: '18:30:00',
  late_cutoff_minutes: 15,
  // G2-D1: the hours columns are the grading thresholds (window minutes only
  // drive the late/early metrics).
  full_day_hours: 8,
  half_day_hours: 4,
};
const presentRecordRow = {
  employee_id: EMPLOYEE_ID,
  work_date: '2026-09-28',
  checkin_at: '2026-09-28 09:25:00+05:30',
  checkout_at: '2026-09-28 18:10:00+05:30',
};
const activeOverrideRow = {
  employee_id: EMPLOYEE_ID,
  work_date: '2026-09-28',
  status: 'present',
  manual_checkin_at: null,
  manual_checkout_at: null,
};
// DB now sits between the two instants the instants-gates test uses.
const DB_NOW = new Date('2026-09-29T06:30:00+00:00'); // 12:00 IST

describe('Corrections HTTP boundary (e2e, 18-2)', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;

  const tableQueues = new Map<string, RpcResult[]>();
  let txFacts: ((sql: string) => SqlResult) | null = null;
  let writeCalls: string[] = [];

  function qbFor(table: string) {
    const queue = tableQueues.get(table);
    if (!queue) throw new Error(`unexpected table ${table}`);
    const qb: Record<string, unknown> = {};
    for (const m of [
      'select', 'eq', 'is', 'order', 'in', 'update', 'upsert', 'maybeSingle', 'single',
    ]) {
      qb[m] = jest.fn().mockReturnValue(qb);
    }
    (qb as unknown as { then: unknown }).then = jest.fn(
      (resolve: (v: RpcResult) => unknown) =>
        Promise.resolve(resolve(queue.shift() ?? { data: null, error: null })),
    );
    return qb;
  }

  function resetQueues() {
    tableQueues.clear();
    txFacts = null;
    writeCalls = [];
  }

  /** The happy-path day facts: present record on 09-28, nothing on 09-29. */
  function baseFacts(sql: string): SqlResult {
    if (sql.includes('attendance_today')) return { rows: [{ today: TODAY }] };
    if (sql.includes('from public.tenants where')) return { rows: [{ timezone: 'Asia/Kolkata' }] };
    if (sql.includes('from public.attendance_settings')) return { rows: [settingsGateRow] };
    if (sql.includes('from public.attendance_enrolments')) return { rows: [enrolmentRow] };
    if (sql.includes('from public.attendance_office_assignments')) return { rows: [assignmentRow] };
    if (sql.includes('from public.attendance_weekly_off_overrides')) return { rows: [] };
    if (sql.includes('from public.attendance_weekly_off_defaults'))
      return { rows: [{ valid: '[2026-01-01,)', days: [] }] };
    if (sql.includes('from public.holidays')) return { rows: [] };
    if (sql.includes('from public.attendance_office_rules')) return { rows: [ruleRow] };
    if (sql.includes('from public.attendance_records')) return { rows: [presentRecordRow] };
    if (sql.includes('from public.attendance_attempts')) return { rows: [] };
    if (sql.includes('from public.leave_request_days')) return { rows: [] };
    if (sql.includes('from public.attendance_day_overrides')) return { rows: [] };
    if (sql.includes('distinct on')) return { rows: [] };
    if (sql.startsWith('select count(*)::text as n from public.users'))
      return { rows: [{ n: '1' }] };
    return { rows: [] };
  }

  /** Statement dispatcher — write shapes + the db clock are host-level;
   *  per-test overrides (txFacts) answer the grid/history reads. */
  function dispatch(sql: string): SqlResult {
    if (sql.startsWith('insert into') || sql.startsWith('update ')) {
      writeCalls.push(sql);
    }
    if (sql.includes('attendance_lock_employee')) return { rows: [] };
    if (sql.startsWith('select now()')) return { rows: [{ now: DB_NOW }] };
    if (sql.startsWith('insert into public.attendance_corrections'))
      return {
        rows: [{ id: 'audit-uuid-e2e', created_at: '2026-09-29T05:30:00+00:00' }],
      }; // the PUT response's correctedAt rides this row
    if (sql.startsWith('update public.attendance_day_overrides'))
      return { rows: [], rowCount: 1 }; // the soft delete removed the row
    if (sql.startsWith('update public.attendance_attempts'))
      return txFacts?.(sql) ?? { rows: [], rowCount: 0 };
    if (sql.startsWith('insert into')) return { rows: [] }; // the override upsert
    return (txFacts ?? baseFacts)(sql);
  }

  function pgTxOverride() {
    return {
      withTransaction: (work: (client: unknown) => Promise<unknown>) =>
        work({
          // The real pg client's query() IS a promise — chainable via .then —
          // so the fake must resolve, not return a bare result object.
          query: (sql: string) => Promise.resolve(dispatch(sql)),
        }),
      onModuleDestroy: async () => undefined,
    };
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseClientFactory)
      .useValue({
        create: jest.fn(),
        createAdmin: jest.fn().mockImplementation(() => ({
          from: jest.fn((table: string) => qbFor(table)),
          rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
        })),
      })
      .overrideProvider(PgPoolFactory)
      .useValue(pgTxOverride())
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api/v1', { exclude: ['internal/webhooks/storage'] });
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    jwtService = moduleFixture.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(resetQueues);

  function ownerJwt() {
    return jwtService.sign({
      sub: 'owner-uuid-e2e',
      tenantId: TENANT_ID,
      role: 'owner',
    });
  }

  function techJwt() {
    return jwtService.sign({
      sub: EMPLOYEE_ID,
      tenantId: TENANT_ID,
      role: 'technician',
    });
  }

  const putUrl = (workDate = '2026-09-28', employeeId = EMPLOYEE_ID) =>
    `/api/v1/attendance/corrections/${employeeId}/${workDate}`;

  describe('PUT /attendance/corrections/:employeeId/:workDate (owner)', () => {
    it('200 — status arm replaces the record state, one upsert + one audit row', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: putUrl(),
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { status: 'absent', note: 'sick leave missed as absent' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        workDate: '2026-09-28',
        override: { status: 'absent', checkinAt: null, checkoutAt: null },
        actorId: 'owner-uuid-e2e',
      });
      expect(typeof body.correctedAt).toBe('string');
      // G2-P9: the audit row's UTC stamp re-anchored to the tenant offset
      // (05:30Z is 11:00 IST).
      expect(body.correctedAt).toBe('2026-09-29T11:00:00+05:30');
      expect(writeCalls).toHaveLength(2); // upsert + audit insert, never records
      expect(writeCalls.join(' ')).toContain('attendance_day_overrides');
      expect(writeCalls.join(' ')).toContain('attendance_corrections');
      expect(writeCalls.join(' ')).not.toContain('attendance_records');
    });

    it('422 VALIDATION_ERROR — a checkout alone is not a correction (the test was wrong about the requirement, fixed per D4): the times arm is { checkinAt, checkoutAt? }, and a lone checkout would write an instant the engine cannot see', async () => {
      // NOTE (code review 2026-09-29): this was asserted 200 before; D4's
      // letter pins the times arm to the check-in — rules 2-10 grade from
      // the check-in, so a checkout without one must never reach the row.
      const res = await app.inject({
        method: 'PUT',
        url: putUrl(),
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { checkoutAt: '2026-09-28T19:00:00+05:30', note: 'forgot to check out' },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
      expect(writeCalls).toHaveLength(0);
    });

    it('200 — the times arm anchors the work date, instants travel as tenant-offset ISO (checkout with the check-in kept by the record)', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: putUrl(),
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { checkinAt: '2026-09-28T09:25:00+05:30', checkoutAt: '2026-09-28T19:00:00+05:30', note: 'forgot to check out' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).override).toEqual({
        status: null,
        checkinAt: '2026-09-28T09:25:00+05:30',
        checkoutAt: '2026-09-28T19:00:00+05:30',
      });
      expect(writeCalls).toHaveLength(2);
    });

    it('422 ATTENDANCE_FUTURE_DATE — the date window gate runs before the arms gate (review G2-P14: an arms-invalid body on a future date still reports the date first)', async () => {
      // The body deliberately carries NEITHER arm — if the arms gate ran
      // first, VALIDATION_ERROR would leak before the date window check.
      const res = await app.inject({
        method: 'PUT',
        url: putUrl('2026-10-01'),
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { note: 'future' },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('ATTENDANCE_FUTURE_DATE');
      expect(writeCalls).toHaveLength(0);
    });

    it('422 ATTENDANCE_DATE_NOT_TRACKED for a pre-enrolment date', async () => {
      txFacts = (sql) =>
        sql.includes('from public.attendance_enrolments')
          ? { rows: [] } // enrolment starts later — 09-28 is not tracked
          : baseFacts(sql);

      const res = await app.inject({
        method: 'PUT',
        url: putUrl(),
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { status: 'present', note: 'x' },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('ATTENDANCE_DATE_NOT_TRACKED');
      expect(writeCalls).toHaveLength(0);
    });

    it('422 VALIDATION_ERROR for mixed arms (status XOR times)', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: putUrl(),
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { status: 'present', checkinAt: '2026-09-28T09:40:00+05:30', note: 'x' },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
      expect(writeCalls).toHaveLength(0);
    });

    it('422 VALIDATION_ERROR for a 501-char note, a control-char note and an empty note', async () => {
      for (const note of ['x'.repeat(501), 'bad\u0007note', '   ']) {
        const res = await app.inject({
          method: 'PUT',
          url: putUrl(),
          headers: { authorization: `Bearer ${ownerJwt()}` },
          payload: { status: 'absent', note },
        });
        expect(res.statusCode).toBe(422);
        expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
      }
      expect(writeCalls).toHaveLength(0); // failed gates never write audit
    });

    it('422 VALIDATION_ERROR with neither arm, and the note is trimmed before its length gate (G2-P13)', async () => {
      const neither = await app.inject({
        method: 'PUT',
        url: putUrl(),
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { note: 'no arm at all' },
      });
      expect(neither.statusCode).toBe(422);
      expect(JSON.parse(neither.body).error_code).toBe('VALIDATION_ERROR');
      expect(writeCalls).toHaveLength(0);

      // Exactly 500 chars after trimming → 200 — and a 501-char note whose
      // trailing whitespace trims away proves the TRIM runs before the
      // length gate (raw > 500, trimmed == 500).
      const boundary = await app.inject({
        method: 'PUT',
        url: putUrl(),
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { status: 'absent', note: 'x'.repeat(500) },
      });
      expect(boundary.statusCode).toBe(200);

      const trimmed = await app.inject({
        method: 'PUT',
        url: putUrl(),
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { status: 'absent', note: 'x'.repeat(500) + '   ' },
      });
      expect(trimmed.statusCode).toBe(200);
    });

    it('422 ATTENDANCE_INVALID_RANGE when checkinAt anchors another date', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: putUrl(),
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { checkinAt: '2026-09-27T18:00:00+05:30', note: 'x' },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('ATTENDANCE_INVALID_RANGE');
      expect(writeCalls).toHaveLength(0);
    });

    it('422 ATTENDANCE_INVALID_RANGE when checkinAt is in the future (dbNow check)', async () => {
      // 17:30 IST is after DB now (12:00 IST) even though it is today.
      const res = await app.inject({
        method: 'PUT',
        url: putUrl('2026-09-29'),
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { checkinAt: '2026-09-29T17:30:00+05:30', note: 'x' },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('ATTENDANCE_INVALID_RANGE');
      expect(writeCalls).toHaveLength(0);
    });

    it('422 ATTENDANCE_INVALID_RANGE when checkoutAt (next-day edge) is in the future (dbNow check)', async () => {
      // The next-day checkout anchor is legal, but 19:30 IST tonight is
      // past DB now (12:00 IST) — the same wall applies to both instants.
      const res = await app.inject({
        method: 'PUT',
        url: putUrl(),
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: {
          checkinAt: '2026-09-28T09:25:00+05:30',
          checkoutAt: '2026-09-29T19:30:00+05:30',
          note: 'x',
        },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('ATTENDANCE_INVALID_RANGE');
      expect(writeCalls).toHaveLength(0);
    });

    it('404 ATTENDANCE_EMPLOYEE_NOT_FOUND for an unknown employee (no existence leak)', async () => {
      txFacts = (sql) =>
        sql.startsWith('select count(*)::text as n from public.users')
          ? { rows: [{ n: '0' }] }
          : baseFacts(sql);

      const res = await app.inject({
        method: 'PUT',
        url: putUrl('2026-09-28', '9f0e4e5a-0000-4000-8000-0000000000aa'),
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { status: 'absent', note: 'x' },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error_code).toBe(
        'ATTENDANCE_EMPLOYEE_NOT_FOUND',
      );
      expect(writeCalls).toHaveLength(0);
    });

    it('422 for a malformed employeeId, 422 for a bad workDate — both pre-DB, same code (G2-P8)', async () => {
      const malformed = await app.inject({
        method: 'PUT',
        url: putUrl('2026-09-28', 'not-a-uuid'),
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { status: 'absent', note: 'x' },
      });
      // The service-level shape gate answers the house 422, not the
      // ParseUUIDPipe's raw 400 (the param-level pipe is gone).
      expect(malformed.statusCode).toBe(422);
      expect(JSON.parse(malformed.body).error_code).toBe('VALIDATION_ERROR');

      const badDate = await app.inject({
        method: 'PUT',
        url: putUrl('2026-13-01'),
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { status: 'absent', note: 'x' },
      });
      expect(badDate.statusCode).toBe(422);
      expect(JSON.parse(badDate.body).error_code).toBe('VALIDATION_ERROR');
      expect(writeCalls).toHaveLength(0);
    });

    it('403 on a technician JWT', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: putUrl(),
        headers: { authorization: `Bearer ${techJwt()}` },
        payload: { status: 'absent', note: 'x' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('DELETE /attendance/corrections/:employeeId/:workDate (owner)', () => {
    it('removes the active override ({ deleted: true }) with one audit row, then the retry is 200 false', async () => {
      txFacts = (sql) =>
        sql.includes('from public.attendance_day_overrides')
          ? { rows: [activeOverrideRow] }
          : baseFacts(sql);
      const first = await app.inject({
        method: 'DELETE',
        url: putUrl(),
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(first.statusCode).toBe(200);
      expect(JSON.parse(first.body)).toEqual({ deleted: true });
      expect(writeCalls).toHaveLength(2); // soft delete + audit insert, in that order
      expect(writeCalls[0]).toContain('update public.attendance_day_overrides');
      expect(writeCalls[1]).toContain('insert into public.attendance_corrections');

      txFacts = (sql) =>
        sql.includes('from public.attendance_day_overrides')
          ? { rows: [] } // the retry sees no active override
          : baseFacts(sql);
      writeCalls = [];
      const retry = await app.inject({
        method: 'DELETE',
        url: putUrl(),
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(retry.statusCode).toBe(200);
      expect(JSON.parse(retry.body)).toEqual({ deleted: false });
      expect(writeCalls).toHaveLength(0); // an own removal retry is free
    });

    it('422 ATTENDANCE_DATE_NOT_TRACKED on a pre-enrolment date (nothing to remove)', async () => {
      txFacts = (sql) =>
        sql.includes('from public.attendance_enrolments') ? { rows: [] } : baseFacts(sql);

      const res = await app.inject({
        method: 'DELETE',
        url: putUrl(),
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('ATTENDANCE_DATE_NOT_TRACKED');
    });

    it('422 for a bad workDate shape, pre-DB', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: putUrl('not-a-date'),
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('404 for an unknown employee', async () => {
      txFacts = (sql) =>
        sql.startsWith('select count(*)::text as n from public.users')
          ? { rows: [{ n: '0' }] }
          : baseFacts(sql);
      const res = await app.inject({
        method: 'DELETE',
        url: putUrl(),
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error_code).toBe(
        'ATTENDANCE_EMPLOYEE_NOT_FOUND',
      );
    });

    it('403 on a technician JWT', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: putUrl(),
        headers: { authorization: `Bearer ${techJwt()}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /attendance/corrections (owner history)', () => {
    const historyRow = {
      id: '11111111-1111-4111-8111-111111111111',
      employee_id: EMPLOYEE_ID,
      work_date: '2026-09-28',
      created_at: '2026-09-29T05:00:00+00:00',
      note: 'sick leave missed as absent',
      old_value: { status: 'present', checkinAt: '2026-09-28T09:25:00+05:30', checkoutAt: '2026-09-28T18:10:00+05:30' },
      new_value: { status: 'absent', checkinAt: null, checkoutAt: null },
      actor_name: 'Priya Owner',
    };

    it('200 — one camelCase page, hasMore + nextCursor beyond the page size', async () => {
      const page = [historyRow, { ...historyRow, id: '22222222-2222-4222-8222-222222222222' }];
      const extra = { ...historyRow, id: '33333333-3333-4333-8333-333333333333' };
      txFacts = (sql) =>
        sql.includes('from public.attendance_corrections c') &&
        sql.includes('order by c.created_at desc')
          ? { rows: [...page, extra] } // limit+1 read proves the hasMore slice
          : baseFacts(sql);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/corrections?employeeId=${EMPLOYEE_ID}&limit=2`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.hasMore).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.data[0]).toEqual({
        id: '11111111-1111-4111-8111-111111111111',
        employeeId: EMPLOYEE_ID,
        workDate: '2026-09-28',
        // G2-P9: the audit instant travels as AD-7 tenant-offset ISO —
        // 05:00Z is 10:30 IST, the wall time the actor saw.
        correctedAt: '2026-09-29T10:30:00+05:30',
        actorName: 'Priya Owner',
        note: 'sick leave missed as absent',
        oldValue: { status: 'present', checkinAt: '2026-09-28T09:25:00+05:30', checkoutAt: '2026-09-28T18:10:00+05:30' },
        newValue: { status: 'absent', checkinAt: null, checkoutAt: null },
      });
      // The cursor is opaque but must decode back to the last row + scope.
      const decoded = JSON.parse(
        Buffer.from(body.nextCursor, 'base64url').toString('utf-8'),
      );
      expect(decoded).toMatchObject({
        id: '22222222-2222-4222-8222-222222222222',
        scope: 'day-corrections-owner',
      });
    });

    it('200 with null cursor on an empty history', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/corrections?employeeId=${EMPLOYEE_ID}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        data: [],
        nextCursor: null,
        hasMore: false,
      });
    });

    it('400 "Invalid cursor" for a foreign-scope cursor (replay across endpoints)', async () => {
      const foreign = encodeCursor('some-id', '2026-09-29T00:00:00.000Z', 'jobs-list');
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/corrections?employeeId=${EMPLOYEE_ID}&cursor=${foreign}`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toBe('Invalid cursor');
      expect(writeCalls).toHaveLength(0);
    });

    it('400 "Invalid cursor" for garbage cursors, and 422 for a missing/malformed employeeId (G2-P8)', async () => {
      const garbage = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/corrections?employeeId=${EMPLOYEE_ID}&cursor=zzz-not-a-cursor`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(garbage.statusCode).toBe(400);
      expect(JSON.parse(garbage.body).message).toBe('Invalid cursor');

      const missing = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/corrections',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      // The service-level shape gate answers the house 422 (a missing
      // employeeId fails assertEmployeeId the same way a malformed one does).
      expect(missing.statusCode).toBe(422);
      expect(JSON.parse(missing.body).error_code).toBe('VALIDATION_ERROR');

      const malformed = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/corrections?employeeId=not-a-uuid',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(malformed.statusCode).toBe(422);
      expect(JSON.parse(malformed.body).error_code).toBe('VALIDATION_ERROR');
    });

    it('404 ATTENDANCE_EMPLOYEE_NOT_FOUND for a foreign employee (D6 — no existence leak on the history read)', async () => {
      txFacts = (sql) =>
        sql.startsWith('select count(*)::text as n from public.users')
          ? { rows: [{ n: '0' }] } // outside this tenant's roster
          : baseFacts(sql);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/corrections?employeeId=9f0e4e5a-0000-4000-8000-0000000000aa`,
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error_code).toBe('ATTENDANCE_EMPLOYEE_NOT_FOUND');
    });

    it('403 on a technician JWT', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/corrections?employeeId=${EMPLOYEE_ID}`,
        headers: { authorization: `Bearer ${techJwt()}` },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error_code).toBe('FORBIDDEN');
    });
  });

  describe('GET /attendance/me/corrections (technician history)', () => {
    // The AD-17 gate runs first on the me scope — the access-state view
    // read is stubbed at the supabase edge, not the pg tx.
    const accessViewRow = {
      user_id: EMPLOYEE_ID,
      access_state: 'active',
    };
    const gateAccess = () =>
      tableQueues.set('attendance_access_state', [
        { data: accessViewRow, error: null },
      ]);

    it('200 — own entries without a cursor (nextCursor null on the last page)', async () => {
      const row = {
        id: '44444444-4444-4444-8444-444444444444',
        employee_id: EMPLOYEE_ID,
        work_date: '2026-09-28',
        created_at: '2026-09-29T05:00:00+00:00',
        note: 'sick leave missed as absent',
        old_value: { status: 'present', checkinAt: null, checkoutAt: null },
        new_value: { status: 'absent', checkinAt: null, checkoutAt: null },
        actor_name: 'Priya Owner',
      };
      gateAccess();
      txFacts = (sql) =>
        sql.includes('order by c.created_at desc') ? { rows: [row] } : baseFacts(sql);

      const first = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/me/corrections?limit=20',
        headers: { authorization: `Bearer ${techJwt()}` },
      });
      expect(first.statusCode).toBe(200);
      const body = JSON.parse(first.body);
      expect(body.hasMore).toBe(false);
      expect(body.nextCursor).toBe(null);
      expect(body.data[0]).toMatchObject({
        employeeId: EMPLOYEE_ID,
        actorName: 'Priya Owner',
        newValue: { status: 'absent' },
      });
    });

    it('200 — the optional workDate filter narrows the read to one date (G2-P12)', async () => {
      gateAccess();
      const row = {
        id: '55555555-5555-4555-8555-555555555555',
        employee_id: EMPLOYEE_ID,
        work_date: '2026-09-26',
        created_at: '2026-09-27T05:00:00+00:00',
        note: 'sick leave missed as absent',
        old_value: { status: 'present', checkinAt: null, checkoutAt: null },
        new_value: { status: 'absent', checkinAt: null, checkoutAt: null },
        actor_name: 'Priya Owner',
      };
      let sawDateFilter = false;
      txFacts = (sql) => {
        if (sql.includes('from public.attendance_corrections c')) {
          // The history statement must carry the single-date WHERE clause.
          sawDateFilter = sql.includes('c.work_date = $');
          return { rows: [row] };
        }
        return baseFacts(sql);
      };

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/me/corrections?workDate=2026-09-26',
        headers: { authorization: `Bearer ${techJwt()}` },
      });
      expect(res.statusCode).toBe(200);
      expect(sawDateFilter).toBe(true);
      const body = JSON.parse(res.body);
      expect(body.hasMore).toBe(false);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].workDate).toBe('2026-09-26');
    });

    it("200 — a minted cursor fetches page 2 with no overlap and hasMore false at the end (G2-P12, real cursor round-trip)", async () => {
      gateAccess();
      const row = (id: string, createdAt: string) => ({
        id,
        employee_id: EMPLOYEE_ID,
        work_date: '2026-09-28',
        created_at: createdAt,
        note: 'sick leave missed as absent',
        old_value: { status: 'present', checkinAt: null, checkoutAt: null },
        new_value: { status: 'absent', checkinAt: null, checkoutAt: null },
        actor_name: 'Priya Owner',
      });
      const first = row('66666666-6666-4666-8666-666666666666', '2026-09-29T05:00:00+00:00');
      const second = row('77777777-7777-4777-8777-777777777777', '2026-09-28T04:00:00+00:00');
      txFacts = (sql) => {
        if (sql.includes('from public.attendance_corrections c')) {
          // Page 2 is the cursor-armed statement (strictly-older row tuple).
          if (sql.includes('(c.created_at, c.id) <')) return { rows: [second] };
          return { rows: [first, second] }; // page 1: limit+1 proves hasMore
        }
        return baseFacts(sql);
      };

      const page1 = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/me/corrections?limit=1',
        headers: { authorization: `Bearer ${techJwt()}` },
      });
      expect(page1.statusCode).toBe(200);
      const p1 = JSON.parse(page1.body);
      expect(p1.hasMore).toBe(true);
      expect(p1.data).toHaveLength(1);
      expect(p1.nextCursor).toBeTruthy();

      // The AD-17 access gate runs once per request — page 2 needs its own
      // queued access row (review G2-P12).
      gateAccess();
      const page2 = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/me/corrections?limit=1&cursor=${p1.nextCursor}`,
        headers: { authorization: `Bearer ${techJwt()}` },
      });
      expect(page2.statusCode).toBe(200);
      const p2 = JSON.parse(page2.body);
      expect(p2.hasMore).toBe(false);
      expect(p2.nextCursor).toBe(null);
      // No overlap, no skip: page 2 holds exactly the older unseen row.
      expect(p2.data.map((r: { id: string }) => r.id)).toEqual([second.id]);
      expect(p2.data.map((r: { id: string }) => r.id)).not.toContain(first.id);
    });

    it('400 for a cursor minted on the owner scope (cross-scope replay)', async () => {
      gateAccess(); // the AD-17 gate precedes the cursor decode
      const ownerCursor = encodeCursor('id', '2026-09-29T00:00:00.000Z', 'day-corrections-owner');
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/attendance/me/corrections?cursor=${ownerCursor}`,
        headers: { authorization: `Bearer ${techJwt()}` },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toBe('Invalid cursor');
    });

    it('403 ATTENDANCE_NOT_TRACKED when the access state is none (AD-17)', async () => {
      tableQueues.set('attendance_access_state', [
        { data: { ...accessViewRow, access_state: 'none' }, error: null },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/me/corrections',
        headers: { authorization: `Bearer ${techJwt()}` },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error_code).toBe('ATTENDANCE_NOT_TRACKED');
    });

    it('403 on an owner JWT (technician-only surface)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/attendance/me/corrections',
        headers: { authorization: `Bearer ${ownerJwt()}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /attendance/attempts/acknowledge (D5)', () => {
    const ackUrl = '/api/v1/attendance/attempts/acknowledge';

    it('200 { acknowledgedCount } — 2 then 0 on the idempotent retry', async () => {
      txFacts = (sql) =>
        sql.startsWith('update public.attendance_attempts')
          ? { rows: [], rowCount: 2 }
          : baseFacts(sql);
      const first = await app.inject({
        method: 'POST',
        url: ackUrl,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { employeeId: EMPLOYEE_ID, workDate: '2026-09-28' },
      });
      expect(first.statusCode).toBe(200);
      expect(JSON.parse(first.body)).toEqual({ acknowledgedCount: 2 });

      txFacts = (sql) =>
        sql.startsWith('update public.attendance_attempts')
          ? { rows: [], rowCount: 0 }
          : baseFacts(sql);
      const retry = await app.inject({
        method: 'POST',
        url: ackUrl,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { employeeId: EMPLOYEE_ID, workDate: '2026-09-28' },
      });
      expect(retry.statusCode).toBe(200);
      expect(JSON.parse(retry.body)).toEqual({ acknowledgedCount: 0 });
    });

    it('404 for an unknown employee, 422 for a bad workDate — both pre-DB', async () => {
      txFacts = (sql) =>
        sql.startsWith('select count(*)::text as n from public.users')
          ? { rows: [{ n: '0' }] }
          : baseFacts(sql);
      const unknown = await app.inject({
        method: 'POST',
        url: ackUrl,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { employeeId: EMPLOYEE_ID, workDate: '2026-09-28' },
      });
      expect(unknown.statusCode).toBe(404);

      const badDate = await app.inject({
        method: 'POST',
        url: ackUrl,
        headers: { authorization: `Bearer ${ownerJwt()}` },
        payload: { employeeId: EMPLOYEE_ID, workDate: '2026-02-30' },
      });
      expect(badDate.statusCode).toBe(422);
      expect(JSON.parse(badDate.body).error_code).toBe('VALIDATION_ERROR');
      expect(writeCalls).toHaveLength(0);
    });

    it('403 on a technician JWT', async () => {
      const res = await app.inject({
        method: 'POST',
        url: ackUrl,
        headers: { authorization: `Bearer ${techJwt()}` },
        payload: { employeeId: EMPLOYEE_ID, workDate: '2026-09-28' },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
